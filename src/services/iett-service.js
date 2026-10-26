import { IettClient } from "../clients/iett-client.js";
import { TomTomClient } from "../clients/tomtom-client.js";
import { HereClient } from "../clients/here-client.js";
import { requireCode } from "../shared/validation.js";
import { createIettTravelTimeService } from "./iett-travel-times.js";
import { createIettGpxService } from "./iett-gpx-service.js";
import { createRouteDiscoveryService } from "./route-discovery.js";
import { createMapRouteService } from "./map-route-service.js";
export { isValidRoutePinResponse } from "./route-discovery.js";

export function parseRouteCode(code) {
  const value = requireCode(code, "routeCode");
  const parts = value.split("_");

  return {
    line: parts[0],
    direction: parts[1] || null,
    variant: parts.slice(2).join("_") || null
  };
}

export function createIettService({
  client = new IettClient(),
  tomTomClient = new TomTomClient(),
  hereClient = new HereClient(),
  timingCacheTtlMs = 60_000,
  geometryPolicy,
  shapeCacheTtlMs = 86_400_000,
  shapeCacheMaxEntries = 128,
  clock = Date.now
} = {}) {
  const travelTimeService = createIettTravelTimeService({
    iettClient: client,
    tomTomClient,
    hereClient,
    cacheTtlMs: timingCacheTtlMs,
    geometryPolicy, shapeCacheTtlMs, shapeCacheMaxEntries, clock
  });
  const gpxService = createIettGpxService({ iettClient: client });

  const { getIettRouteOptions } = createRouteDiscoveryService({ client });
  const { buildIettGoogleMapsRoute, buildIettAppleMapsRoute, buildIettYandexMapsRoute } = createMapRouteService({ client });

  async function calculateIettRouteTimes(routeCodeInput, options) {
    const routeCode = requireCode(routeCodeInput, "routeCode");
    return travelTimeService.calculateIettRouteTimes(routeCode, options);
  }

  async function buildIettGpx(routeCodeInput, options) {
    const routeCode = requireCode(routeCodeInput, "routeCode");
    return gpxService.buildIettGpx(routeCode, options);
  }

  return {
    getIettRouteOptions,
    prepareIettLine: getIettRouteOptions,
    buildIettGoogleMapsRoute,
    buildIettAppleMapsRoute,
    buildIettYandexMapsRoute,
    buildIettGpx,
    calculateIettRouteTimes,
    clearCaches() {
      travelTimeService.clearCache();
    }
  };
}
