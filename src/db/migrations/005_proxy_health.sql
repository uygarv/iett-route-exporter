CREATE TABLE iett_proxy_health (
  proxy_url text NOT NULL,
  target_origin text NOT NULL,
  last_event_at timestamptz NOT NULL,
  last_probe_at timestamptz,
  last_probe_latency_ms double precision,
  last_success_at timestamptz,
  last_request_success_at timestamptz,
  last_failure_at timestamptz,
  cooldown_until timestamptz,
  consecutive_failures integer NOT NULL DEFAULT 0,
  probe_successes bigint NOT NULL DEFAULT 0,
  request_successes bigint NOT NULL DEFAULT 0,
  failures bigint NOT NULL DEFAULT 0,
  transfer_bytes bigint NOT NULL DEFAULT 0,
  last_transfer_bytes bigint,
  last_transfer_duration_ms double precision,
  last_download_bps double precision,
  last_error_code text,
  PRIMARY KEY (proxy_url, target_origin)
);
CREATE INDEX iett_proxy_health_age_idx ON iett_proxy_health (last_event_at);
