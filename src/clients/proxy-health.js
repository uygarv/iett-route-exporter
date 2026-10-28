import { diagnosticDetails } from "../shared/error-diagnostics.js";

const time = value => value == null ? 0 : new Date(value).getTime();
const keyOf = (proxy, origin) => `${origin}|${new URL(proxy).origin}`;

export function createProxyHealth({ repository, clock = Date.now,
  probeTimeoutMs = Number(process.env.IBB_PROXY_PROBE_TIMEOUT_MS?.trim() || 1500),
  freshMs = 120_000, cooldownMs = 60_000, loadWaitMs = 200,
  logger = entry => console.log(JSON.stringify(entry)) } = {}) {
  for (const value of [probeTimeoutMs, freshMs, cooldownMs, loadWaitMs]) {
    if (!Number.isSafeInteger(value) || value <= 0 || value > 2_147_483_647) throw new RangeError("Proxy health intervals must be positive integer milliseconds.");
  }
  const records = new Map();
  const loads = new Map();
  const probes = new Map();
  const writes = new Map();
  const pending = new Set();
  let nextPrune = 0;
  let nextMemoryPrune = 0;
  let nextErrorLog = 0;
  let closed = false;

  function persistenceError(error) {
    if (Number(clock()) < nextErrorLog) return;
    nextErrorLog = Number(clock()) + 60_000;
    logger({ event: "proxy.health.persistence_error", at: new Date(Number(clock())).toISOString(), ...diagnosticDetails(error) });
  }
  function background(promise) {
    const safe = promise.catch(persistenceError).finally(() => pending.delete(safe));
    pending.add(safe);
    return safe;
  }
  async function refresh(origin, urls) {
    if (!repository) return;
    let load = loads.get(origin);
    const first = !load;
    if (!load || Number(clock()) >= load.nextAt) {
      load = { nextAt: Number(clock()) + 60_000, initial: first };
      loads.set(origin, load);
      load.promise = background(Promise.resolve().then(() => repository.load(origin, urls.map(url => new URL(url).origin))).then(rows => {
        if (closed) return;
        for (const row of rows) {
          const key = keyOf(row.proxy_url, origin);
          if (time(row.last_event_at) > (records.get(key)?.at ?? 0)) records.set(key, {
            at: time(row.last_event_at), successAt: time(row.last_success_at),
            requestSuccessAt: time(row.last_request_success_at), failureAt: time(row.last_failure_at),
            cooldownUntil: time(row.cooldown_until), consecutive: row.consecutive_failures,
            latency: row.last_probe_latency_ms ?? Infinity, downloadBps: row.last_download_bps ?? 0
          });
        }
      }).finally(() => { load.loaded = true; }));
      if (Number(clock()) >= nextPrune) {
        nextPrune = Number(clock()) + 3_600_000;
        background(Promise.resolve().then(() => repository.prune()));
      }
    }
    if (load.initial && !load.loaded) {
      let timer;
      try { await Promise.race([load.promise, new Promise(resolve => { timer = setTimeout(resolve, loadWaitMs); })]); }
      finally { clearTimeout(timer); }
    }
  }
  function record(url, origin, kind, outcome, { durationMs, bytes = 0, error } = {}) {
    if (closed) return;
    const key = keyOf(url, origin);
    const old = records.get(key) ?? {};
    const at = Number(clock());
    const success = outcome === "success";
    const consecutive = success ? 0 : (old.consecutive ?? 0) + 1;
    const cooldownUntil = success ? 0 : at + Math.min(300_000, cooldownMs * 2 ** Math.min(consecutive - 1, 4));
    const elapsed = Math.max(1, durationMs ?? 1);
    const downloadBps = success && kind === "request" && bytes >= 4096 ? bytes * 1000 / elapsed : undefined;
    records.set(key, { ...old, at, consecutive, cooldownUntil,
      ...(success ? { successAt: at } : { failureAt: at }),
      ...(success && kind === "request" ? { requestSuccessAt: at } : {}),
      ...(success && kind === "probe" ? { latency: elapsed } : {}),
      ...(downloadBps ? { downloadBps } : {}) });
    if (repository && pending.size < 32) {
      const details = diagnosticDetails(error);
      const code = details.proxyStatus ? `PROXY_HTTP_${details.proxyStatus}` : details.status ? `HTTP_${details.status}`
        : details.networkCode ?? details.proxySourceCode;
      const event = { proxy: new URL(url).origin, origin, kind, outcome, at, cooldownUntil,
        durationMs: elapsed, bytes, downloadBps, code };
      const write = background((writes.get(key) ?? Promise.resolve()).then(() => repository.record(event)));
      writes.set(key, write);
      write.then(() => { if (writes.get(key) === write) writes.delete(key); });
    }
  }
  async function probe(url, origin, run) {
    const key = keyOf(url, origin);
    if (probes.has(key)) return probes.get(key).promise;
    const controller = new AbortController();
    const started = Number(clock());
    const timeout = new DOMException("The proxy probe timed out.", "TimeoutError");
    timeout.details = { networkCode: "PROXY_PROBE_TIMEOUT", phase: "proxy_probe" };
    const timer = setTimeout(() => controller.abort(timeout), probeTimeoutMs);
    const promise = Promise.resolve().then(async () => {
      try {
        await run(url, controller.signal);
        controller.signal.throwIfAborted();
        record(url, origin, "probe", "success", { durationMs: Number(clock()) - started });
        logger({ event: "proxy.probe", at: new Date(Number(clock())).toISOString(), proxy: new URL(url).origin, origin, status: "success", durationMs: Number(clock()) - started });
        return url;
      } catch (error) {
        if (!closed) {
          record(url, origin, "probe", "failure", { durationMs: Number(clock()) - started, error });
          logger({ event: "proxy.probe", at: new Date(Number(clock())).toISOString(), proxy: new URL(url).origin, origin, status: "failed",
            durationMs: Number(clock()) - started, ...diagnosticDetails(error) });
        }
        throw error;
      } finally {
        clearTimeout(timer);
        probes.delete(key);
      }
    });
    probes.set(key, { promise, controller });
    return promise;
  }
  return {
    async select(urls, input, selected, runProbe) {
      if (closed) throw new Error("Proxy health is closed.");
      const origin = new URL(input).origin;
      await refresh(origin, urls);
      const now = Number(clock());
      if (now >= nextMemoryPrune) {
        nextMemoryPrune = now + 3_600_000;
        for (const [key, state] of records) if (state.at < now - 86_400_000) records.delete(key);
      }
      const state = url => records.get(keyOf(url, origin)) ?? {};
      const usable = url => !(state(url).cooldownUntil > now);
      const fresh = url => usable(url) && state(url).successAt > now - freshMs && !state(url).consecutive;
      if (urls.includes(selected) && fresh(selected)) return selected;
      const ranked = urls.filter(usable).sort((a, b) => {
        const x = state(a), y = state(b);
        return Number(Boolean(y.requestSuccessAt > now - 86_400_000)) - Number(Boolean(x.requestSuccessAt > now - 86_400_000))
          || (x.consecutive ?? 0) - (y.consecutive ?? 0)
          || (y.downloadBps ?? 0) - (x.downloadBps ?? 0)
          || (x.latency ?? Infinity) - (y.latency ?? Infinity)
          || (y.successAt ?? 0) - (x.successAt ?? 0);
      });
      const cached = ranked.find(fresh);
      if (cached) {
        logger({ event: "proxy.selected", at: new Date(now).toISOString(), proxy: new URL(cached).origin, origin, reason: "recent_success" });
        return cached;
      }
      const candidates = ranked.slice(0, 2);
      if (!candidates.length) {
        const error = new Error("All listed proxies are temporarily cooling down.");
        error.code = "IBB_PROXY_REQUEST_FAILED";
        error.details = { proxySourceCode: "PROXY_COOLDOWN", phase: "proxy_probe" };
        throw error;
      }
      try { return await Promise.any(candidates.map(url => probe(url, origin, runProbe))); }
      catch {
        const error = new Error("No tested proxy could reach the IBB endpoint.");
        error.code = "IBB_PROXY_REQUEST_FAILED";
        error.details = { proxySourceCode: "PROXY_PROBE_FAILED", phase: "proxy_probe", proxyCount: urls.length };
        throw error;
      }
    },
    success(url, input, details) { record(url, new URL(input).origin, "request", "success", details); },
    failure(url, input, details) { record(url, new URL(input).origin, "request", "failure", details); },
    async close() {
      closed = true;
      for (const item of probes.values()) item.controller.abort();
      await Promise.allSettled([...probes.values()].map(item => item.promise));
      await Promise.all([...pending]);
      try { await repository?.close(); } catch (error) { persistenceError(error); }
    }
  };
}
