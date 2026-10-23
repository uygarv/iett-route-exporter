import { AppError } from "../shared/errors.js";
import { createRoutingScheduler } from "./routing-scheduler.js";

export const HERE_HTTP_ATTEMPTS = Symbol("HERE HTTP attempts");
const schedulers = new Map();
export function createHereScheduler(options = {}) {
  return createRoutingScheduler({
    requestsPerSecond: Number(process.env.HERE_REQUESTS_PER_SECOND ?? 2),
    maxConcurrency: Number(process.env.HERE_MAX_CONCURRENCY ?? 2),
    ...options, provider: "HERE", providerLabel: "HERE", attemptsSymbol: HERE_HTTP_ATTEMPTS
  });
}

const RETURN = "polyline,summary,travelSummary,typicalDuration,routeHandle";
const SPANS = "segmentRef,length,duration,baseDuration,typicalDuration";

export class HereClient {
  constructor({ fetchImpl = globalThis.fetch, apiKey = process.env.HERE_API_KEY,
    baseUrl = "https://router.hereapi.com/v8/", timeoutMs = 20_000, scheduler } = {}) {
    if (typeof fetchImpl !== "function") throw new TypeError("A fetch implementation is required.");
    Object.assign(this, { fetchImpl, apiKey, baseUrl, timeoutMs, scheduler });
  }

  importRoute({ trace, via, departureTime }) {
    return this.#execute("import", { departureTime }, { trace, via });
  }

  getRouteByHandle(handle, { departureTime }) {
    return this.#execute(`routes/${encodeURIComponent(handle)}`, { departureTime }, undefined, true);
  }

  calculateRoute({ origin, destination, departureTime }) {
    const point = p => `${p.lat},${p.lng}`;
    return this.#execute("routes", { origin: point(origin), destination: point(destination),
      departureTime, routingMode: "fast" });
  }

  async #execute(path, parameters, body, handle = false) {
    if (typeof this.apiKey !== "string" || !this.apiKey.trim()) {
      throw new AppError(503, "ROUTING_PROVIDER_NOT_CONFIGURED", "HERE routing is not configured. Set HERE_API_KEY.");
    }
    const key = this.apiKey.trim();
    if (!this.scheduler && !schedulers.has(key)) schedulers.set(key, createHereScheduler());
    const scheduler = this.scheduler ?? schedulers.get(key);
    const encoded = body === undefined ? undefined : JSON.stringify(body);
    return scheduler.execute(JSON.stringify([key, this.baseUrl, path, parameters, encoded]),
      () => this.#request(path, parameters, encoded, handle));
  }

  async #request(path, parameters, body, handle) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const url = new URL(path, this.baseUrl.endsWith("/") ? this.baseUrl : `${this.baseUrl}/`);
      for (const [key, value] of Object.entries({ ...parameters, transportMode: "car", return: RETURN, spans: SPANS })) {
        url.searchParams.set(key, value);
      }
      // Authentication must be in the query for API-key authentication. Never
      // expose this URL, request identity, or provider error text to consumers.
      url.searchParams.set("apiKey", this.apiKey.trim());
      const response = await this.fetchImpl(url, {
        method: body === undefined ? "GET" : "POST",
        headers: { accept: "application/json", ...(body === undefined ? {} : { "content-type": "application/json" }) },
        ...(body === undefined ? {} : { body }), signal: controller.signal
      });
      if ([401, 403, 429].includes(response.status)) {
        await response.body?.cancel().catch(() => {});
        if (response.status === 429) {
          const retryAfter = response.headers.get("retry-after");
          throw new AppError(429, "HERE_RATE_LIMITED", "HERE routing is rate limited.",
            retryAfter ? { retryAfter } : undefined);
        }
        throw new AppError(503, "HERE_AUTH_FAILED", "HERE rejected the configured credentials or permissions.");
      }
      if (!response.ok) {
        await response.body?.cancel().catch(() => {});
        if (handle && [400, 404, 410].includes(response.status)) {
          throw new AppError(502, "HERE_ROUTE_HANDLE_INVALID", "The cached HERE route handle is no longer valid.");
        }
        throw new AppError(502, "HERE_BAD_STATUS", "HERE returned an unsuccessful response.", { status: response.status });
      }
      let data;
      try { data = await response.json(); }
      catch {
        if (controller.signal.aborted) throw new AppError(502, "HERE_TIMEOUT", "The HERE response timed out.");
        throw new AppError(502, "HERE_INVALID_JSON", "HERE returned invalid JSON.");
      }
      if (!data || typeof data !== "object" || !Array.isArray(data.routes)) {
        throw new AppError(502, "HERE_MALFORMED_RESPONSE", "HERE returned an invalid routing response.");
      }
      if (!data.routes.length) {
        throw new AppError(502, handle ? "HERE_ROUTE_HANDLE_INVALID" : "HERE_NO_ROUTE", "HERE could not reconstruct the requested route.");
      }
      return data;
    } catch (error) {
      if (error instanceof AppError) throw error;
      const timedOut = controller.signal.aborted || error?.name === "AbortError";
      throw new AppError(502, timedOut ? "HERE_TIMEOUT" : "HERE_REQUEST_FAILED",
        timedOut ? "The HERE routing request timed out." : "The HERE routing request failed.");
    } finally { clearTimeout(timeout); }
  }
}
