export function readIbbProxySource(value = process.env.IBB_PROXY_SOURCE_URL) {
  if (value == null || value.trim() === "") return null;
  try {
    const url = new URL(value);
    if (!["https:", "http:"].includes(url.protocol) || url.username || url.password || url.hash) throw new Error();
    return url.href;
  } catch {
    throw new TypeError("IBB_PROXY_SOURCE_URL must be an HTTP/HTTPS URL without credentials.");
  }
}

function sourceError(code, status) {
  const error = new Error("The IBB proxy source is unavailable.");
  error.code = "IBB_PROXY_REQUEST_FAILED";
  error.details = { proxySourceCode: code, ...(status ? { proxySourceStatus: status } : {}) };
  return error;
}

// ProxyScrape mixes HTTP and SOCKS records. Undici's ProxyAgent uses HTTP
// CONNECT, so require a live HTTP(S) proxy with verified HTTPS support.
export function parseProxySource(data) {
  if (!data || !Array.isArray(data.proxies)) throw sourceError("PROXY_SOURCE_INVALID_RESPONSE");
  const candidates = [];
  for (const entry of data.proxies) {
    if (!entry || entry.alive !== true || entry.ssl !== true
      || typeof entry.ip_data?.countryCode !== "string"
      || entry.ip_data.countryCode.toUpperCase() !== "TR") continue;
    try {
      const url = new URL(entry.proxy);
      if (!["http:", "https:"].includes(url.protocol) || url.pathname !== "/"
        || url.username || url.password || url.search || url.hash) continue;
      candidates.push({ url: url.href,
        uptime: Number.isFinite(entry.uptime) ? entry.uptime : 0,
        latency: Number.isFinite(entry.average_timeout) ? entry.average_timeout : Infinity });
    } catch { /* Ignore unusable records, not the entire provider response. */ }
  }
  candidates.sort((a, b) => b.uptime - a.uptime || a.latency - b.latency);
  const urls = [...new Set(candidates.map(entry => entry.url))];
  if (!urls.length) throw sourceError("PROXY_SOURCE_EMPTY");
  return urls;
}

export function createIbbProxySource({ sourceUrl = readIbbProxySource(), fetchImpl = globalThis.fetch,
  clock = Date.now, ttlMs = 600_000, retryMs = 60_000, timeoutMs = 10_000 } = {}) {
  const url = readIbbProxySource(sourceUrl);
  for (const value of [ttlMs, retryMs, timeoutMs]) {
    if (!Number.isFinite(value) || value <= 0) throw new RangeError("Proxy source intervals must be positive.");
  }
  let urls = [];
  let nextRefreshAt = 0;
  let loading;
  let controller;
  let lastError;
  let closed = false;

  return {
    async get() {
      if (closed) throw sourceError("PROXY_SOURCE_CLOSED");
      if (!url) return [];
      if (!loading && Number(clock()) >= nextRefreshAt) {
        controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), timeoutMs);
        loading = (async () => {
          try {
            // Discovery always uses direct fetch, never the proxy being discovered.
            const response = await fetchImpl(url, { headers: { accept: "application/json" }, signal: controller.signal });
            if (!response.ok) {
              await response.body?.cancel();
              throw sourceError("PROXY_SOURCE_BAD_STATUS", response.status);
            }
            urls = parseProxySource(await response.json());
            lastError = undefined;
            nextRefreshAt = Number(clock()) + ttlMs;
          } catch (error) {
            lastError = error?.code === "IBB_PROXY_REQUEST_FAILED" ? error : sourceError("PROXY_SOURCE_FETCH_FAILED");
            nextRefreshAt = Number(clock()) + retryMs;
          } finally {
            clearTimeout(timer);
          }
        })().finally(() => { loading = undefined; });
      }
      if (loading) await loading;
      if (closed) throw sourceError("PROXY_SOURCE_CLOSED");
      if (!urls.length) throw lastError;
      return urls;
    },
    async close() {
      closed = true;
      controller?.abort();
      await loading;
    }
  };
}
