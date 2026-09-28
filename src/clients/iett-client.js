import { AppError } from "../shared/errors.js";

const DEFAULT_BASE_URL = "https://iett.istanbul/tr/RouteStation/";

export class IettClient {
  constructor({ fetchImpl = globalThis.fetch, timeoutMs = 10_000, baseUrl = DEFAULT_BASE_URL } = {}) {
    if (typeof fetchImpl !== "function") {
      throw new TypeError("A fetch implementation is required.");
    }

    this.fetchImpl = fetchImpl;
    this.timeoutMs = timeoutMs;
    this.baseUrl = baseUrl;
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
    if (cache.has(key)) {
      return cache.get(key);
    }

    const pending = loader().catch(error => {
      cache.delete(key);
      throw error;
    });

    cache.set(key, pending);
    return pending;
  }

  async #getJson(path, parameter, value) {
    const url = new URL(path, this.baseUrl);
    url.searchParams.set(parameter, value);

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);

    let response;

    try {
      response = await this.fetchImpl(url, {
        headers: {
          accept: "application/json"
        },
        signal: controller.signal
      });
    } catch (error) {
      const timedOut = error?.name === "AbortError";

      throw new AppError(
        502,
        timedOut ? "IETT_TIMEOUT" : "IETT_REQUEST_FAILED",
        timedOut ? "The IETT request timed out." : "The IETT request failed.",
        { endpoint: path }
      );
    } finally {
      clearTimeout(timeout);
    }

    if (!response.ok) {
      throw new AppError(502, "IETT_BAD_STATUS", "IETT returned an unsuccessful response.", {
        endpoint: path,
        status: response.status
      });
    }

    try {
      return await response.json();
    } catch {
      throw new AppError(502, "IETT_INVALID_JSON", "IETT returned invalid JSON.", {
        endpoint: path
      });
    }
  }
}
