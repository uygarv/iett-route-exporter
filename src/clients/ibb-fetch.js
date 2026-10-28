import { fetch as proxyFetch, ProxyAgent, Pool } from "undici";
import { createIbbProxySource, readIbbProxySource } from "./ibb-proxy-source.js";

const responseFailures = new WeakMap();

// Fetch resolves at the headers. Keep body failures associated with the same
// proxy without wrapping/buffering a potentially large archive response.
export async function readIbbResponse(response, format) {
  try {
    return await response[format]();
  } catch (error) {
    if (!(error instanceof SyntaxError)) responseFailures.get(response)?.();
    throw error;
  } finally {
    responseFailures.delete(response);
  }
}

function createProxyAgent(uri) {
  const pools = new Set();
  const poolFactory = (origin, options) => {
    const pool = new Pool(origin, options);
    pools.add(pool);
    return pool;
  };
  const agent = new ProxyAgent({ uri, clientFactory: poolFactory, factory: poolFactory });
  return {
    dispatch: (...args) => agent.dispatch(...args),
    // Drain pools together: ProxyAgent's sequential close can wait forever on
    // a destination whose CONNECT request is still pending in the proxy pool.
    close: async () => {
      await Promise.all([...pools].map(pool => pool.close()));
      await agent.destroy();
    },
    // Force the CONNECT pool and destinations to stop together. Avoid starting
    // ProxyAgent.close(), which can reject internally if its pool is destroyed.
    destroy: () => Promise.all([...pools].map(pool => pool.destroy()).concat(agent.destroy()))
  };
}

async function waitForSource(pending, signal) {
  if (!signal) return pending;
  signal.throwIfAborted();
  let onAbort;
  try {
    return await Promise.race([pending, new Promise((resolve, reject) => {
      onAbort = () => reject(signal.reason);
      signal.addEventListener("abort", onAbort, { once: true });
    })]);
  } finally {
    signal.removeEventListener("abort", onAbort);
  }
}

// One transport attempt per call: the archive client's existing retry loop owns
// pacing/backoff. A failed proxy advances the list for the next attempt; a
// working proxy is reused. Configured proxies never fall back to direct access.
export function createIbbFetch({ sourceUrl = readIbbProxySource(),
  source = createIbbProxySource({ sourceUrl }),
  directFetch = globalThis.fetch, fetchImpl = proxyFetch,
  agentFactory = createProxyAgent, closeTimeoutMs = 1_000 } = {}) {
  if (!Number.isFinite(closeTimeoutMs) || closeTimeoutMs <= 0) throw new RangeError("Proxy close timeout must be positive.");
  const agents = new Map();
  const retiring = new Map();
  let selected;
  let closed = false;
  let closing;
  function retire(agent) {
    const pending = Promise.resolve().then(() => agent.close()).catch(() => {});
    retiring.set(agent, pending);
    pending.finally(() => retiring.delete(agent));
  }
  async function closeAgent(agent, pending = Promise.resolve().then(() => agent.close())) {
    let timer;
    try {
      const graceful = await Promise.race([
        pending.then(() => true, () => false),
        new Promise(resolve => { timer = setTimeout(() => resolve(false), closeTimeoutMs); })
      ]);
      if (!graceful) await agent.destroy();
    } finally {
      clearTimeout(timer);
    }
  }
  const request = async (input, options = {}) => {
    options.signal?.throwIfAborted();
    const urls = await waitForSource(source.get(), options.signal);
    options.signal?.throwIfAborted();
    if (closed) throw new Error("The IBB proxy transport is closed.");
    if (!urls.length) return directFetch(input, options);
    for (const [url, agent] of agents) {
      if (!urls.includes(url)) { agents.delete(url); retire(agent); }
    }
    if (!urls.includes(selected)) selected = urls[0];
    const url = selected;
    const index = urls.indexOf(url);
    let failed = false;
    function advance() {
      const cancelled = options.signal?.aborted && options.signal.reason?.name !== "TimeoutError";
      if (failed || cancelled) return;
      failed = true;
      if (selected === url) selected = urls[(index + 1) % urls.length];
    }
    try {
      if (!agents.has(url)) agents.set(url, agentFactory(url));
      const response = await fetchImpl(input, { ...options, dispatcher: agents.get(url) });
      if (response.status === 429 || response.status >= 500) advance();
      responseFailures.set(response, advance);
      return response;
    } catch (error) {
      // A caller cancellation preserves selection; a request deadline advances
      // it so a proxy with a stalled CONNECT response cannot trap every retry.
      const timedOut = options.signal?.aborted && options.signal.reason?.name === "TimeoutError";
      if (!timedOut) options.signal?.throwIfAborted();
      advance();
      if (timedOut) throw options.signal.reason;
      const failure = new Error("The IBB proxy request failed.");
      failure.code = "IBB_PROXY_REQUEST_FAILED";
      failure.details = { proxyIndex: index + 1, proxyCount: urls.length };
      // Undici may nest a CONNECT error several causes deep. Extract only
      // allowlisted diagnostics, never error messages, URLs or credentials.
      for (let cause = error, depth = 0; cause && depth < 6; cause = cause.cause, depth++) {
        if (typeof cause.code === "string" && /^[A-Z][A-Z0-9_]{0,63}$/.test(cause.code)) {
          failure.details.networkCode ??= cause.code;
        }
        const status = /Proxy response \((\d{3})\)/.exec(cause.message ?? "")?.[1];
        if (status) failure.details.proxyStatus = Number(status);
      }
      // Do not retain the original error: a proxy library may include secrets.
      throw failure;
    }
  };
  request.close = () => {
    if (closing) return closing;
    closed = true;
    closing = Promise.all([
      source.close(),
      ...[...agents.values()].map(agent => closeAgent(agent)),
      ...[...retiring].map(([agent, pending]) => closeAgent(agent, pending))
    ]).then(() => { agents.clear(); retiring.clear(); });
    return closing;
  };
  return request;
}

// Read configuration on first use, after the server/worker has loaded dotenv.
// This also keeps library/module imports free of network/configuration effects.
let defaultFetch;
export function ibbFetch(input, options) {
  defaultFetch ??= createIbbFetch();
  return defaultFetch(input, options);
}

export async function closeIbbProxyConnections() {
  const current = defaultFetch;
  defaultFetch = undefined;
  await current?.close();
}
