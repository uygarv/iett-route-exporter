export class ProxyHealthRepository {
  constructor(database) { this.database = database; }

  async load(origin, urls) {
    return (await this.database.query({ text: `SELECT * FROM iett_proxy_health
      WHERE target_origin = $1 AND proxy_url = ANY($2::text[])
      AND last_event_at > now() - interval '24 hours'`, values: [origin, urls], query_timeout: 500 })).rows;
  }

  async record(event) {
    const success = event.outcome === "success";
    const probe = event.kind === "probe";
    await this.database.query({ text: `INSERT INTO iett_proxy_health AS h (
      proxy_url, target_origin, last_event_at, last_probe_at, last_probe_latency_ms,
      last_success_at, last_request_success_at, last_failure_at, cooldown_until,
      consecutive_failures, probe_successes, request_successes, failures,
      transfer_bytes, last_transfer_bytes, last_transfer_duration_ms, last_download_bps, last_error_code
    ) VALUES ($1,$2,$3,CASE WHEN $4 THEN $3::timestamptz END,CASE WHEN $4 AND $5 THEN $6::double precision END,
      CASE WHEN $5 THEN $3::timestamptz END,CASE WHEN $5 AND NOT $4 THEN $3::timestamptz END,
      CASE WHEN NOT $5 THEN $3::timestamptz END,$7,CASE WHEN $5 THEN 0 ELSE 1 END,
      CASE WHEN $5 AND $4 THEN 1 ELSE 0 END,CASE WHEN $5 AND NOT $4 THEN 1 ELSE 0 END,
      CASE WHEN $5 THEN 0 ELSE 1 END,CASE WHEN $5 AND NOT $4 THEN $8::bigint ELSE 0 END,
      CASE WHEN NOT $4 THEN $8::bigint END,CASE WHEN NOT $4 THEN $6::double precision END,$9,$10)
    ON CONFLICT (proxy_url, target_origin) DO UPDATE SET
      last_event_at = greatest(h.last_event_at, EXCLUDED.last_event_at),
      last_probe_at = greatest(h.last_probe_at, EXCLUDED.last_probe_at),
      last_success_at = greatest(h.last_success_at, EXCLUDED.last_success_at),
      last_request_success_at = greatest(h.last_request_success_at, EXCLUDED.last_request_success_at),
      last_failure_at = greatest(h.last_failure_at, EXCLUDED.last_failure_at),
      last_probe_latency_ms = CASE WHEN EXCLUDED.last_probe_at >= coalesce(h.last_probe_at, '-infinity')
        THEN coalesce(EXCLUDED.last_probe_latency_ms, h.last_probe_latency_ms) ELSE h.last_probe_latency_ms END,
      cooldown_until = CASE WHEN EXCLUDED.last_event_at >= h.last_event_at THEN EXCLUDED.cooldown_until ELSE h.cooldown_until END,
      consecutive_failures = CASE WHEN EXCLUDED.last_event_at < h.last_event_at THEN h.consecutive_failures
        WHEN $5 THEN 0 ELSE h.consecutive_failures + 1 END,
      probe_successes = h.probe_successes + EXCLUDED.probe_successes,
      request_successes = h.request_successes + EXCLUDED.request_successes,
      failures = h.failures + EXCLUDED.failures,
      transfer_bytes = h.transfer_bytes + EXCLUDED.transfer_bytes,
      last_transfer_bytes = CASE WHEN NOT $4 AND EXCLUDED.last_event_at >= h.last_event_at
        THEN EXCLUDED.last_transfer_bytes ELSE h.last_transfer_bytes END,
      last_transfer_duration_ms = CASE WHEN NOT $4 AND EXCLUDED.last_event_at >= h.last_event_at
        THEN EXCLUDED.last_transfer_duration_ms ELSE h.last_transfer_duration_ms END,
      last_download_bps = CASE WHEN EXCLUDED.last_event_at >= h.last_event_at
        THEN coalesce(EXCLUDED.last_download_bps, h.last_download_bps) ELSE h.last_download_bps END,
      last_error_code = CASE WHEN EXCLUDED.last_event_at >= h.last_event_at THEN EXCLUDED.last_error_code ELSE h.last_error_code END`,
    values: [event.proxy, event.origin, new Date(event.at), probe, success, event.durationMs,
      event.cooldownUntil ? new Date(event.cooldownUntil) : null, event.bytes ?? 0, event.downloadBps ?? null, event.code ?? null], query_timeout: 500 });
  }

  async prune() {
    await this.database.query({ text: "DELETE FROM iett_proxy_health WHERE last_event_at < now() - interval '24 hours'", query_timeout: 500 });
  }

  async close() { await this.database.end(); }
}
