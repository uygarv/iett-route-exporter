import { createDatabase } from "../db/database.js";

// Every metric is aggregated from individual observations, including weekly metrics.
// A single ordered-set aggregate supplies all percentiles for each distribution.
function distribution(expression) {
  return `jsonb_build_object(
    'sample_count', count(${expression}),
    'day_count', count(DISTINCT record_date) FILTER (WHERE ${expression} IS NOT NULL),
    'mean', avg(${expression}), 'min', min(${expression}), 'max', max(${expression}),
    'stddev', stddev_pop(${expression}),
    'percentiles', percentile_cont(ARRAY[0.10,0.25,0.50,0.75,0.90,0.95])
      WITHIN GROUP (ORDER BY ${expression}))`;
}

function deviation(expression) {
  return `(${distribution(expression)} || jsonb_build_object(
    'early_count', count(*) FILTER (WHERE ${expression} < -60),
    'on_time_count', count(*) FILTER (WHERE ${expression} BETWEEN -60 AND 60),
    'late_count', count(*) FILTER (WHERE ${expression} > 60)))`;
}

const BASIS_COLUMNS = { planned: "planned_started_at", adjusted: "adjusted_started_at", actual: "started_at" };

function sourceSql(basis) {
  // The only interpolated identifier comes from this fixed map, never request text.
  const column = BASIS_COLUMNS[basis];
  if (!column) throw new Error("Unknown departure basis");
  return `WITH source AS MATERIALIZED (
    SELECT record_date, source_id, vehicle_door_number, task_status, started_at, ended_at,
      extract(isodow FROM record_date)::int AS weekday,
      extract(epoch FROM (ended_at - started_at))::double precision AS duration,
      extract(epoch FROM ((${column} AT TIME ZONE 'Europe/Istanbul') - record_date::timestamp))::double precision AS departure_seconds,
      extract(epoch FROM ((ended_at AT TIME ZONE 'Europe/Istanbul') - record_date::timestamp))::double precision AS arrival_seconds,
      extract(epoch FROM (started_at - planned_started_at))::double precision AS planned_deviation,
      extract(epoch FROM (started_at - adjusted_started_at))::double precision AS adjusted_deviation,
      extract(epoch FROM (adjusted_started_at - planned_started_at))::double precision AS revision,
      extract(epoch FROM (started_at - lag(started_at) OVER (
        PARTITION BY record_date ORDER BY started_at, source_id)))::double precision AS headway
    FROM iett_history_trips t
    WHERE route_code = $1 AND record_date BETWEEN $2::date AND $3::date
  ), selected AS MATERIALIZED (
    SELECT *, CASE WHEN duration > 0 AND duration <= 86400 THEN duration END AS valid_duration,
      CASE WHEN duration > 0 AND duration <= 86400 THEN arrival_seconds END AS valid_arrival,
      CASE WHEN weekday <= 5 THEN 'weekday' WHEN weekday = 6 THEN 'saturday' ELSE 'sunday' END AS day_type,
      date_trunc('week', record_date::timestamp)::date::text AS week_start,
      floor(departure_seconds / 86400)::int AS day_offset,
      to_char(record_date::timestamp + departure_seconds * interval '1 second', 'HH24:MI') AS departure_time
    FROM source
    WHERE ($4::int IS NULL OR weekday = $4)
      AND ($5::int IS NULL OR floor(departure_seconds / 86400) = $5)
      AND ($6::int IS NULL OR departure_seconds >= $5::int * 86400 + $6::int * 60
        AND departure_seconds < $5::int * 86400 + ($6::int + 1) * 60)
  )`;
}

function aggregatesSql(basis) {
  return `${sourceSql(basis)}
  SELECT CASE
      WHEN GROUPING(record_date) = 0 THEN 'daily'
      WHEN GROUPING(week_start) = 0 THEN 'weekly'
      WHEN GROUPING(vehicle_door_number) = 0 THEN 'vehicle'
      WHEN GROUPING(weekday, day_offset) = 0 THEN 'weekday_departure'
      WHEN GROUPING(day_offset) = 0 THEN 'departure'
      WHEN GROUPING(weekday) = 0 THEN 'weekday'
      WHEN GROUPING(day_type) = 0 THEN 'day_type'
      ELSE 'summary' END AS kind,
    CASE
      WHEN GROUPING(record_date) = 0 THEN jsonb_build_object('record_date', record_date::text)
      WHEN GROUPING(week_start) = 0 THEN jsonb_build_object('week_start', week_start)
      WHEN GROUPING(vehicle_door_number) = 0 THEN jsonb_build_object('vehicle_door_number', vehicle_door_number)
      WHEN GROUPING(weekday, day_offset) = 0 THEN jsonb_build_object('weekday', weekday, 'day_offset', day_offset, 'departure_time', departure_time)
      WHEN GROUPING(day_offset) = 0 THEN jsonb_build_object('day_offset', day_offset, 'departure_time', departure_time)
      WHEN GROUPING(weekday) = 0 THEN jsonb_build_object('weekday', weekday)
      WHEN GROUPING(day_type) = 0 THEN jsonb_build_object('day_type', day_type)
      ELSE '{}'::jsonb END AS dimensions,
    jsonb_build_object('recorded_trips', count(*), 'day_count', count(DISTINCT record_date),
      'observed_departures', count(started_at), 'observed_arrivals', count(ended_at),
      'eligible_durations', count(valid_duration),
      'active_vehicles', count(DISTINCT vehicle_door_number) FILTER (WHERE nullif(trim(vehicle_door_number), '') IS NOT NULL),
      'recorded_duration_seconds', coalesce(sum(valid_duration), 0)) AS service,
    ${distribution("valid_duration")} AS duration_seconds,
    ${distribution("valid_arrival")} AS arrival_time,
    ${distribution("headway")} AS headway_seconds,
    ${deviation("planned_deviation")} AS planned_deviation_seconds,
    ${deviation("adjusted_deviation")} AS adjusted_deviation_seconds,
    (${distribution("revision")} || jsonb_build_object(
      'changed_count', count(*) FILTER (WHERE revision <> 0),
      'earlier_count', count(*) FILTER (WHERE revision < 0),
      'later_count', count(*) FILTER (WHERE revision > 0))) AS plan_revision_seconds,
    jsonb_build_object(
      'missing_start', count(*) FILTER (WHERE started_at IS NULL),
      'missing_end', count(*) FILTER (WHERE ended_at IS NULL),
      'missing_both', count(*) FILTER (WHERE started_at IS NULL AND ended_at IS NULL),
      'zero_duration', count(*) FILTER (WHERE duration = 0),
      'negative_duration', count(*) FILTER (WHERE duration < 0),
      'duration_over_24_hours', count(*) FILTER (WHERE duration > 86400),
      'missing_reference_departure', count(*) FILTER (WHERE departure_seconds IS NULL),
      'reference_day_offset_anomaly', count(*) FILTER (WHERE departure_seconds < 0 OR departure_seconds >= 172800),
      'excluded_duration', count(*) - count(valid_duration)) AS quality
  FROM selected GROUP BY GROUPING SETS (
    (), (weekday), (day_type), (day_offset, departure_time),
    (weekday, day_offset, departure_time), (record_date), (week_start), (vehicle_door_number)
  ) HAVING (GROUPING(day_offset) = 1 OR $6::int IS NULL AND day_offset BETWEEN 0 AND 1)
    AND (GROUPING(vehicle_door_number) = 1 OR nullif(trim(vehicle_door_number), '') IS NOT NULL)
  ORDER BY kind, dimensions`;
}

function parameters(options) {
  return [options.route_code, options.from, options.to, options.weekday, options.departure_day_offset,
    options.departure_time === null ? null : Number(options.departure_time.slice(0, 2)) * 60 + Number(options.departure_time.slice(3))];
}

export class StatisticsRepository {
  constructor(database = createDatabase()) { this.database = database; }

  async read(options) {
    const client = await this.database.connect();
    try {
      await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
      await client.query("SET LOCAL statement_timeout = '15s'");
      const values = parameters(options);
      const aggregates = await client.query(aggregatesSql(options.departure_basis), values);
      const days = await client.query(`${sourceSql(options.departure_basis)}, source_days AS (
          SELECT record_date, count(*)::int AS route_records,
            count(*) FILTER (WHERE departure_seconds IS NULL)::int AS missing_reference_departures,
            count(*) FILTER (WHERE departure_seconds < 0 OR departure_seconds >= 172800)::int AS reference_day_offset_anomalies
          FROM source GROUP BY record_date
        ), selected_days AS (
          SELECT record_date, count(*)::int AS matching_records,
            count(*) FILTER (WHERE ended_at IS NULL)::int AS missing_arrivals
          FROM selected GROUP BY record_date
        )
        SELECT d::date::text AS date, i.status, i.last_success_at, i.last_error,
          coalesce(s.route_records, 0) AS route_records,
          coalesce(s.missing_reference_departures, 0) AS missing_reference_departures,
          coalesce(s.reference_day_offset_anomalies, 0) AS reference_day_offset_anomalies,
          coalesce(m.matching_records, 0) AS matching_records, coalesce(m.missing_arrivals, 0) AS missing_arrivals
        FROM generate_series($2::date::timestamp, $3::date::timestamp, interval '1 day') d
        LEFT JOIN iett_history_import_days i ON i.record_date = d::date
        LEFT JOIN source_days s ON s.record_date = d::date
        LEFT JOIN selected_days m ON m.record_date = d::date
        WHERE ($4::int IS NULL OR extract(isodow FROM d) = $4) ORDER BY d`, values);
      const statuses = await client.query(`${sourceSql(options.departure_basis)}
        SELECT task_status, count(*)::int AS count FROM selected GROUP BY task_status ORDER BY task_status`, values);
      await client.query("COMMIT");
      return { groups: aggregates.rows, days: days.rows, statuses: statuses.rows };
    } catch (error) {
      try { await client.query("ROLLBACK"); } catch { /* Preserve the original failure. */ }
      throw error;
    } finally { client.release(); }
  }
}
