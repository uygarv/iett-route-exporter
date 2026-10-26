import { HereClient } from "../clients/here-client.js";
import { createRoutePreparation } from "../routing/route-preparation.js";
import { validateTravelTimeOptions, routeRecord } from "./travel-time-options.js";
import { createHereRoutingService } from "./here-travel-times.js";
import { createTomTomRoutingService } from "./tomtom-travel-times.js";
export { validateTravelTimeOptions } from "./travel-time-options.js";

function cacheKey(routeCode, options) {
  return JSON.stringify({
    routeCode,
    provider: options.provider,
    startStation: options.startStation,
    endStation: options.endStation,
    currentLocation: options.currentLocation
      ? {
          lat: Number(options.currentLocation.lat.toFixed(6)),
          lng: Number(options.currentLocation.lng.toFixed(6))
        }
      : null,
    departureTime: options.departureTime,
    dwellTimeSeconds: options.dwellTimeSeconds
  });
}

export function createIettTravelTimeService({
  iettClient,
  tomTomClient,
  hereClient = new HereClient(),
  cacheTtlMs = 60_000,
  geometryPolicy, shapeCacheTtlMs = 86_400_000, shapeCacheMaxEntries = 128, clock = Date.now
}) {
  if (!Number.isInteger(shapeCacheMaxEntries) || shapeCacheMaxEntries < 1
    || !Number.isFinite(shapeCacheTtlMs) || shapeCacheTtlMs < 0) {
    throw new RangeError("Invalid journey shape cache configuration.");
  }
  const cache = new Map();
  const preparation = createRoutePreparation();
  const { prepareRoute, prepareSection } = preparation;
  const tomTomService = createTomTomRoutingService({ tomTomClient, geometryPolicy,
    shapeCacheTtlMs, shapeCacheMaxEntries, clock });
  const hereService = createHereRoutingService({ hereClient, geometryPolicy,
    shapeCacheTtlMs, shapeCacheMaxEntries, clock });

  async function calculate(routeCode, options) {
    const routeData = await iettClient.getRoutePin(routeCode);
    const record = routeRecord(routeData, routeCode);
    const prepared = prepareRoute(record, options.provider);
    const { nodes } = prepareSection(prepared, options);
    const routingService = options.provider === "here" ? hereService : tomTomService;
    return routingService.calculate({ routeCode, prepared, nodes, options });
  }

  function cachedResponse(entry, debug) {
    // Keep the cached calculation private and each presentation independent.
    // Repeated callers of the same presentation still share its result.
    if (debug) return entry.debugPromise ??= entry.promise.then(({ result, debug: buildDebug }) =>
      structuredClone({ ...result, debug: buildDebug() }));
    return entry.publicPromise ??= entry.promise.then(({ result }) => structuredClone(result));
  }

  function calculateIettRouteTimes(routeCode, optionsInput) {
    const options = validateTravelTimeOptions(optionsInput);
    const key = cacheKey(routeCode, options);
    const existing = cache.get(key);
    const now = Number(clock());

    if (existing && existing.expiresAt > now) {
      return cachedResponse(existing, options.debug);
    }

    if (existing) {
      cache.delete(key);
    }

    const promise = calculate(routeCode, options);
    const entry = {
      expiresAt: Infinity,
      promise
    };

    cache.set(key, entry);
    promise.then(
      () => {
        if (cache.get(key) === entry) {
          entry.expiresAt = Number(clock()) + cacheTtlMs;
        }
      },
      () => {}
    );
    promise.catch(() => {
      if (cache.get(key) === entry) {
        cache.delete(key);
      }
    });

    return cachedResponse(entry, options.debug);
  }

  return {
    calculateIettRouteTimes,
    clearCache() {
      cache.clear();
      tomTomService.clearCache();
      preparation.clear();
      hereService.clearCache();
    }
  };
}
