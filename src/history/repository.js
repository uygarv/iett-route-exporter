import { createDatabase } from "../db/database.js";
import { AppError } from "../shared/errors.js";
import { normalizeArchiveRecord } from "./records.js";
import { errorDiagnostics } from "../shared/error-diagnostics.js";

const UPSERT = `INSERT INTO iett_history_trips (
  record_date, source_id, archive_task_id, task_id, line_code, route_code,
  vehicle_door_number, task_status, started_at, ended_at, planned_started_at,
  adjusted_started_at, extra_fields
) SELECT record_date, source_id, archive_task_id, task_id, line_code, route_code,
  vehicle_door_number, task_status, started_at, ended_at, planned_started_at,
  adjusted_started_at, extra_fields
FROM jsonb_to_recordset($1::jsonb) AS r(
  record_date date, source_id bigint, archive_task_id bigint, task_id bigint,
  line_code text, route_code text, vehicle_door_number text, task_status text,
  started_at timestamptz, ended_at timestamptz, planned_started_at timestamptz,
  adjusted_started_at timestamptz, extra_fields jsonb
) ON CONFLICT (record_date, source_id) DO UPDATE SET
  archive_task_id = EXCLUDED.archive_task_id, task_id = EXCLUDED.task_id,
  line_code = EXCLUDED.line_code, route_code = EXCLUDED.route_code,
  vehicle_door_number = EXCLUDED.vehicle_door_number, task_status = EXCLUDED.task_status,
  started_at = EXCLUDED.started_at, ended_at = EXCLUDED.ended_at,
  planned_started_at = EXCLUDED.planned_started_at, adjusted_started_at = EXCLUDED.adjusted_started_at,
  extra_fields = EXCLUDED.extra_fields, fetched_at = now()`;

export class HistoryRepository {
  constructor(database = createDatabase()) { this.database = database; }

  async withIngestionLock(run) {
    const client = await this.database.connect();
    const disconnected = new AbortController();
    const onError = error => disconnected.abort(error);
    client.on("error", onError);
    let locked = false;
    try {
      locked = (await client.query("SELECT pg_try_advisory_lock(182885, 1) AS locked")).rows[0].locked;
      if (!locked) return { locked: false };
      await client.query("UPDATE iett_history_import_days SET status = 'pending' WHERE status = 'running'");
      return { locked: true, result: await run(new HistoryRepository(client), disconnected.signal) };
    } finally {
      try { if (locked && !disconnected.signal.aborted) await client.query("SELECT pg_advisory_unlock(182885, 1)"); }
      finally {
        client.removeListener("error", onError);
        client.release(disconnected.signal.aborted);
      }
    }
  }

  async bounds() {
    return (await this.database.query(`SELECT min(record_date)::text AS first_date,
      max(record_date)::text AS last_date FROM iett_history_import_days`)).rows[0];
  }

  async enqueueRange(from, to, { force = false, refreshSince, refreshDate } = {}) {
    await this.database.query(`INSERT INTO iett_history_import_days(record_date)
      SELECT day::date FROM generate_series($1::date, $2::date, interval '1 day') AS day
      ON CONFLICT DO NOTHING`, [from, to]);
    if (force) {
      await this.database.query(`UPDATE iett_history_import_days SET status = 'pending', next_attempt_at = now()
        WHERE record_date BETWEEN $1::date AND $2::date`, [from, to]);
    }
    if (refreshSince) {
      await this.database.query(`UPDATE iett_history_import_days SET status = 'pending', next_attempt_at = now(),
        refresh_requested_on = $3::date WHERE record_date BETWEEN $1::date AND $2::date
        AND refresh_requested_on IS DISTINCT FROM $3::date`, [refreshSince, to, refreshDate]);
    }
  }
  async requestRange(from, to, { force = false } = {}) {
    const result = await this.database.query(`INSERT INTO iett_history_import_days AS d(record_date)
      SELECT day::date FROM generate_series($1::date, $2::date, interval '1 day') AS day
      ON CONFLICT (record_date) DO UPDATE SET
        status = CASE WHEN d.status = 'running' THEN 'running' ELSE 'pending' END,
        next_attempt_at = now(), request_version = d.request_version + 1
      WHERE $3::boolean OR d.status NOT IN ('success', 'running') RETURNING record_date`, [from, to, force]);
    return { queued: result.rowCount };
  }

  async requeueProxyFailures() {
    await this.database.query(`UPDATE iett_history_import_days SET status = 'pending', next_attempt_at = now()
      WHERE status = 'failed' AND last_error_details->>'phase' = 'proxy_probe'`);
  }

  async claimNextDay(from, to, { retryNow = false, exclude = [] } = {}) {
    const result = await this.database.query(`UPDATE iett_history_import_days d SET status = 'running',
      attempt_count = attempt_count + 1, started_at = now(), last_attempt_at = now()
      WHERE record_date = (SELECT record_date FROM iett_history_import_days
        WHERE record_date BETWEEN $1::date AND $2::date AND status NOT IN ('success', 'running')
        AND ($3::boolean OR next_attempt_at <= now()) AND NOT (record_date = ANY($4::date[]))
        ORDER BY record_date LIMIT 1 FOR UPDATE)
      RETURNING record_date::text AS date, request_version AS version, attempt_count AS attempt`,
    [from, to, retryNow, exclude]);
    return result.rows[0];
  }

  async dueDates(from, to, { retryNow = false } = {}) {
    const result = await this.database.query(`SELECT record_date::text AS date FROM iett_history_import_days
      WHERE record_date BETWEEN $1::date AND $2::date AND status <> 'success'
      AND ($3::boolean OR next_attempt_at <= now()) ORDER BY record_date`, [from, to, retryNow]);
    return result.rows.map(row => row.date);
  }

  async nextRetryAt() {
    const result = await this.database.query(`SELECT min(next_attempt_at) AS next_attempt_at
      FROM iett_history_import_days WHERE status <> 'success'
      AND record_date < (now() AT TIME ZONE 'Europe/Istanbul')::date`);
    return result.rows[0].next_attempt_at;
  }

  async markRunning(date) {
    await this.database.query(`UPDATE iett_history_import_days SET status = 'running', attempt_count = attempt_count + 1,
      started_at = now(), last_attempt_at = now() WHERE record_date = $1::date`, [date]);
  }

  async markFailure(date, error, status = "failed", version) {
    const diagnostic = errorDiagnostics(error);
    await this.database.query(`UPDATE iett_history_import_days SET
      status = CASE WHEN request_version > coalesce($5::bigint, request_version) THEN 'pending' ELSE $2 END,
      last_error = $3, last_error_details = $4::jsonb,
      source_count = CASE WHEN $2 = 'empty' THEN 0 ELSE source_count END,
      next_attempt_at = CASE WHEN request_version > coalesce($5::bigint, request_version)
        THEN now() ELSE now() + interval '1 hour' END WHERE record_date = $1::date`,
    [date, status, diagnostic.code, JSON.stringify(diagnostic), version ?? null]);
  }

  async releaseDay(date) {
    await this.database.query(`UPDATE iett_history_import_days SET status = 'pending', next_attempt_at = now()
      WHERE record_date = $1::date AND status = 'running'`, [date]);
  }

  async deferForProxy(date, { from, to, error, version, attempted }) {
    const retryAfterMs = Math.max(1000, Math.min(60_000, Number(error.details?.retryAfterMs) || 30_000));
    const diagnostic = errorDiagnostics(error);
    const result = await this.database.query(`UPDATE iett_history_import_days SET status = 'pending',
      attempt_count = greatest(0, attempt_count - $5::int), last_error = $2, last_error_details = $3::jsonb,
      next_attempt_at = CASE WHEN request_version > $4::bigint THEN now()
        ELSE now() + $6::double precision * interval '1 millisecond' END
      WHERE record_date = $1::date RETURNING next_attempt_at AS "retryAt"`,
    [date, diagnostic.code, JSON.stringify(diagnostic), version, attempted ? 0 : 1, retryAfterMs]);
    await this.database.query(`UPDATE iett_history_import_days
      SET next_attempt_at = now() + $4::double precision * interval '1 millisecond'
      WHERE record_date BETWEEN $1::date AND $2::date AND record_date <> $3::date
      AND status NOT IN ('success', 'running') AND next_attempt_at <= now()`, [from, to, date, retryAfterMs]);
    return result.rows[0];
  }
  async saveDay(date, records, version) {
    if (!records.length) {
      await this.markFailure(date, { code: "IETT_ARCHIVE_EMPTY" }, "empty", version);
      return { status: "empty", sourceCount: 0 };
    }
    await this.database.query("BEGIN");
    try {
      const seen = new Set();
      for (let offset = 0; offset < records.length; offset += 1000) {
        const batch = records.slice(offset, offset + 1000).map(raw => {
          const record = normalizeArchiveRecord(raw, date);
          if (seen.has(record.source_id)) {
            throw new AppError(502, "IETT_ARCHIVE_DUPLICATE_ID", "IETT returned duplicate identifiers for one day.");
          }
          seen.add(record.source_id);
          return record;
        });
        await this.database.query(UPSERT, [JSON.stringify(batch)]);
      }
      const count = (await this.database.query("SELECT count(*)::int AS count FROM iett_history_trips WHERE record_date = $1::date", [date])).rows[0].count;
      await this.database.query(`UPDATE iett_history_import_days SET
        status = CASE WHEN request_version > coalesce($4::bigint, request_version) THEN 'pending' ELSE 'success' END,
        next_attempt_at = now(), source_count = $2, stored_count = $3, last_error = NULL,
        last_error_details = NULL, last_success_at = now() WHERE record_date = $1::date`, [date, records.length, count, version ?? null]);
      await this.database.query("COMMIT");
      return { status: "success", sourceCount: records.length, storedCount: count };
    } catch (error) {
      await this.database.query("ROLLBACK");
      throw error;
    }
  }

  async readHistory({ line, from, to, routeCode, limit, cursor }) {
    const values = [line, from, to];
    const conditions = ["line_code = $1", "record_date BETWEEN $2::date AND $3::date"];
    if (routeCode) { values.push(routeCode); conditions.push(`route_code = $${values.length}`); }
    if (cursor) {
      values.push(cursor.date, cursor.id);
      conditions.push(`(record_date, source_id) < ($${values.length - 1}::date, $${values.length}::bigint)`);
    }
    values.push(limit + 1);
    return (await this.database.query(`SELECT t.*, t.record_date::text AS record_date FROM iett_history_trips t
      WHERE ${conditions.join(" AND ")} ORDER BY t.record_date DESC, t.source_id DESC LIMIT $${values.length}`, values)).rows;
  }

  async coverage(from, to) {
    const result = await this.database.query(`SELECT d.day::date::text AS date,
      i.status, i.last_success_at, i.last_attempt_at, i.last_error
      FROM generate_series($1::date, $2::date, interval '1 day') AS d(day)
      LEFT JOIN iett_history_import_days i ON i.record_date = d.day::date ORDER BY d.day`, [from, to]);
    return result.rows;
  }

  async status() {
    const summary = (await this.database.query(`SELECT min(record_date)::text AS "from", max(record_date)::text AS "to",
      count(*)::int AS days, count(last_success_at)::int AS "successfulDays",
      coalesce(sum(stored_count), 0)::text AS "storedRecords", max(last_success_at) AS "lastSuccessfulSyncAt"
      FROM iett_history_import_days`)).rows[0];
    const incomplete = (await this.database.query(`SELECT record_date::text AS date, status,
      attempt_count AS attempts, last_error AS error, last_error_details AS "errorDetails",
      started_at AS "startedAt", last_attempt_at AS "lastAttemptAt",
      next_attempt_at AS "nextAttemptAt", last_success_at AS "lastSuccessfulSyncAt"
      FROM iett_history_import_days WHERE status <> 'success' ORDER BY record_date`)).rows;
    return { ...summary, incomplete };
  }
}
