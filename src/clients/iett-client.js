import { AppError } from "../shared/errors.js";
import { readIbbResponse } from "./ibb-fetch.js";
import { createIettFetch } from "./iett-fetch.js";

const DEFAULT_BASE_URL = "https://iett.istanbul/tr/RouteStation/";

export function readRouteRecord(data, routeCode) {
  if (!Array.isArray(data)) {
    throw new AppError(502, "IETT_MALFORMED_RESPONSE", "IETT returned an invalid route response.", { routeCode });
  }
  if (!data.length) {
    throw new AppError(404, "IETT_ROUTE_NOT_FOUND", "IETT returned no data for this route code.", { routeCode });
  }
  if (!data[0] || typeof data[0] !== "object") {
    throw new AppError(502, "IETT_MALFORMED_RESPONSE", "IETT returned an invalid route record.", { routeCode });
  }
  return data[0];
}

export class IettClient {
  constructor({ useProxy, fetchImpl = createIettFetch({ scope: "client", useProxy }),
    timeoutMs = 10_000, baseUrl = DEFAULT_BASE_URL,
    cacheTtlMs = 86_400_000, clock = Date.now } = {}) {
    if (typeof fetchImpl !== "function") {
      throw new TypeError("A fetch implementation is required.");
    }

    this.fetchImpl = fetchImpl;
    this.timeoutMs = timeoutMs;
    this.baseUrl = baseUrl;
    this.cacheTtlMs = cacheTtlMs;
    this.clock = clock;
    this.allRoutesCache = new Map();
    this.routePinCache = new Map();
  }

  getAllRoutes(lineCode) {
    return this.#cached(this.allRoutesCache, lineCode, () => {
      return this.#getJson("GetAllRoute", "rcode", lineCode);
    });
  }

  getRoutePin(routeCode) {
    return this.#cached(this.routePinCache, routeCode, () => {
      return this.#getJson("GetRoutePinV2", "q", routeCode);
    });
  }

  clearCaches() {
    this.allRoutesCache.clear();
    this.routePinCache.clear();
  }

  #cached(cache, key, loader) {
    const existing = cache.get(key);
    if (existing && existing.expiresAt > Number(this.clock())) return existing.promise;
    const entry = { expiresAt: Infinity };
    const pending = loader().then(data => {
      entry.expiresAt = Number(this.clock()) + this.cacheTtlMs;
      return data;
    }, error => {
      if (cache.get(key) === entry) cache.delete(key);
      throw error;
    });
    entry.promise = pending;
    cache.set(key, entry);
    return pending;
  }

  async #getJson(path, parameter, value) {
    const url = new URL(path, this.baseUrl);
    url.searchParams.set(parameter, value);

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(new DOMException("The IETT request timed out.", "TimeoutError")), this.timeoutMs);

    try {
      const response = await this.fetchImpl(url, {
        headers: {
          accept: "application/json"
        },
        signal: controller.signal
      });

      if (!response.ok) {
        await response.body?.cancel();
        throw new AppError(502, "IETT_BAD_STATUS", "IETT returned an unsuccessful response.", {
          endpoint: path,
          status: response.status
        });
      }

      try {
        return await readIbbResponse(response, "json");
      } catch (error) {
        if (!(error instanceof SyntaxError)) throw error;
        throw new AppError(502, "IETT_INVALID_JSON", "IETT returned invalid JSON.", {
          endpoint: path
        });
      }
    } catch (error) {
      if (error instanceof AppError) throw error;
      const timedOut = controller.signal.aborted || error?.name === "AbortError";
      const proxyAuthFailed = error.code === "IBB_PROXY_REQUEST_FAILED" && error.details?.proxyStatus === 407;
      const proxyUnavailable = error.code === "IBB_PROXY_UNAVAILABLE";

      throw new AppError(
        proxyUnavailable ? 503 : 502,
        timedOut ? "IETT_TIMEOUT" : proxyUnavailable ? "IETT_PROXY_UNAVAILABLE" : proxyAuthFailed ? "IETT_PROXY_AUTH_FAILED" : "IETT_REQUEST_FAILED",
        timedOut ? "The IETT request timed out." : proxyUnavailable ? "No proxy is ready for IETT requests." : proxyAuthFailed ? "The IBB proxy rejected authentication." : "The IETT request failed.",
        { endpoint: path, ...(["IBB_PROXY_REQUEST_FAILED", "IBB_PROXY_UNAVAILABLE"].includes(error.code) ? error.details : {}) }
      );
    } finally {
      clearTimeout(timeout);
    }
  }
}
