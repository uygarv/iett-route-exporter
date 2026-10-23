import { AppError } from "../shared/errors.js";
import { sharedTomTomScheduler } from "./tomtom-scheduler.js";

const DEFAULT_BASE_URL = "https://api.tomtom.com/maps/orbis/routing/routes/calculate";

export class TomTomClient {
  constructor({
    fetchImpl = globalThis.fetch,
    apiKey = process.env.TOMTOM_API_KEY,
    timeoutMs = 12_000,
    baseUrl = DEFAULT_BASE_URL,
    scheduler
  } = {}) {
    if (typeof fetchImpl !== "function") {
      throw new TypeError("A fetch implementation is required.");
    }

    this.fetchImpl = fetchImpl;
    this.apiKey = apiKey;
    this.timeoutMs = timeoutMs;
    this.baseUrl = baseUrl;
    this.scheduler = scheduler;
  }

  async calculateRoute(payload) {
    if (typeof this.apiKey !== "string" || !this.apiKey.trim()) {
      throw new AppError(
        503,
        "ROUTING_PROVIDER_NOT_CONFIGURED",
        "TomTom routing is not configured. Set TOMTOM_API_KEY."
      );
    }

    const body = JSON.stringify(payload, (_key, value) => value && typeof value === "object" && !Array.isArray(value)
      ? Object.fromEntries(Object.keys(value).sort().map(key => [key, value[key]])) : value);
    const scheduler = this.scheduler ?? sharedTomTomScheduler(this.apiKey.trim());
    return scheduler.execute(JSON.stringify([this.apiKey.trim(), this.baseUrl, body]), () => this.#request(body));
  }

  async #request(body) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);
    let response;

    try {
      const url = new URL(this.baseUrl);
      url.searchParams.set("apiVersion", "3");

      response = await this.fetchImpl(url, {
        method: "POST",
        headers: {
          accept: "application/json",
          "content-type": "application/json",
          "tomtom-api-key": this.apiKey.trim(),
          attributes: "routes(summary,legs(summary,path),progressPoints)"
        },
        body,
        signal: controller.signal
      });
    } catch (error) {
      clearTimeout(timeout);
      const timedOut = error?.name === "AbortError";

      throw new AppError(
        502,
        timedOut ? "TOMTOM_TIMEOUT" : "TOMTOM_REQUEST_FAILED",
        timedOut
          ? "The TomTom routing request timed out."
          : "The TomTom routing request failed."
      );
    }

    if ([429, 401, 403].includes(response.status)) {
      clearTimeout(timeout);
      response.body?.cancel().catch(() => {});
    }
    if (response.status === 429) {
      const retryAfter = response.headers.get("retry-after");

      throw new AppError(
        429,
        "TOMTOM_RATE_LIMITED",
        "The TomTom routing quota has been exceeded.",
        retryAfter ? { retryAfter } : undefined
      );
    }

    if (response.status === 401 || response.status === 403) {
      throw new AppError(
        503,
        "TOMTOM_AUTH_FAILED",
        "TomTom rejected the configured API key."
      );
    }


    let data;
    let invalidJson = false;

    try {
      data = await response.json();
    } catch {
      if (controller.signal.aborted) {
        throw new AppError(502, "TOMTOM_TIMEOUT", "The TomTom routing response timed out.");
      }
      invalidJson = true;
    } finally {
      clearTimeout(timeout);
    }

    if (invalidJson) {
      throw new AppError(
        502,
        "TOMTOM_INVALID_JSON",
        "TomTom returned invalid JSON."
      );
    }

    if (!response.ok) {
      const providerCode = data?.detailedError?.code;
      const message = data?.detailedError?.message;
      const reconstructionFailed = providerCode === "CANNOT_RESTORE_BASEROUTE"
        || message?.includes("CANNOT_RESTORE_BASEROUTE");

      if (reconstructionFailed) {
        throw new AppError(
          502,
          "IETT_ROUTE_RECONSTRUCTION_FAILED",
          "TomTom could not match the IETT geometry to its road network."
        );
      }

      throw new AppError(
        502,
        "TOMTOM_BAD_STATUS",
        "TomTom returned an unsuccessful response.",
        {
          status: response.status,
          ...(providerCode ? { providerCode } : {})
        }
      );
    }

    return data;
  }
}
