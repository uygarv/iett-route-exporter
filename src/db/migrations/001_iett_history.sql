CREATE TABLE iett_history_import_days (
  record_date date PRIMARY KEY,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'running', 'success', 'empty', 'failed')),
  attempt_count integer NOT NULL DEFAULT 0,
  source_count integer,
  stored_count integer,
  last_error text,
  started_at timestamptz,
  last_attempt_at timestamptz,
  last_success_at timestamptz,
  next_attempt_at timestamptz NOT NULL DEFAULT now(),
  refresh_requested_on date,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE iett_history_trips (
  record_date date NOT NULL,
  source_id bigint NOT NULL,
  archive_task_id bigint,
  task_id bigint,
  line_code text NOT NULL,
  route_code text,
  vehicle_door_number text,
  task_status text,
  started_at timestamptz,
  ended_at timestamptz,
  planned_started_at timestamptz,
  adjusted_started_at timestamptz,
  raw_payload jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  fetched_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (record_date, source_id)
);

CREATE INDEX iett_history_trips_line_date_idx
  ON iett_history_trips (line_code, record_date DESC, source_id DESC);
CREATE INDEX iett_history_trips_line_route_date_idx
  ON iett_history_trips (line_code, route_code, record_date DESC, source_id DESC);
