ALTER TABLE iett_history_trips ADD COLUMN extra_fields jsonb NOT NULL DEFAULT '{}'
  CHECK (jsonb_typeof(extra_fields) = 'object');

-- These temporary helpers exist only while migrating. Their output mirrors
-- archiveSourceRecord in history/records.js; the complete round-trip is checked
-- against every original row before the old column can be dropped.
CREATE FUNCTION pg_temp.iett_history_canonical(r iett_history_trips)
RETURNS jsonb LANGUAGE sql STABLE AS $$
  SELECT jsonb_build_object(
    'ID', r.source_id,
    'NARSIVGOREVID', r.archive_task_id,
    'NKAYITGUNU', to_char(r.record_date, 'YYYYMMDD')::integer,
    'SHATKODU', r.line_code,
    'SGUZERGAHKODU', r.route_code,
    'SKAPINUMARA', r.vehicle_door_number,
    'DTBASLAMAZAMANI', CASE WHEN r.started_at IS NOT NULL
      THEN '/Date(' || (trunc(extract(epoch FROM r.started_at) * 1000)::bigint)::text || ')/' END,
    'DTBITISZAMANI', CASE WHEN r.ended_at IS NOT NULL
      THEN '/Date(' || (trunc(extract(epoch FROM r.ended_at) * 1000)::bigint)::text || ')/' END,
    'SGOREVDURUM', r.task_status,
    'NGOREVID', r.task_id,
    'DTPLANLANANBASLANGICZAMANI', CASE WHEN r.planned_started_at IS NOT NULL
      THEN '/Date(' || (trunc(extract(epoch FROM r.planned_started_at) * 1000)::bigint)::text || ')/' END,
    'DTDUZENLENENBASLANGICZAMANI', CASE WHEN r.adjusted_started_at IS NOT NULL
      THEN '/Date(' || (trunc(extract(epoch FROM r.adjusted_started_at) * 1000)::bigint)::text || ')/' END
  )
$$;

CREATE FUNCTION pg_temp.iett_history_extras(r iett_history_trips)
RETURNS jsonb LANGUAGE sql STABLE AS $$
  WITH canonical AS MATERIALIZED (SELECT pg_temp.iett_history_canonical(r) AS value),
  overrides AS (
    SELECT coalesce(jsonb_object_agg(e.key, e.value), '{}') AS value
    FROM canonical, jsonb_each(r.raw_payload) e
    WHERE e.value IS DISTINCT FROM canonical.value -> e.key
  ),
  absent AS (
    SELECT coalesce(jsonb_agg(key ORDER BY key), '[]') AS value
    FROM canonical, jsonb_object_keys(canonical.value) AS keys(key)
    WHERE NOT r.raw_payload ? key
  )
  SELECT (CASE WHEN overrides.value <> '{}' THEN jsonb_build_object('values', overrides.value) ELSE '{}'::jsonb END)
    || (CASE WHEN absent.value <> '[]' THEN jsonb_build_object('absent', absent.value) ELSE '{}'::jsonb END)
  FROM overrides, absent
$$;

-- Most rows need no exceptions; avoid rewriting those rows unnecessarily.
UPDATE iett_history_trips t SET extra_fields = pg_temp.iett_history_extras(t)
WHERE pg_temp.iett_history_extras(t) <> '{}';

DO $$
DECLARE total_rows bigint; mismatched_rows bigint;
BEGIN
  SELECT count(*), count(*) FILTER (WHERE
    ((pg_temp.iett_history_canonical(t) - ARRAY(
      SELECT jsonb_array_elements_text(coalesce(t.extra_fields -> 'absent', '[]'))
    )) || coalesce(t.extra_fields -> 'values', '{}')) IS DISTINCT FROM t.raw_payload
  ) INTO total_rows, mismatched_rows FROM iett_history_trips t;
  IF mismatched_rows <> 0 THEN
    RAISE EXCEPTION 'History payload verification failed: % of % records differ; raw_payload is retained', mismatched_rows, total_rows;
  END IF;
  RAISE NOTICE 'Verified all % history records: zero payload differences', total_rows;
END
$$;

DROP FUNCTION pg_temp.iett_history_extras(iett_history_trips);
DROP FUNCTION pg_temp.iett_history_canonical(iett_history_trips);
ALTER TABLE iett_history_trips DROP COLUMN raw_payload;
