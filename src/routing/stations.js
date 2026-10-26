import { AppError } from "../shared/errors.js";
import { readOptionalCoordinate } from "../shared/validation.js";

export function normalizeStationName(value) {
  return value
    .normalize("NFKD")
    .replace(/\p{M}/gu, "")
    .replace(/ı/g, "i")
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
}

export function addStationSequenceNumbers(stops) {
  const totals = new Map();

  for (const stop of stops) {
    if (!stop.name) {
      continue;
    }

    const key = normalizeStationName(stop.name);
    totals.set(key, (totals.get(key) ?? 0) + 1);
  }

  const occurrences = new Map();

  return stops.map(stop => {
    if (!stop.name) {
      return { ...stop };
    }

    const key = normalizeStationName(stop.name);
    const occurrence = (occurrences.get(key) ?? 0) + 1;
    const total = totals.get(key);

    occurrences.set(key, occurrence);

    if (total === 1) {
      return { ...stop };
    }

    return {
      ...stop,
      name: `${stop.name} (${occurrence})`
    };
  });
}

function withoutSequenceNumber(value) {
  return value.replace(/\s+\(\d+\)$/, "");
}

export function findStationsByName(stops, requestedName) {
  const normalized = normalizeStationName(requestedName);
  const exactMatches = stops.filter(stop => {
    return stop.name && normalizeStationName(stop.name) === normalized;
  });

  if (exactMatches.length) {
    return exactMatches;
  }

  return stops.filter(stop => {
    return stop.name
      && normalizeStationName(withoutSequenceNumber(stop.name)) === normalized;
  });
}

export function stationName(stop) {
  return typeof stop?.stationName === "string" ? stop.stationName.trim() || null : null;
}

export function normalizeRouteStops(stops) {
  return addStationSequenceNumbers(stops.map((stop, stationIndex) => ({
    stationIndex,
    name: stationName(stop),
    coordinate: readOptionalCoordinate(stop)
  })));
}

export function selectStation(stops, requestedName, role) {
  if (!requestedName) return role === "start" ? stops[0] : stops.at(-1);
  const found = findStationsByName(stops, requestedName);
  const prefix = role.toUpperCase();
  const field = `${role}Station`;
  if (!found.length) {
    throw new AppError(400, `${prefix}_STATION_NOT_FOUND`,
      `The requested ${role} station does not exist on this route.`, { [field]: requestedName });
  }
  if (found.length > 1) {
    throw new AppError(400, `AMBIGUOUS_${prefix}_STATION`,
      "The requested station occurs more than once on this route.", {
        [field]: requestedName,
        stationIndexes: found.map(stop => stop.stationIndex),
        candidates: found.map(stop => ({ stationIndex: stop.stationIndex, name: stop.name,
          lat: stop.coordinate?.lat ?? null, lng: stop.coordinate?.lng ?? null }))
      });
  }
  return found[0];
}
