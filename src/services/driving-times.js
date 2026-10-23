import { TomTomClient } from "../clients/tomtom-client.js";
import { AppError } from "../shared/errors.js";
import { parseCoordinate } from "../shared/validation.js";

export function createDrivingTimeService({
  tomTomClient = new TomTomClient(),
  clock = Date.now,
  cacheTtlMs = 60_000
} = {}) {
  const cache = new Map();

  async function calculate({ origin, destination, departureTime }) {
    const data = await tomTomClient.calculateRoute({
      routePlanningLocations: {
        origin: { type: "Point", coordinates: [origin.lng, origin.lat] },
        destination: { type: "Point", coordinates: [destination.lng, destination.lat] }
      },
      departureDateTime: departureTime,
      travelMode: "car",
      routeType: "fast",
      traffic: "live"
    });
    const summary = data?.routes?.[0]?.summary;
    const duration = summary?.travelDurationInSeconds;
    const delay = summary?.trafficDelayDurationInSeconds;

    if (
      typeof duration !== "number" || !Number.isFinite(duration) || duration < 0
      || (delay !== undefined && (
        typeof delay !== "number" || !Number.isFinite(delay) || delay < 0 || delay > duration
      ))
    ) {
      throw new AppError(502, "TOMTOM_MALFORMED_RESPONSE", "TomTom returned an invalid driving duration.");
    }

    return {
      durationSeconds: Math.ceil(duration),
      provider: "tomtom-orbis",
      requestedTrafficMode: "live",
      trafficTimeContext: "scheduled",
      trafficDataBasis: "historical-with-known-live-events",
      ...(delay === undefined ? {} : { trafficDelaySeconds: delay }),
      ...(Number.isFinite(summary.lengthInMeters) && summary.lengthInMeters >= 0
        ? { distanceMeters: summary.lengthInMeters } : {})
    };
  }

  function calculateDrivingTimes(input) {
    const origin = parseCoordinate(input.origin, "origin");
    const destination = parseCoordinate(input.destination, "destination");
    const timestamp = typeof input.departureTime === "string" ? Date.parse(input.departureTime) : NaN;
    if (!Number.isFinite(timestamp)) {
      throw new AppError(400, "INVALID_DEPARTURE_TIME", "departureTime must be an ISO date-time.");
    }
    const departureTime = new Date(timestamp).toISOString();
    const key = JSON.stringify([origin, destination, departureTime]);
    const now = Number(clock());
    for (const [entryKey, entry] of cache) {
      if (entry.expiresAt <= now) cache.delete(entryKey);
    }
    if (cache.has(key)) return cache.get(key).promise;

    const entry = { expiresAt: Infinity };
    entry.promise = calculate({ origin, destination, departureTime }).then(result => {
      entry.expiresAt = Number(clock()) + cacheTtlMs;
      return result;
    }, error => {
      if (cache.get(key) === entry) cache.delete(key);
      throw error;
    });
    cache.set(key, entry);
    return entry.promise;
  }

  return { calculateDrivingTimes, clearCache: () => cache.clear() };
}
