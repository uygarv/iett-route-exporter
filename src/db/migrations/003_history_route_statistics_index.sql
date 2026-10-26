CREATE INDEX iett_history_trips_route_date_idx
  ON iett_history_trips (route_code, record_date DESC, source_id DESC);
DROP INDEX iett_history_trips_line_route_date_idx;
