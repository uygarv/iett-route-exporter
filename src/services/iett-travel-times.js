import { AppError } from "../shared/errors.js";
import { parseCoordinate } from "../shared/validation.js";
import {
  buildRouteGeometry,
  findClosestRoutePosition,
  pointAlongRoute
} from "../routing/geometry.js";
import { matchStopsToRoute, sliceRouteGeometry } from "../routing/timing.js";
import {
  addStationSequenceNumbers,
  findStationsByName
} from "../routing/stations.js";

const MAX_NODES_PER_REQUEST = 152;
const DEFAULT_DWELL_TIME_SECONDS = 20;
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

  return {
    startStation,
    endStation,
    currentLocation,
    departureTime: validateDepartureTime(options.departureTime),
    dwellTimeSeconds,
    debug: options.debug ?? false
  };
}

function routeRecord(data, routeCode) {
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

function publicNode(node) {
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

function selectRouteNodes(matches, geometry, options) {
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

function chunkRouteNodes(nodes) {
  const chunks = [];
  let startIndex = 0;

  while (startIndex < nodes.length - 1) {
    const endIndex = Math.min(startIndex + MAX_NODES_PER_REQUEST - 1, nodes.length - 1);

    chunks.push({
      startIndex,
      endIndex,
      nodes: nodes.slice(startIndex, endIndex + 1)
    });

    startIndex = endIndex;
  }

  return chunks;
}

function pointGeoJson(coordinate) {
  return {
    type: "Point",
    coordinates: [coordinate.lng, coordinate.lat]
  };
}

function createTomTomPayload(chunk, geometry, departureTime, dwellTimeSeconds) {
  const first = chunk.nodes[0];
  const last = chunk.nodes.at(-1);
  const intermediate = chunk.nodes.slice(1, -1);
  const routePlanningLocations = {
    origin: pointGeoJson(first.providerCoordinate),
    destination: pointGeoJson(last.providerCoordinate)
  };

  if (intermediate.length) {
    routePlanningLocations.waypoints = {
      type: "MultiPoint",
      coordinates: intermediate.map(node => {
        return [node.providerCoordinate.lng, node.providerCoordinate.lat];
      })
    };
  }

  const legs = chunk.nodes.slice(1).map((node, index, arrivals) => {
    const previousNode = chunk.nodes[index];
    const legPath = sliceRouteGeometry(
      geometry,
      previousNode.distanceAlongRoute,
      node.distanceAlongRoute
    );
    const finalArrivalInChunk = index === arrivals.length - 1;
    const leg = {
      path: {
        type: "LineString",
        coordinates: legPath.map(point => [point.lng, point.lat])
      }
    };

    if (finalArrivalInChunk) {
      return leg;
    }

    leg.routeStop = {
      pauseDurationInSeconds: dwellTimeSeconds
    };

    return leg;
  });

  return {
    routePlanningLocations,
    departureDateTime: departureTime,
    legs,
    traffic: "live",
    routeType: "fast",
    travelMode: "car"
  };
}

function finiteNonNegative(value) {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function readTomTomLegs(data, expectedCount) {
  const route = data?.routes?.[0];

  if (!route || !Array.isArray(route.legs) || route.legs.length !== expectedCount) {
    throw new AppError(
      502,
      "TOMTOM_MALFORMED_RESPONSE",
      "TomTom returned an unexpected number of route legs."
    );
  }

  return route.legs.map((leg, index) => {
    const summary = leg?.summary;
    const lengthInMeters = summary?.lengthInMeters;
    const travelDurationInSeconds = summary?.travelDurationInSeconds;
    const trafficDelayDurationInSeconds = summary?.trafficDelayDurationInSeconds;
    const departure = new Date(summary?.departureDateTime);
    const arrival = new Date(summary?.arrivalDateTime);

    if (
      !finiteNonNegative(lengthInMeters)
      || !finiteNonNegative(travelDurationInSeconds)
      || !finiteNonNegative(trafficDelayDurationInSeconds)
      || Number.isNaN(departure.getTime())
      || Number.isNaN(arrival.getTime())
      || arrival.getTime() < departure.getTime()
    ) {
      throw new AppError(
        502,
        "TOMTOM_MALFORMED_RESPONSE",
        "TomTom returned an invalid route-leg summary.",
        { legIndex: index }
      );
    }

    if (trafficDelayDurationInSeconds > travelDurationInSeconds) {
      throw new AppError(
        502,
        "TOMTOM_MALFORMED_RESPONSE",
        "TomTom returned an invalid traffic delay.",
        { legIndex: index }
      );
    }

    return {
      distanceMeters: lengthInMeters,
      drivingDurationSeconds: travelDurationInSeconds,
      trafficDelaySeconds: trafficDelayDurationInSeconds,
      freeFlowDurationSeconds: travelDurationInSeconds - trafficDelayDurationInSeconds,
      departureTime: summary.departureDateTime,
      arrivalTime: summary.arrivalDateTime,
      arrivalTimestamp: arrival.getTime()
    };
  });
}

function addSeconds(timestamp, seconds) {
  return new Date(timestamp + seconds * 1_000).toISOString();
}

function totalFromSegments(segments) {
  const total = segments.reduce((result, segment) => {
    result.distanceMeters += segment.distanceMeters;
    result.drivingDurationSeconds += segment.drivingDurationSeconds;
    result.dwellDurationSeconds += segment.dwellAfterArrivalSeconds;
    result.freeFlowDurationSeconds += segment.freeFlowDurationSeconds;
    result.trafficDelaySeconds += segment.trafficDelaySeconds;
    return result;
  }, {
    distanceMeters: 0,
    drivingDurationSeconds: 0,
    dwellDurationSeconds: 0,
    freeFlowDurationSeconds: 0,
    trafficDelaySeconds: 0
  });

  total.estimatedDurationSeconds = total.drivingDurationSeconds + total.dwellDurationSeconds;
  total.departureTime = segments[0].departureTime;
  total.arrivalTime = segments.at(-1).arrivalTime;
  return total;
}

function cacheKey(routeCode, options) {
  return JSON.stringify({
    routeCode,
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

export function createIettTravelTimeService({
  iettClient,
  tomTomClient,
  cacheTtlMs = 60_000
}) {
  const cache = new Map();

  async function calculate(routeCode, options) {
    const routeData = await iettClient.getRoutePin(routeCode);
    const record = routeRecord(routeData, routeCode);
    const geometry = buildRouteGeometry(record.line);
    const matchedStops = addStationSequenceNumbers(
      matchStopsToRoute(record.stationPlaces, geometry)
    );
    const nodes = selectRouteNodes(matchedStops, geometry, options);
    const chunks = chunkRouteNodes(nodes);
    const segments = [];
    let departureTime = options.departureTime;

    for (let chunkIndex = 0; chunkIndex < chunks.length; chunkIndex += 1) {
      const chunk = chunks[chunkIndex];
      const isLastChunk = chunkIndex === chunks.length - 1;
      const payload = createTomTomPayload(
        chunk,
        geometry,
        departureTime,
        options.dwellTimeSeconds
      );
      const data = await tomTomClient.calculateRoute(payload);
      const legs = readTomTomLegs(data, chunk.nodes.length - 1);

      for (let legIndex = 0; legIndex < legs.length; legIndex += 1) {
        const leg = legs[legIndex];
        const globalIndex = chunk.startIndex + legIndex;
        const finalSegment = globalIndex === nodes.length - 2;
        const dwellAfterArrivalSeconds = finalSegment ? 0 : options.dwellTimeSeconds;

        segments.push({
          index: globalIndex,
          from: publicNode(nodes[globalIndex]),
          to: publicNode(nodes[globalIndex + 1]),
          distanceMeters: leg.distanceMeters,
          drivingDurationSeconds: leg.drivingDurationSeconds,
          freeFlowDurationSeconds: leg.freeFlowDurationSeconds,
          trafficDelaySeconds: leg.trafficDelaySeconds,
          dwellAfterArrivalSeconds,
          elapsedUntilNextDepartureSeconds: leg.drivingDurationSeconds
            + dwellAfterArrivalSeconds,
          departureTime: leg.departureTime,
          arrivalTime: leg.arrivalTime
        });
      }

      if (!isLastChunk) {
        departureTime = addSeconds(legs.at(-1).arrivalTimestamp, options.dwellTimeSeconds);
      }
    }

    const origin = nodes[0];
    const destination = nodes.at(-1);
    const result = {
      routeCode,
      provider: "tomtom-orbis",
      trafficMode: "live",
      generatedAt: new Date().toISOString(),
      origin: publicNode(origin),
      destination: publicNode(destination),
      startDistanceAlongRoute: origin.distanceAlongRoute,
      endDistanceAlongRoute: destination.distanceAlongRoute,
      iettGeometryLengthMeters: destination.distanceAlongRoute - origin.distanceAlongRoute,
      total: totalFromSegments(segments),
      segments
    };

    if (options.debug) {
      result.debug = {
        chunkCount: chunks.length,
        upstreamRequestCount: chunks.length,
        matchedStops: matchedStops.map(stop => ({
          name: stop.name,
          stationIndex: stop.stationIndex,
          distanceAlongRoute: stop.distanceAlongRoute,
          distanceToRoute: stop.distanceToRoute,
          providerCoordinate: stop.providerCoordinate,
          projectedToRoute: stop.projectedToRoute
        }))
      };
    }

    return result;
  }

  function calculateIettRouteTimes(routeCode, optionsInput) {
    const options = validateTravelTimeOptions(optionsInput);
    const key = cacheKey(routeCode, options);
    const existing = cache.get(key);
    const now = Date.now();

    if (existing && existing.expiresAt > now) {
      return existing.promise;
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
          entry.expiresAt = Date.now() + cacheTtlMs;
        }
      },
      () => {}
    );
    promise.catch(() => {
      if (cache.get(key) === entry) {
        cache.delete(key);
      }
    });

    return promise;
  }

  return {
    calculateIettRouteTimes,
    clearCache() {
      cache.clear();
    }
  };
}
