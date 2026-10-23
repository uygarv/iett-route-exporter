import { createHash } from "node:crypto";
import { AppError } from "../shared/errors.js";
import { parseCoordinate } from "../shared/validation.js";
import { buildRouteGeometry, findClosestRoutePosition } from "../routing/geometry.js";
import { matchStopsToRoute } from "../routing/timing.js";
import { addStationSequenceNumbers, findStationsByName } from "../routing/stations.js";

const DEFAULT_DWELL_TIME_SECONDS = 15;
const MAX_DWELL_TIME_SECONDS = 600;
const MAX_CURRENT_LOCATION_DISTANCE_METERS = 500;

function readStationOption(options, fieldName) {
  const errorField = fieldName === "startStation"
    ? "START_STATION"
    : "END_STATION";

  if (options[fieldName] === undefined) {
    return null;
  }

  if (typeof options[fieldName] !== "string") {
    throw new AppError(400, `INVALID_${errorField}`, `${fieldName} must be a string.`);
  }

  const value = options[fieldName].trim();

  if (!value || value.length > 200) {
    throw new AppError(400, `INVALID_${errorField}`, `${fieldName} is invalid.`);
  }

  return value;
}

function validateDepartureTime(value) {
  if (value === undefined || value === "now") {
    return "now";
  }

  if (typeof value !== "string") {
    throw new AppError(
      400,
      "INVALID_DEPARTURE_TIME",
      'departureTime must be "now" or an ISO 8601 date-time.'
    );
  }

  const trimmed = value.trim();
  const match = trimmed.match(
    /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.(\d+))?)?(Z|[+-]\d{2}:\d{2})?$/i
  );
  const parsed = new Date(trimmed);

  if (!match || Number.isNaN(parsed.getTime())) {
    throw new AppError(
      400,
      "INVALID_DEPARTURE_TIME",
      'departureTime must be "now" or an ISO 8601 date-time.'
    );
  }

  const [, year, month, day, hour, minute, second = "0"] = match;
  const validationDate = new Date(Date.UTC(
    Number(year),
    Number(month) - 1,
    Number(day),
    Number(hour),
    Number(minute),
    Number(second)
  ));
  const validComponents = validationDate.getUTCFullYear() === Number(year)
    && validationDate.getUTCMonth() === Number(month) - 1
    && validationDate.getUTCDate() === Number(day)
    && validationDate.getUTCHours() === Number(hour)
    && validationDate.getUTCMinutes() === Number(minute)
    && validationDate.getUTCSeconds() === Number(second);

  if (!validComponents) {
    throw new AppError(
      400,
      "INVALID_DEPARTURE_TIME",
      'departureTime must be "now" or an ISO 8601 date-time.'
    );
  }

  return match[8] ? parsed.toISOString() : trimmed;
}

export function trafficMetadata(departureTime) {
  if (departureTime === "now") {
    return {
      requestedTrafficMode: "live",
      trafficTimeContext: "immediate",
      trafficDataBasis: "live"
    };
  }

  return {
    requestedTrafficMode: "live",
    trafficTimeContext: "scheduled",
    trafficDataBasis: "historical"
  };
}

export function validateTravelTimeOptions(input) {
  const options = input ?? {};

  if (!options || typeof options !== "object" || Array.isArray(options)) {
    throw new AppError(400, "INVALID_OPTIONS", "Travel-time options must be an object.");
  }

  if (options.debug !== undefined && typeof options.debug !== "boolean") {
    throw new AppError(400, "INVALID_DEBUG", "debug must be a boolean.");
  }

  const dwellTimeSeconds = options.dwellTimeSeconds ?? DEFAULT_DWELL_TIME_SECONDS;

  if (
    !Number.isInteger(dwellTimeSeconds)
    || dwellTimeSeconds < 0
    || dwellTimeSeconds > MAX_DWELL_TIME_SECONDS
  ) {
    throw new AppError(
      400,
      "INVALID_DWELL_TIME",
      `dwellTimeSeconds must be an integer from 0 to ${MAX_DWELL_TIME_SECONDS}.`
    );
  }

  const startStation = readStationOption(options, "startStation");
  const endStation = readStationOption(options, "endStation");
  const currentLocation = options.currentLocation === undefined
    ? null
    : parseCoordinate(options.currentLocation, "currentLocation");

  if (startStation && currentLocation) {
    throw new AppError(
      400,
      "CONFLICTING_START_OPTIONS",
      "Use either currentLocation or startStation, not both."
    );
  }

  const provider = options.provider === undefined ? "tomtom" : options.provider;
  if (provider !== "tomtom" && provider !== "here") {
    throw new AppError(400, "INVALID_PROVIDER", 'provider must be "tomtom" or "here".');
  }

  return {
    provider,
    startStation,
    endStation,
    currentLocation,
    departureTime: validateDepartureTime(options.departureTime),
    dwellTimeSeconds,
    debug: options.debug ?? false
  };
}

export function routeRecord(data, routeCode) {
  if (!Array.isArray(data)) {
    throw new AppError(502, "IETT_MALFORMED_RESPONSE", "IETT returned an invalid route response.", {
      routeCode
    });
  }

  if (!data.length) {
    throw new AppError(404, "IETT_ROUTE_NOT_FOUND", "IETT returned no data for this route code.", {
      routeCode
    });
  }

  const record = data[0];

  if (!record || typeof record.line !== "string" || !record.line.trim()) {
    throw new AppError(502, "IETT_MALFORMED_RESPONSE", "IETT returned a route without geometry.", {
      routeCode
    });
  }

  if (!Array.isArray(record.stationPlaces) || record.stationPlaces.length < 2) {
    throw new AppError(502, "IETT_INVALID_STOPS", "The IETT route must contain at least two stops.", {
      routeCode
    });
  }

  return record;
}

function selectStation(matches, requestedName, role) {
  if (!requestedName) {
    return role === "start" ? matches[0] : matches.at(-1);
  }

  const found = findStationsByName(matches, requestedName);
  const codePrefix = role.toUpperCase();

  if (!found.length) {
    throw new AppError(
      400,
      `${codePrefix}_STATION_NOT_FOUND`,
      `The requested ${role} station does not exist on this route.`,
      { [`${role}Station`]: requestedName }
    );
  }

  if (found.length > 1) {
    throw new AppError(
      400,
      `AMBIGUOUS_${codePrefix}_STATION`,
      "The requested station occurs more than once on this route.",
      {
        [`${role}Station`]: requestedName,
        stationIndexes: found.map(stop => stop.stationIndex),
        candidates: found.map(stop => ({
          stationIndex: stop.stationIndex,
          name: stop.name,
          lat: stop.coordinate.lat,
          lng: stop.coordinate.lng
        }))
      }
    );
  }

  return found[0];
}

function stationNode(stop) {
  return {
    type: "station",
    name: stop.name,
    stationIndex: stop.stationIndex,
    lat: stop.coordinate.lat,
    lng: stop.coordinate.lng,
    distanceAlongRoute: stop.distanceAlongRoute,
    providerCoordinate: stop.providerCoordinate
  };
}

function currentLocationNode(location, routeMatch) {
  return {
    type: "current-location",
    lat: location.lat,
    lng: location.lng,
    distanceAlongRoute: routeMatch.distanceAlongRoute,
    providerCoordinate: {
      lat: routeMatch.lat,
      lng: routeMatch.lng
    }
  };
}

export function publicNode(node) {
  const result = {
    type: node.type,
    lat: node.lat,
    lng: node.lng
  };

  if (node.type === "station") {
    result.name = node.name;
    result.stationIndex = node.stationIndex;
  }

  return result;
}

export function selectRouteNodes(matches, geometry, options) {
  const end = selectStation(matches, options.endStation, "end");
  let start;
  let nodes;

  if (options.currentLocation) {
    const routeMatch = findClosestRoutePosition(geometry, options.currentLocation);

    if (routeMatch.distanceToRoute > MAX_CURRENT_LOCATION_DISTANCE_METERS) {
      throw new AppError(
        400,
        "CURRENT_LOCATION_OFF_ROUTE",
        "The current location is more than 500 metres from this route.",
        { distanceMeters: Math.round(routeMatch.distanceToRoute) }
      );
    }

    if (routeMatch.ambiguous) {
      throw new AppError(
        400,
        "AMBIGUOUS_CURRENT_LOCATION",
        "The current location matches multiple distant positions along this route."
      );
    }

    start = currentLocationNode(options.currentLocation, routeMatch);
    nodes = [start, ...matches
      .filter(stop => {
        return stop.distanceAlongRoute > start.distanceAlongRoute + 1
          && stop.distanceAlongRoute <= end.distanceAlongRoute + 1;
      })
      .map(stationNode)];
  } else {
    const selectedStart = selectStation(matches, options.startStation, "start");
    start = stationNode(selectedStart);
    nodes = matches
      .filter(stop => {
        return stop.stationIndex >= selectedStart.stationIndex
          && stop.stationIndex <= end.stationIndex;
      })
      .map(stationNode);
  }

  if (end.distanceAlongRoute <= start.distanceAlongRoute + 1 || nodes.length < 2) {
    throw new AppError(
      400,
      "INVALID_STATION_RANGE",
      "The end station must come after the selected route start.",
      {
        startDistanceAlongRoute: start.distanceAlongRoute,
        endDistanceAlongRoute: end.distanceAlongRoute
      }
    );
  }

  return nodes;
}

export function cacheKey(routeCode, options) {
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
    dwellTimeSeconds: options.dwellTimeSeconds,
    debug: options.debug
  });
}

export function compactGeometryMatch(match) {
  const summary = Object.fromEntries([
    "valid", "quality", "acceptanceBasis", "orderedMaximumDeviationMeters",
    "maximumStopOffsetMeters", "providerGeometryValid", "estimatedLengthMeters"
  ].filter(key => match[key] !== undefined).map(key => [key, match[key]]));
  if (match.alternatives?.length) {
    summary.alternatives = match.alternatives.map(interval => ({
      fromStationIndex: interval.fromStationIndex,
      toStationIndex: interval.toStationIndex,
      referenceLengthMeters: interval.referenceLengthMeters,
      returnedLengthMeters: interval.returnedLengthMeters
    }));
  }
  return summary;
}

export function roundSegmentDistances(segments) {
  let cumulativeDistance = 0, previousRoundedDistance = 0;
  return segments.map(segment => {
    cumulativeDistance += segment.distanceMeters;
    const roundedDistance = Math.round(cumulativeDistance * 10);
    const distanceMeters = (roundedDistance - previousRoundedDistance) / 10;
    previousRoundedDistance = roundedDistance;
    return { ...segment, distanceMeters };
  });
}

export function createRoutePreparation() {
  let preparedRoutes = new WeakMap();
  function prepareRoute(record, provider = "tomtom") {
    // Geometry and stop matching depend on IETT data, not the departure instant.
    // Include a fingerprint so an updated record cannot reuse stale preparation.
    const fingerprint = createHash("sha256").update(JSON.stringify([record.line, record.stationPlaces])).digest("hex");
    const existing = preparedRoutes.get(record);
    if (existing?.fingerprint === fingerprint && existing.provider === provider) return existing;
    const geometry = buildRouteGeometry(record.line, { minimumPointSpacingMeters: provider === "here" ? 0 : 2 });
    const matchedStops = addStationSequenceNumbers(matchStopsToRoute(record.stationPlaces, geometry));
    const prepared = { fingerprint, provider, geometry, matchedStops, sections: new Map() };
    preparedRoutes.set(record, prepared);
    return prepared;
  }

  function prepareSection(prepared, options) {
    const key = JSON.stringify({
      startStation: options.startStation, endStation: options.endStation,
      currentLocation: options.currentLocation, dwellTimeSeconds: options.dwellTimeSeconds
    });
    if (prepared.sections.has(key)) return prepared.sections.get(key);
    const nodes = selectRouteNodes(prepared.matchedStops, prepared.geometry, options);
    const section = { nodes };
    // Current locations can vary with every request. Bound the retained sections.
    if (prepared.sections.size >= 64) prepared.sections.delete(prepared.sections.keys().next().value);
    prepared.sections.set(key, section);
    return section;
  }

  return { prepareRoute, prepareSection, clear() { preparedRoutes = new WeakMap(); } };
}

export function resultEnvelope({ routeCode, provider, options, nodes, clock }) {
  const origin = nodes[0], destination = nodes.at(-1);
  return {
    routeCode, provider, ...trafficMetadata(options.departureTime),
    generatedAt: new Date(Number(clock())).toISOString(),
    origin: publicNode(origin), destination: publicNode(destination),
    startDistanceAlongRoute: Math.round(origin.distanceAlongRoute * 10) / 10,
    endDistanceAlongRoute: Math.round(destination.distanceAlongRoute * 10) / 10,
    iettGeometryLengthMeters: Math.round((destination.distanceAlongRoute - origin.distanceAlongRoute) * 10) / 10
  };
}
