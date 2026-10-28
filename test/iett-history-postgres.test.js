import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { createDatabase } from "../src/db/database.js";
import { migrate } from "../src/db/migrate.js";
import { HistoryRepository } from "../src/history/repository.js";
import { createHistoryCollector } from "../src/history/collector.js";
import { createIettHistoryService } from "../src/services/iett-history-service.js";
import { archiveRecord } from "./fixtures/iett-archive.js";
import { archiveSourceRecord, normalizeArchiveRecord } from "../src/history/records.js";
import { testStatisticsPostgres } from "./fixtures/iett-statistics-postgres.js";

const url = process.env.TEST_DATABASE_URL;

test("history PostgreSQL integration", { skip: !url }, async t => {
  assert.ok(new URL(url).pathname.endsWith("_test"), "TEST_DATABASE_URL must point to a dedicated *_test database");
  const database = createDatabase({ connectionString: url });
  const repository = new HistoryRepository(database);
  const reset = async () => database.query("TRUNCATE iett_history_trips, iett_history_import_days");
  t.after(() => database.end());

  await t.test("migration verifies every legacy field and rolls back on a mismatch before dropping raw_payload", async () => {
    await database.query("DROP TABLE IF EXISTS iett_history_trips, iett_history_import_days, iett_history_schema_migrations");
    await database.query(await readFile(new URL("../src/db/migrations/001_iett_history.sql", import.meta.url), "utf8"));
    await database.query(`CREATE TABLE iett_history_schema_migrations(name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now());
      INSERT INTO iett_history_schema_migrations(name) VALUES ('001_iett_history.sql')`);
    const legacy = [
      archiveRecord(),
      archiveRecord({ NEW_FIELD: { value: [null, "bus", 12] }, SKAPINUMARA: null }),
      archiveRecord({ NGOREVID: "9007199254740993", NARSIVGOREVID: "001234", NKAYITGUNU: "20261025" }),
      archiveRecord({ DTBASLAMAZAMANI: "/Date(0001792946030000+0300)/", DTBITISZAMANI: "invalid" }),
      archiveRecord({ SGUZERGAHKODU: 42, SKAPINUMARA: { value: "bus" }, SGOREVDURUM: false, NGOREVID: false }),
      archiveRecord({ DTBASLAMAZAMANI: "/Date(-1)/", DTBITISZAMANI: null }),
      archiveRecord({ ...JSON.parse('{"__proto__":{"preserved":true},"values":null,"absent":["future"]}') })
    ].map((raw, index) => ({ ...raw, ID: raw.ID + index }));
    const missing = archiveRecord({ ID: "00177490610" });
    delete missing.DTBITISZAMANI;
    delete missing.NGOREVID;
    legacy.push(missing);
    for (const raw of legacy) {
      const row = normalizeArchiveRecord(raw, "2026-10-25");
      await database.query(`INSERT INTO iett_history_trips(record_date, source_id, archive_task_id, task_id,
        line_code, route_code, vehicle_door_number, task_status, started_at, ended_at,
        planned_started_at, adjusted_started_at, raw_payload)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13::jsonb)`,
      [row.record_date, row.source_id, row.archive_task_id, row.task_id, row.line_code, row.route_code,
        row.vehicle_door_number, row.task_status, row.started_at, row.ended_at,
        row.planned_started_at, row.adjusted_started_at, JSON.stringify(raw)]);
    }
    // Simulate an encoding bug: the database must reject the entire migration.
    await database.query(`CREATE FUNCTION public.history_test_corrupt_extra() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN NEW.extra_fields := '{}'; RETURN NEW; END $$;
      CREATE TRIGGER history_test_corrupt_extra BEFORE UPDATE ON iett_history_trips
      FOR EACH ROW EXECUTE FUNCTION public.history_test_corrupt_extra()`);
    try {
      await assert.rejects(migrate(database), /History payload verification failed/);
      const columns = (await database.query(`SELECT column_name FROM information_schema.columns
        WHERE table_schema='public' AND table_name='iett_history_trips'`)).rows.map(row => row.column_name);
      assert.ok(columns.includes("raw_payload"));
      assert.ok(!columns.includes("extra_fields"));
      assert.equal((await database.query("SELECT count(*)::int AS count FROM iett_history_trips")).rows[0].count, legacy.length);
    } finally {
      await database.query("DROP TRIGGER history_test_corrupt_extra ON iett_history_trips; DROP FUNCTION public.history_test_corrupt_extra()");
    }
    assert.deepEqual(await migrate(database), ["002_compact_history_payload.sql", "003_history_route_statistics_index.sql"]);
    assert.deepEqual(await migrate(database), []);
    const rows = (await database.query("SELECT t.*, record_date::text AS record_date FROM iett_history_trips t ORDER BY source_id")).rows;
    assert.equal(rows.length, legacy.length);
    for (let index = 0; index < rows.length; index++) {
      assert.deepEqual(archiveSourceRecord(rows[index]), legacy[index]);
      assert.ok(!Object.hasOwn(rows[index], "raw_payload"));
    }
    assert.deepEqual(rows[0].extra_fields, {});
    await reset();
  });

  await t.test("upsert preserves all fields and refreshes corrections without duplicates", async () => {
    await reset();
    const raw = archiveRecord({ NEW_SOURCE_FIELD: { value: "preserved" }, SKAPINUMARA: null });
    await repository.withIngestionLock(async locked => {
      await locked.enqueueRange("2026-10-25", "2026-10-25");
      await locked.markRunning("2026-10-25");
      await locked.saveDay("2026-10-25", [raw]);
      await locked.saveDay("2026-10-25", [{ ...raw, SGOREVDURUM: "YK", DTBITISZAMANI: null }]);
    });
    const rows = (await database.query("SELECT * FROM iett_history_trips")).rows;
    assert.equal(rows.length, 1);
    assert.deepEqual(rows[0].extra_fields.values.NEW_SOURCE_FIELD, { value: "preserved" });
    assert.equal(rows[0].task_status, "YK");
    assert.equal(rows[0].ended_at, null);
    assert.equal(rows[0].vehicle_door_number, null);
  });

  await t.test("an invalid second batch rolls the whole day back and preserves the previous snapshot", async () => {
    await repository.withIngestionLock(async locked => {
      const records = Array.from({ length: 1001 }, (_, index) => archiveRecord({ ID: index + 1 }));
      records[1000].NKAYITGUNU = 20261024;
      await assert.rejects(locked.saveDay("2026-10-25", records), { code: "IETT_ARCHIVE_INVALID_RECORD" });
      const rows = (await locked.database.query("SELECT source_id FROM iett_history_trips")).rows;
      assert.equal(rows.length, 1);
      assert.equal(rows[0].source_id, "177490596");
      await assert.rejects(locked.saveDay("2026-10-25", [archiveRecord(), archiveRecord()]), { code: "IETT_ARCHIVE_DUPLICATE_ID" });
    });
  });

  await t.test("a second collector cannot acquire the advisory lock", async () => {
    await repository.withIngestionLock(async () => {
      let called = false;
      const result = await repository.withIngestionLock(() => { called = true; });
      assert.deepEqual(result, { locked: false });
      assert.equal(called, false);
    });
    assert.equal((await repository.withIngestionLock(async () => "released")).result, "released");
  });

  await t.test("retry scheduling selects the earliest unfinished completed day and skips successful/future days", async () => {
    await reset();
    await repository.enqueueRange("2026-09-26", "2026-09-28");
    await database.query(`UPDATE iett_history_import_days SET status = 'failed',
      next_attempt_at = now() + interval '37 minutes 3.118 seconds' WHERE record_date = '2026-09-26'`);
    const first = (await database.query(`UPDATE iett_history_import_days SET status = 'empty',
      next_attempt_at = now() + interval '12 minutes 17.456 seconds' WHERE record_date = '2026-09-27'
      RETURNING next_attempt_at`)).rows[0].next_attempt_at;
    await database.query(`UPDATE iett_history_import_days SET status = 'success', next_attempt_at = now()
      WHERE record_date = '2026-09-28'`);
    await database.query(`INSERT INTO iett_history_import_days(record_date)
      VALUES ((now() AT TIME ZONE 'Europe/Istanbul')::date), ((now() AT TIME ZONE 'Europe/Istanbul')::date + 1)`);
    assert.equal((await repository.nextRetryAt()).getTime(), first.getTime());
    await database.query("UPDATE iett_history_import_days SET status = 'success' WHERE record_date < '2026-10-01'");
    assert.equal(await repository.nextRetryAt(), null);
    await reset();
  });

  await t.test("a lost database session aborts ingestion and releases its lock for recovery", async () => {
    let started;
    const ready = new Promise(resolve => { started = resolve; });
    const ingestion = repository.withIngestionLock(async (locked, signal) => {
      const pid = (await locked.database.query("SELECT pg_backend_pid() AS pid")).rows[0].pid;
      started(pid);
      await new Promise(resolve => signal.addEventListener("abort", resolve, { once: true }));
      signal.throwIfAborted();
    });
    const rejected = assert.rejects(ingestion);
    await database.query("SELECT pg_terminate_backend($1)", [await ready]);
    await rejected;
    assert.equal((await repository.withIngestionLock(async () => "recovered")).result, "recovered");
  });

  await t.test("failed days do not stop collection, restart resumes, and a successful day is skipped", async () => {
    await reset();
    const calls = [];
    let fail = true;
    const collector = createHistoryCollector({ repository, clock: () => Date.parse("2026-10-26T12:00:00Z"), logger: () => {},
      client: { fetchDay: async date => {
        calls.push(date);
        if (date === "2026-10-24" && fail) throw new Error("network");
        return [archiveRecord({ NKAYITGUNU: Number(date.replaceAll("-", "")) })];
      } } });
    const first = await collector.sync({ from: "2026-10-23", to: "2026-10-25" });
    assert.equal(first.result.success, 2);
    assert.equal(first.result.failed, 1);
    assert.deepEqual(calls, ["2026-10-23", "2026-10-24", "2026-10-25"]);
    fail = false;
    calls.length = 0;
    await collector.sync({ from: "2026-10-23", to: "2026-10-25" });
    assert.deepEqual(calls, ["2026-10-24"]);
    calls.length = 0;
    await collector.sync({ from: "2026-10-23", to: "2026-10-25" });
    assert.deepEqual(calls, []);
  });

  await t.test("initial thirty-day range persists and daily refresh is only enqueued once", async () => {
    await reset();
    let calls = 0;
    let now = Date.parse("2026-10-26T12:00:00Z");
    const collector = createHistoryCollector({ repository, clock: () => now, logger: () => {},
      client: { fetchDay: async date => { calls++; return [archiveRecord({ NKAYITGUNU: Number(date.replaceAll("-", "")) })]; } } });
    await collector.sync({ automatic: true, refresh: true });
    assert.equal(calls, 30);
    assert.equal((await repository.status()).days, 30);
    calls = 0;
    await collector.sync({ automatic: true, refresh: true });
    assert.equal(calls, 0);
    now = Date.parse("2026-10-29T12:00:00Z");
    await collector.sync({ automatic: true, refresh: true });
    assert.equal(calls, 3);
    assert.deepEqual(await repository.bounds(), { first_date: "2026-09-26", last_date: "2026-10-28" });
  });

  await t.test("history filters exact lines, paginates ties and reports missing days", async () => {
    await reset();
    await repository.withIngestionLock(async locked => {
      await locked.enqueueRange("2026-10-24", "2026-10-25");
      await locked.saveDay("2026-10-25", [archiveRecord({ ID: 1 }), archiveRecord({ ID: 2 }),
        archiveRecord({ ID: 3, SHATKODU: "19F", SGUZERGAHKODU: "19F_G_D0" }),
        archiveRecord({ ID: 4, SGUZERGAHKODU: "19_G_D0" })]);
    });
    const service = createIettHistoryService({ repository, clock: () => Date.parse("2026-10-26T12:00:00Z") });
    const first = await service.getHistory("19", { from: "2026-10-24", to: "2026-10-25", limit: "2" });
    assert.deepEqual(first.data.map(row => row.source_id), [4, 2]);
    assert.equal(first.pagination.hasMore, true);
    assert.deepEqual(first.coverage.missingDates, ["2026-10-24"]);
    assert.equal(first.coverage.complete, false);
    const second = await service.getHistory("19", { cursor: first.pagination.nextCursor, limit: "2" });
    assert.deepEqual(second.data.map(row => row.source_id), [1]);
    assert.equal(second.pagination.hasMore, false);
    assert.equal(second.data[0].duration_seconds, 2361);
    const filtered = await service.getHistory("19", { routeCode: "19_D_D0" });
    assert.deepEqual(filtered.data.map(row => row.source_id), [2, 1]);
    assert.equal((await service.getHistory("UNKNOWN")).data.length, 0);
    await assert.rejects(service.getHistory("19F", { cursor: first.pagination.nextCursor }), { code: "INVALID_HISTORY_CURSOR" });
    await repository.withIngestionLock(async locked => { await locked.saveDay("2026-10-25", []); });
    const preserved = await service.getHistory("19", { from: "2026-10-25", to: "2026-10-25" });
    assert.equal(preserved.data.length, 3);
    assert.equal(preserved.coverage.complete, true);
    assert.deepEqual(preserved.coverage.emptyDates, ["2026-10-25"]);
  });

  await t.test("new ingestion round-trips conversion exceptions and missing fields through PostgreSQL", async () => {
    await reset();
    const raw = [
      archiveRecord({ ID: 1, DTBITISZAMANI: "unparseable", NGOREVID: false,
        SGUZERGAHKODU: 42, SKAPINUMARA: { value: "bus" }, NEW_FIELD: null }),
      archiveRecord({ ID: "0002", NKAYITGUNU: "20261025", ...JSON.parse('{"__proto__":{"kept":true},"values":"source","absent":false}') }),
      archiveRecord({ ID: 3, NGOREVID: "9007199254740993", DTBASLAMAZAMANI: "/Date(0001792946030000+0300)/" })
    ];
    delete raw[1].NARSIVGOREVID;
    delete raw[1].DTBITISZAMANI;
    await repository.withIngestionLock(async locked => {
      await locked.enqueueRange("2026-10-25", "2026-10-25");
      await locked.saveDay("2026-10-25", raw);
    });
    const rows = await repository.readHistory({ line: "19", from: "2026-10-25", to: "2026-10-25", limit: 1000 });
    for (const row of rows) {
      const expected = raw.find(value => BigInt(value.ID).toString() === row.source_id);
      assert.deepEqual(archiveSourceRecord(row), expected);
      assert.ok(Object.keys(row.extra_fields).length > 0);
    }
    assert.equal(rows.length, 3);
  });

  await testStatisticsPostgres(t, database, repository, reset);
});
