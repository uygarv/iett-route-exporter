import { fetch as proxyFetch, ProxyAgent, Pool, Agent } from "undici";
import { createIbbProxySource, readIbbProxySource } from "./ibb-proxy-source.js";
import { AppError } from "../shared/errors.js";
import { diagnosticDetails } from "../shared/error-diagnostics.js";
import { fetchIbbHeaders, readIbbTimeouts } from "./ibb-timeouts.js";
import { createProxyHealth } from "./proxy-health.js";
import { ProxyHealthRepository } from "./proxy-health-repository.js";
import { createDatabase } from "../db/database.js";

const responseFailures = new WeakMap();
export async function readIbbResponse(response, format) {
  try {
    const result = await (typeof format === "function" ? format(response) : response[format]());
    responseFailures.get(response)?.complete();
    return result;
  } catch (error) {
    const context = responseFailures.get(response);
    if (!(error instanceof SyntaxError) && !(error instanceof AppError)) context?.advance(error);
    if (context && error && typeof error === "object") {
      error.details = { ...diagnosticDetails(error), ...context.details, phase: "response_body" };
    }
    throw error;
  } finally {
    responseFailures.delete(response);
  }
}

export function recordIbbResponseBytes(response, count) {
  responseFailures.get(response)?.addBytes(count);
}

export function ibbResponseDetails(response) {
  return responseFailures.get(response)?.details ?? {};
}

function createProxyAgent(uri, { connectTimeoutMs, headersTimeoutMs }) {
  const pools = new Set();
  const poolFactory = (origin, options) => {
    const pool = new Pool(origin, { ...options, headersTimeout: headersTimeoutMs });
    pools.add(pool);
    return pool;
  };
  const agent = new ProxyAgent({ uri, clientFactory: poolFactory, factory: poolFactory,
    proxyTls: { timeout: connectTimeoutMs }, requestTls: { timeout: connectTimeoutMs } });
  return {
    dispatch: (...args) => agent.dispatch(...args),
    close: async () => {
      await Promise.all([...pools].map(pool => pool.close()));
      await agent.destroy();
    },
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
export function createIbbFetch({ sourceUrl = readIbbProxySource(),
  source = createIbbProxySource({ sourceUrl }),
  directFetch, fetchImpl = proxyFetch,
  connectTimeoutMs, headersTimeoutMs, health, clock = Date.now,
  agentFactory = createProxyAgent, directAgentFactory = options => new Agent(options), closeTimeoutMs = 1_000 } = {}) {
  if (!Number.isFinite(closeTimeoutMs) || closeTimeoutMs <= 0) throw new RangeError("Proxy close timeout must be positive.");
  const limits = readIbbTimeouts({ connectTimeoutMs, headersTimeoutMs });
  let directAgent;
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
  function agentFor(url) {
    if (!agents.has(url)) agents.set(url, agentFactory(url, limits));
    return agents.get(url);
  }
  async function probe(url, input, signal) {
    const target = new URL(input);
    const archive = target.hostname === "api.ibb.gov.tr" && target.pathname.toLowerCase().endsWith(".asmx");
    if (archive) target.search = "?wsdl";
    const options = { method: archive ? "GET" : "HEAD", redirect: "manual", signal, dispatcher: agentFor(url),
      ...(archive ? { headers: { range: "bytes=0-0" } } : {}) };
    let response = await fetchIbbHeaders(fetchImpl, target, options, limits.headersTimeoutMs);
    if (options.method === "HEAD" && [405, 501].includes(response.status)) {
      await response.body?.cancel();
      response = await fetchIbbHeaders(fetchImpl, target,
        { ...options, method: "GET", headers: { range: "bytes=0-0" } }, limits.headersTimeoutMs);
    }
    await response.body?.cancel();
    if (!response.ok) throw new AppError(502, "PROXY_PROBE_HTTP_ERROR", "The IBB proxy probe returned an HTTP error.",
      { status: response.status, phase: "proxy_probe" });
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
    if (!urls.length) {
      try {
        if (!directFetch) directAgent ??= directAgentFactory({ connect: { timeout: limits.connectTimeoutMs } });
        return await fetchIbbHeaders(directFetch ?? proxyFetch, input,
          { ...options, ...(!directFetch ? { dispatcher: directAgent } : {}) }, limits.headersTimeoutMs);
      } catch (error) {
        options.signal?.throwIfAborted();
        error.details = { ...diagnosticDetails(error), transport: "direct", ...limits };
        throw error;
      }
    }
    for (const [url, agent] of agents) {
      if (!urls.includes(url)) { agents.delete(url); retire(agent); }
    }
    if (health) selected = await waitForSource(health.select(urls, input, selected,
      (url, signal) => probe(url, input, signal)), options.signal);
    else if (!urls.includes(selected)) selected = urls[0];
    options.signal?.throwIfAborted();
    if (closed) throw new Error("The IBB proxy transport is closed.");
    const url = selected;
    const index = urls.indexOf(url);
    const details = { transport: "proxy", proxy: new URL(url).origin, proxyIndex: index + 1, proxyCount: urls.length, ...limits };
    let failed = false;
    let completed = false;
    let bytes = 0;
    let countedBytes = false;
    const started = Number(clock());
    function advance(error) {
      const cancelled = options.signal?.aborted && options.signal.reason?.name !== "TimeoutError";
      if (failed || completed || cancelled) return;
      failed = true;
      health?.failure(url, input, { error, bytes, durationMs: Number(clock()) - started });
      if (selected === url) selected = urls[(index + 1) % urls.length];
    }
    try {
      const response = await fetchIbbHeaders(fetchImpl, input, { ...options, dispatcher: agentFor(url) }, limits.headersTimeoutMs);
      if (response.status === 429 || response.status >= 500) advance({ details: { status: response.status } });
      const length = Number(response.headers?.get("content-length"));
      if (Number.isSafeInteger(length) && length > 0) bytes = length;
      responseFailures.set(response, { advance, details,
        addBytes(count) {
          if (!Number.isSafeInteger(count) || count < 0) return;
          if (!countedBytes) { countedBytes = true; bytes = 0; }
          bytes += count;
        },
        complete() {
          if (failed || completed || !response.ok) return;
          completed = true;
          health?.success(url, input, { bytes, durationMs: Number(clock()) - started });
        }
      });
      return response;
    } catch (error) {
      const timedOut = error.name === "TimeoutError" || options.signal?.aborted && options.signal.reason?.name === "TimeoutError";
      if (!timedOut) options.signal?.throwIfAborted();
      advance(error);
      if (timedOut) {
        const reason = options.signal?.aborted ? options.signal.reason : error;
        reason.details = { ...details, phase: "response_headers", ...diagnosticDetails(error) };
        throw reason;
      }
      const failure = new Error("The IBB proxy request failed.");
      failure.code = "IBB_PROXY_REQUEST_FAILED";
      failure.details = { ...details, phase: "response_headers", ...diagnosticDetails(error) };
      for (let cause = error, depth = 0; cause && depth < 6; cause = cause.cause, depth++) {
        if (typeof cause.code === "string" && /^[A-Z][A-Z0-9_]{0,63}$/.test(cause.code)) {
          failure.details.networkCode ??= cause.code;
        }
        const status = /Proxy response \((\d{3})\)/.exec(cause.message ?? "")?.[1];
        if (status) failure.details.proxyStatus = Number(status);
      }
      throw failure;
    }
  };
  request.close = () => {
    if (closing) return closing;
    closed = true;
    closing = Promise.resolve().then(async () => {
      await health?.close();
      await Promise.all([
        source.close(),
        ...(directAgent ? [closeAgent(directAgent)] : []),
        ...[...agents.values()].map(agent => closeAgent(agent)),
        ...[...retiring].map(([agent, pending]) => closeAgent(agent, pending))
      ]);
      agents.clear(); retiring.clear();
    });
    return closing;
  };
  return request;
}
let defaultFetch;
let defaultDirectFetch;
export function ibbFetch(input, options) {
  defaultFetch ??= createIbbFetch({ health: createProxyHealth({
    ...(process.env.DATABASE_URL ? { repository: new ProxyHealthRepository(createDatabase({
      poolSize: 2, connectionTimeoutMs: 300, statementTimeoutMs: 500
    })) } : {})
  }) });
  return defaultFetch(input, options);
}

export function directIbbFetch(input, options) {
  defaultDirectFetch ??= createIbbFetch({ sourceUrl: null });
  return defaultDirectFetch(input, options);
}

export async function closeIbbProxyConnections() {
  const current = defaultFetch;
  const direct = defaultDirectFetch;
  defaultFetch = undefined;
  defaultDirectFetch = undefined;
  await Promise.all([current?.close(), direct?.close()]);
}
