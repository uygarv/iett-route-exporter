ALTER TABLE iett_history_import_days
  ADD COLUMN request_version bigint NOT NULL DEFAULT 0,
  ADD COLUMN last_error_details jsonb;
