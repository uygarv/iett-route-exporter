import { AppError } from "../shared/errors.js";
import { parseCoordinate } from "../shared/validation.js";
import {
  buildRouteGeometry,
  findClosestRoutePosition,
  findRoutePositionCandidates,
  haversineDistance,
  resampleRoute,
  pointAlongRoute
} from "../routing/geometry.js";
import { matchStopsToRoute, sliceRouteGeometry } from "../routing/timing.js";
import {
  addStationSequenceNumbers,
  findStationsByName
} from "../routing/stations.js";

const MAX_NODES_PER_REQUEST = 152;
const MAX_RECONSTRUCTION_LEG_METERS = 1_000;
const DEFAULT_DWELL_TIME_SECONDS = 20;
const MAX_DWELL_TIME_SECONDS = 600;
const MAX_CURRENT_LOCATION_DISTANCE_METERS = 500;
const MAX_RECONSTRUCTION_ENDPOINT_OFFSET_METERS = 40;
const MAX_RECONSTRUCTION_P95_DEVIATION_METERS = 35;
const MAX_RECONSTRUCTION_DEVIATION_METERS = 80;
const RECONSTRUCTION_LANE_OFFSETS_METERS = [0, 4, -4, 8, -8, 12, -12, 16, -16];
const MIN_REPAIR_SPLIT_METERS = 25;
const MAX_UNMAPPED_MANEUVER_METERS = 75;
const MAX_UNMAPPED_ROUTE_SECTION_METERS = 1_000;
const MIN_UNMAPPED_MANEUVER_TURN_DEGREES = 60;
const MIN_LONG_UNMAPPED_SECTION_TURN_DEGREES = 135;
const UNMAPPED_MANEUVER_SPEED_METERS_PER_SECOND = 2.5;
const MIN_UNMAPPED_MANEUVER_DURATION_SECONDS = 8;
const EARTH_RADIUS_METERS = 6_371_008.8;

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

function buildRoutingNodes(nodes, geometry, dwellTimeSeconds) {
  const routingNodes = [{
    ...nodes[0],
    publicSegmentIndex: null,
    pauseDurationInSeconds: 0
  }];
  let anchorCount = 0;

  for (let segmentIndex = 0; segmentIndex < nodes.length - 1; segmentIndex += 1) {
    const from = nodes[segmentIndex];
    const to = nodes[segmentIndex + 1];
    const segmentLength = to.distanceAlongRoute - from.distanceAlongRoute;
    const partCount = Math.max(
      1,
      Math.ceil(segmentLength / MAX_RECONSTRUCTION_LEG_METERS)
    );

    for (let partIndex = 1; partIndex < partCount; partIndex += 1) {
      const distanceAlongRoute = from.distanceAlongRoute
        + segmentLength * partIndex / partCount;
      const point = pointAlongRoute(geometry, distanceAlongRoute);

      routingNodes.push({
        type: "route-anchor",
        lat: point.lat,
        lng: point.lng,
        providerCoordinate: { lat: point.lat, lng: point.lng },
        distanceAlongRoute: point.distanceAlongRoute,
        publicSegmentIndex: segmentIndex,
        pauseDurationInSeconds: 0
      });
      anchorCount += 1;
    }

    routingNodes.push({
      ...to,
      publicSegmentIndex: segmentIndex,
      pauseDurationInSeconds: segmentIndex < nodes.length - 2 && to.type === "station"
        ? dwellTimeSeconds
        : 0
    });
  }

  return { routingNodes, anchorCount };
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

function offsetRouteCoordinate(geometry, distanceAlongRoute, offsetMeters) {
  const point = pointAlongRoute(geometry, distanceAlongRoute);

  if (offsetMeters === 0) {
    return { lat: point.lat, lng: point.lng };
  }

  const before = pointAlongRoute(geometry, distanceAlongRoute - 15);
  const after = pointAlongRoute(geometry, distanceAlongRoute + 15);
  const projectedBefore = geometry.projector.project(before);
  const projectedAfter = geometry.projector.project(after);
  const east = projectedAfter.x - projectedBefore.x;
  const north = projectedAfter.y - projectedBefore.y;
  const length = Math.hypot(east, north);

  if (length < 1) {
    return { lat: point.lat, lng: point.lng };
  }

  const rightEast = north / length * offsetMeters;
  const rightNorth = -east / length * offsetMeters;
  const latitudeRadians = point.lat * Math.PI / 180;

  return {
    lat: point.lat + rightNorth / EARTH_RADIUS_METERS * 180 / Math.PI,
    lng: point.lng
      + rightEast / (EARTH_RADIUS_METERS * Math.cos(latitudeRadians))
        * 180 / Math.PI
  };
}

function shiftPathRight(points, offsetMeters) {
  if (offsetMeters === 0) {
    return points.map(point => ({ ...point }));
  }

  const centerLatitude = points.reduce((sum, point) => sum + point.lat, 0) / points.length;
  const cosine = Math.cos(centerLatitude * Math.PI / 180);

  return points.map((point, index) => {
    const before = points[Math.max(0, index - 1)];
    const after = points[Math.min(points.length - 1, index + 1)];
    const east = (after.lng - before.lng) * Math.PI / 180
      * EARTH_RADIUS_METERS * cosine;
    const north = (after.lat - before.lat) * Math.PI / 180
      * EARTH_RADIUS_METERS;
    const length = Math.hypot(east, north);

    if (length < 1) {
      return { ...point };
    }

    const rightEast = north / length * offsetMeters;
    const rightNorth = -east / length * offsetMeters;

    return {
      lat: point.lat + rightNorth / EARTH_RADIUS_METERS * 180 / Math.PI,
      lng: point.lng
        + rightEast / (EARTH_RADIUS_METERS * cosine) * 180 / Math.PI
    };
  });
}

function coordinateForRoutingNode(node, geometry, laneOffsetMeters) {
  if (laneOffsetMeters === 0) {
    return node.providerCoordinate;
  }

  return offsetRouteCoordinate(geometry, node.distanceAlongRoute, laneOffsetMeters);
}

function createTomTomPayload(chunk, geometry, departureTime, laneOffsetMeters = 0) {
  const first = chunk.nodes[0];
  const last = chunk.nodes.at(-1);
  const intermediate = chunk.nodes.slice(1, -1);
  const routePlanningLocations = {
    origin: pointGeoJson(coordinateForRoutingNode(first, geometry, laneOffsetMeters)),
    destination: pointGeoJson(coordinateForRoutingNode(last, geometry, laneOffsetMeters))
  };

  if (intermediate.length) {
    routePlanningLocations.waypoints = {
      type: "MultiPoint",
      coordinates: intermediate.map(node => {
        const coordinate = coordinateForRoutingNode(node, geometry, laneOffsetMeters);

        return [coordinate.lng, coordinate.lat];
      })
    };
  }

  const legs = chunk.nodes.slice(1).map((node, index, arrivals) => {
    const previousNode = chunk.nodes[index];
    const originalLegPath = sliceRouteGeometry(
      geometry,
      previousNode.distanceAlongRoute,
      node.distanceAlongRoute
    );
    const legPath = shiftPathRight(originalLegPath, laneOffsetMeters);
    const start = coordinateForRoutingNode(previousNode, geometry, laneOffsetMeters);
    const end = coordinateForRoutingNode(node, geometry, laneOffsetMeters);

    legPath[0] = start;
    legPath[legPath.length - 1] = end;
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

    if (node.pauseDurationInSeconds > 0) {
      leg.routeStop = {
        pauseDurationInSeconds: node.pauseDurationInSeconds
      };
    }

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

function pathCoordinates(path, legIndex) {
  if (
    path?.type !== "LineString"
    || !Array.isArray(path.coordinates)
    || path.coordinates.length < 2
  ) {
    throw new AppError(
      502,
      "TOMTOM_MALFORMED_RESPONSE",
      "TomTom returned a route leg without usable geometry.",
      { legIndex }
    );
  }

  return path.coordinates.map((coordinate, pointIndex) => {
    const lng = coordinate?.[0];
    const lat = coordinate?.[1];

    if (
      !Array.isArray(coordinate)
      || coordinate.length !== 2
      || !Number.isFinite(lat)
      || !Number.isFinite(lng)
    ) {
      throw new AppError(
        502,
        "TOMTOM_MALFORMED_RESPONSE",
        "TomTom returned an invalid route-leg coordinate.",
        { legIndex, pointIndex }
      );
    }

    return { lat, lng };
  });
}

function geometryFromPoints(points, legIndex) {
  const line = `LINESTRING (${points.map(point => {
    return `${point.lng} ${point.lat}`;
  }).join(", ")})`;

  try {
    return buildRouteGeometry(line);
  } catch {
    throw new AppError(
      502,
      "TOMTOM_MALFORMED_RESPONSE",
      "TomTom returned invalid route-leg geometry.",
      { legIndex }
    );
  }
}

function percentile(values, fraction) {
  const sorted = [...values].sort((first, second) => first - second);
  const index = Math.max(0, Math.ceil(sorted.length * fraction) - 1);

  return sorted[index] ?? 0;
}

function distanceDistribution(source, target) {
  const spacing = Math.min(15, Math.max(3, source.totalLength / 10));
  const distances = resampleRoute(source, spacing).map(point => {
    return findRoutePositionCandidates(target, point).reduce((best, match) => {
      return Math.min(best, match.distanceToRoute);
    }, Infinity);
  });

  return {
    percentile95: percentile(distances, 0.95),
    maximum: Math.max(...distances)
  };
}

function roundedMetrics(metrics) {
  return Object.fromEntries(Object.entries(metrics).map(([key, value]) => {
    return [key, Math.round(value * 10) / 10];
  }));
}

function validateReconstructedLeg(requestPath, responsePath, reportedLength, legIndex) {
  const requestedPoints = pathCoordinates(requestPath, legIndex);
  const returnedPoints = pathCoordinates(responsePath, legIndex);
  const requestedGeometry = geometryFromPoints(requestedPoints, legIndex);
  const returnedGeometry = geometryFromPoints(returnedPoints, legIndex);
  const requestedToReturned = distanceDistribution(requestedGeometry, returnedGeometry);
  const returnedToRequested = distanceDistribution(returnedGeometry, requestedGeometry);
  const startOffset = haversineDistance(requestedPoints[0], returnedPoints[0]);
  const endOffset = haversineDistance(requestedPoints.at(-1), returnedPoints.at(-1));
  const referenceLength = requestedGeometry.totalLength;
  const returnedPathLength = returnedGeometry.totalLength;
  const reportedLengthDelta = Math.abs(reportedLength - referenceLength);
  const returnedPathLengthDelta = Math.abs(reportedLength - returnedPathLength);
  const allowedReportedLengthDelta = Math.max(60, referenceLength * 0.35);
  const allowedReturnedPathLengthDelta = Math.max(75, returnedPathLength * 0.25);
  const metrics = {
    referenceLengthMeters: referenceLength,
    returnedLengthMeters: reportedLength,
    returnedPathLengthMeters: returnedPathLength,
    startOffsetMeters: startOffset,
    endOffsetMeters: endOffset,
    referenceToReturnedP95Meters: requestedToReturned.percentile95,
    referenceToReturnedMaxMeters: requestedToReturned.maximum,
    returnedToReferenceP95Meters: returnedToRequested.percentile95,
    returnedToReferenceMaxMeters: returnedToRequested.maximum
  };
  const deviates = startOffset > MAX_RECONSTRUCTION_ENDPOINT_OFFSET_METERS
    || endOffset > MAX_RECONSTRUCTION_ENDPOINT_OFFSET_METERS
    || requestedToReturned.percentile95 > MAX_RECONSTRUCTION_P95_DEVIATION_METERS
    || returnedToRequested.percentile95 > MAX_RECONSTRUCTION_P95_DEVIATION_METERS
    || requestedToReturned.maximum > MAX_RECONSTRUCTION_DEVIATION_METERS
    || returnedToRequested.maximum > MAX_RECONSTRUCTION_DEVIATION_METERS
    || reportedLengthDelta > allowedReportedLengthDelta
    || returnedPathLengthDelta > allowedReturnedPathLengthDelta;

  return {
    ...roundedMetrics(metrics),
    valid: !deviates
  };
}

function readTomTomLegs(data, requestLegs) {
  const route = data?.routes?.[0];
  const expectedCount = requestLegs.length;

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

    const reconstruction = validateReconstructedLeg(
      requestLegs[index].path,
      leg?.path,
      lengthInMeters,
      index
    );

    return {
      distanceMeters: lengthInMeters,
      drivingDurationSeconds: travelDurationInSeconds,
      trafficDelaySeconds: trafficDelayDurationInSeconds,
      freeFlowDurationSeconds: travelDurationInSeconds - trafficDelayDurationInSeconds,
      departureTime: summary.departureDateTime,
      arrivalTime: summary.arrivalDateTime,
      arrivalTimestamp: arrival.getTime(),
      reconstruction
    };
  });
}

function addSeconds(timestamp, seconds) {
  return new Date(timestamp + seconds * 1_000).toISOString();
}

function bearingDegrees(from, to) {
  const fromLatitude = from.lat * Math.PI / 180;
  const toLatitude = to.lat * Math.PI / 180;
  const longitudeDelta = (to.lng - from.lng) * Math.PI / 180;
  const y = Math.sin(longitudeDelta) * Math.cos(toLatitude);
  const x = Math.cos(fromLatitude) * Math.sin(toLatitude)
    - Math.sin(fromLatitude) * Math.cos(toLatitude) * Math.cos(longitudeDelta);

  return (Math.atan2(y, x) * 180 / Math.PI + 360) % 360;
}

function bearingDifference(first, second) {
  return Math.abs((second - first + 540) % 360 - 180);
}

function unmappedManeuver(nodes, geometry, failedLeg) {
  const startDistance = nodes[0].distanceAlongRoute;
  const endDistance = nodes[1].distanceAlongRoute;
  const length = endDistance - startDistance;

  if (length <= 0 || length > MAX_UNMAPPED_ROUTE_SECTION_METERS) {
    return null;
  }

  const start = pointAlongRoute(geometry, startDistance);
  const before = pointAlongRoute(geometry, startDistance - 30);
  const outgoingStart = pointAlongRoute(
    geometry,
    startDistance + Math.min(5, length * 0.2)
  );
  const outgoingEnd = pointAlongRoute(
    geometry,
    startDistance + Math.min(35, length)
  );
  const incomingLength = haversineDistance(before, start);
  const outgoingLength = haversineDistance(outgoingStart, outgoingEnd);
  const turnAngle = incomingLength >= 5 && outgoingLength >= 5
    ? bearingDifference(
        bearingDegrees(before, start),
        bearingDegrees(outgoingStart, outgoingEnd)
      )
    : 0;
  const requiredTurnAngle = length <= MAX_UNMAPPED_MANEUVER_METERS
    ? MIN_UNMAPPED_MANEUVER_TURN_DEGREES
    : MIN_LONG_UNMAPPED_SECTION_TURN_DEGREES;
  const meaningfulTurn = turnAngle >= requiredTurnAngle;
  const returnedLength = failedLeg?.reconstruction?.returnedLengthMeters;
  const grossMismatch = failedLeg === null
    || Math.abs(returnedLength - length) > Math.max(100, length * 0.25);

  if (!meaningfulTurn || !grossMismatch) {
    return null;
  }

  return {
    length,
    turnAngle,
    startDistanceAlongRoute: startDistance,
    endDistanceAlongRoute: endDistance
  };
}

function estimatedManeuverLeg(maneuver, departureTime, failedLeg) {
  const parsedDeparture = Date.parse(departureTime);
  const departureTimestamp = Number.isNaN(parsedDeparture)
    ? Date.now()
    : parsedDeparture;
  const failedSpeed = failedLeg?.distanceMeters > 0
    && failedLeg?.drivingDurationSeconds > 0
    ? failedLeg.distanceMeters / failedLeg.drivingDurationSeconds
    : UNMAPPED_MANEUVER_SPEED_METERS_PER_SECOND;
  const estimatedSpeed = Math.min(13.9, Math.max(1, failedSpeed));
  const minimumDuration = maneuver.length <= MAX_UNMAPPED_MANEUVER_METERS
    ? MIN_UNMAPPED_MANEUVER_DURATION_SECONDS
    : 1;
  const duration = Math.ceil(Math.max(
    minimumDuration,
    maneuver.length / estimatedSpeed
  ));
  const trafficRatio = failedLeg?.drivingDurationSeconds > 0
    ? failedLeg.trafficDelaySeconds / failedLeg.drivingDurationSeconds
    : 0;
  const trafficDelay = Math.min(duration, Math.round(duration * trafficRatio));
  const arrivalTimestamp = departureTimestamp + duration * 1_000;

  return {
    distanceMeters: maneuver.length,
    drivingDurationSeconds: duration,
    trafficDelaySeconds: trafficDelay,
    freeFlowDurationSeconds: duration - trafficDelay,
    departureTime: new Date(departureTimestamp).toISOString(),
    arrivalTime: new Date(arrivalTimestamp).toISOString(),
    arrivalTimestamp,
    estimatedManeuverDurationSeconds: duration,
    reconstruction: {
      valid: true,
      estimated: true,
      referenceLengthMeters: maneuver.length,
      returnedLengthMeters: maneuver.length,
      returnedPathLengthMeters: maneuver.length,
      startOffsetMeters: 0,
      endOffsetMeters: 0,
      referenceToReturnedP95Meters: 0,
      referenceToReturnedMaxMeters: 0,
      returnedToReferenceP95Meters: 0,
      returnedToReferenceMaxMeters: 0
    }
  };
}

function totalFromSegments(segments) {
  const total = segments.reduce((result, segment) => {
    result.distanceMeters += segment.distanceMeters;
    result.drivingDurationSeconds += segment.drivingDurationSeconds;
    result.dwellDurationSeconds += segment.dwellAfterArrivalSeconds;
    result.freeFlowDurationSeconds += segment.freeFlowDurationSeconds;
    result.trafficDelaySeconds += segment.trafficDelaySeconds;
    result.estimatedManeuverDurationSeconds += segment.estimatedManeuverDurationSeconds ?? 0;
    return result;
  }, {
    distanceMeters: 0,
    drivingDurationSeconds: 0,
    dwellDurationSeconds: 0,
    freeFlowDurationSeconds: 0,
    trafficDelaySeconds: 0,
    estimatedManeuverDurationSeconds: 0
  });

  total.estimatedDurationSeconds = total.drivingDurationSeconds + total.dwellDurationSeconds;
  total.departureTime = segments[0].departureTime;
  total.arrivalTime = segments.at(-1).arrivalTime;

  if (total.estimatedManeuverDurationSeconds === 0) {
    delete total.estimatedManeuverDurationSeconds;
  }

  return total;
}

function createPublicSegments(nodes, dwellTimeSeconds) {
  return nodes.slice(0, -1).map((node, index) => ({
    index,
    from: publicNode(node),
    to: publicNode(nodes[index + 1]),
    distanceMeters: 0,
    drivingDurationSeconds: 0,
    freeFlowDurationSeconds: 0,
    trafficDelaySeconds: 0,
    estimatedManeuverDurationSeconds: 0,
    dwellAfterArrivalSeconds: index === nodes.length - 2 ? 0 : dwellTimeSeconds,
    departureTime: null,
    arrivalTime: null,
    reconstruction: {
      providerLegCount: 0,
      referenceLengthMeters: 0,
      returnedLengthMeters: 0,
      maximumDeviationMeters: 0,
      maximumP95DeviationMeters: 0,
      estimatedManeuverCount: 0
    }
  }));
}

function addProviderLeg(segment, leg) {
  segment.distanceMeters += leg.distanceMeters;
  segment.drivingDurationSeconds += leg.drivingDurationSeconds;
  segment.freeFlowDurationSeconds += leg.freeFlowDurationSeconds;
  segment.trafficDelaySeconds += leg.trafficDelaySeconds;
  segment.estimatedManeuverDurationSeconds += leg.estimatedManeuverDurationSeconds ?? 0;
  segment.departureTime ??= leg.departureTime;
  segment.arrivalTime = leg.arrivalTime;
  segment.reconstruction.providerLegCount += leg.reconstruction.estimated ? 0 : 1;
  segment.reconstruction.estimatedManeuverCount += leg.reconstruction.estimated ? 1 : 0;
  segment.reconstruction.referenceLengthMeters += leg.reconstruction.referenceLengthMeters;
  segment.reconstruction.returnedLengthMeters += leg.reconstruction.returnedLengthMeters;
  segment.reconstruction.maximumDeviationMeters = Math.max(
    segment.reconstruction.maximumDeviationMeters,
    leg.reconstruction.referenceToReturnedMaxMeters,
    leg.reconstruction.returnedToReferenceMaxMeters
  );
  segment.reconstruction.maximumP95DeviationMeters = Math.max(
    segment.reconstruction.maximumP95DeviationMeters,
    leg.reconstruction.referenceToReturnedP95Meters,
    leg.reconstruction.returnedToReferenceP95Meters
  );
}

function finalizePublicSegments(segments) {
  return segments.map(segment => {
    if (!segment.departureTime || !segment.arrivalTime) {
      throw new AppError(
        502,
        "TOMTOM_MALFORMED_RESPONSE",
        "TomTom did not return timing data for an IETT stop interval.",
        { segmentIndex: segment.index }
      );
    }

    const result = {
      ...segment,
      elapsedUntilNextDepartureSeconds: segment.drivingDurationSeconds
        + segment.dwellAfterArrivalSeconds
    };

    if (result.estimatedManeuverDurationSeconds === 0) {
      delete result.estimatedManeuverDurationSeconds;
    }

    return result;
  });
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

  async function calculateChunk(chunk, geometry, departureTime) {
    let attemptCount = 0;
    const repairs = [];
    const subdivisions = [];
    const estimatedManeuvers = [];

    async function callTomTom(payload) {
      for (let retry = 0; retry <= 2; retry += 1) {
        attemptCount += 1;

        try {
          return await tomTomClient.calculateRoute(payload);
        } catch (error) {
          const retryAfterSeconds = Number(error?.details?.retryAfter);
          const canRetry = error?.code === "TOMTOM_RATE_LIMITED"
            && Number.isFinite(retryAfterSeconds)
            && retryAfterSeconds > 0
            && retryAfterSeconds <= 5
            && retry < 2;

          if (!canRetry) {
            throw error;
          }

          await new Promise(resolve => {
            setTimeout(resolve, retryAfterSeconds * 1_000);
          });
        }
      }

      throw new AppError(429, "TOMTOM_RATE_LIMITED", "TomTom rate limited the request.");
    }

    async function repairLeg(nodes, legDepartureTime, failedLeg = null) {
      const legChunk = { nodes, startIndex: 0 };
      const referencePayload = createTomTomPayload(
        legChunk,
        geometry,
        legDepartureTime
      );
      let lastReconstruction;
      let lastError;
      const maneuver = unmappedManeuver(nodes, geometry, failedLeg);

      function acceptManeuverEstimate() {
        const leg = estimatedManeuverLeg(maneuver, legDepartureTime, failedLeg);

        estimatedManeuvers.push({
          publicSegmentIndex: nodes[1].publicSegmentIndex,
          ...maneuver,
          durationSeconds: leg.drivingDurationSeconds
        });

        return [{
          ...leg,
          publicSegmentIndex: nodes[1].publicSegmentIndex
        }];
      }

      if (maneuver && maneuver.length <= MAX_UNMAPPED_MANEUVER_METERS) {
        return acceptManeuverEstimate();
      }

      for (const laneOffsetMeters of RECONSTRUCTION_LANE_OFFSETS_METERS.slice(1)) {
        const payload = createTomTomPayload(
          legChunk,
          geometry,
          legDepartureTime,
          laneOffsetMeters
        );

        try {
          const data = await callTomTom(payload);
          const [leg] = readTomTomLegs(data, referencePayload.legs);

          lastReconstruction = leg.reconstruction;

          if (!leg.reconstruction.valid) {
            continue;
          }

          repairs.push({
            publicSegmentIndex: nodes[1].publicSegmentIndex,
            startDistanceAlongRoute: nodes[0].distanceAlongRoute,
            endDistanceAlongRoute: nodes[1].distanceAlongRoute,
            laneOffsetMeters
          });

          return [{
            ...leg,
            publicSegmentIndex: nodes[1].publicSegmentIndex
          }];
        } catch (error) {
          if (error?.code !== "IETT_ROUTE_RECONSTRUCTION_FAILED") {
            throw error;
          }

          lastError = error;
        }
      }

      if (maneuver) {
        return acceptManeuverEstimate();
      }

      const legLength = nodes[1].distanceAlongRoute - nodes[0].distanceAlongRoute;

      if (legLength > MIN_REPAIR_SPLIT_METERS) {
        const middleDistance = nodes[0].distanceAlongRoute + legLength / 2;
        const middlePoint = pointAlongRoute(geometry, middleDistance);
        const middleNode = {
          type: "route-anchor",
          lat: middlePoint.lat,
          lng: middlePoint.lng,
          providerCoordinate: { lat: middlePoint.lat, lng: middlePoint.lng },
          distanceAlongRoute: middlePoint.distanceAlongRoute,
          publicSegmentIndex: nodes[1].publicSegmentIndex,
          pauseDurationInSeconds: 0
        };

        subdivisions.push({
          publicSegmentIndex: nodes[1].publicSegmentIndex,
          startDistanceAlongRoute: nodes[0].distanceAlongRoute,
          endDistanceAlongRoute: nodes[1].distanceAlongRoute,
          splitDistanceAlongRoute: middlePoint.distanceAlongRoute
        });

        const firstLegs = await calculateRange({
          startIndex: 0,
          nodes: [nodes[0], middleNode]
        }, legDepartureTime);
        const secondDepartureTime = addSeconds(
          firstLegs.at(-1).arrivalTimestamp,
          middleNode.pauseDurationInSeconds
        );
        const secondLegs = await calculateRange({
          startIndex: 0,
          nodes: [middleNode, nodes[1]]
        }, secondDepartureTime);

        return [...firstLegs, ...secondLegs];
      }

      throw new AppError(
        502,
        "IETT_ROUTE_RECONSTRUCTION_FAILED",
        "TomTom could not reconstruct the IETT geometry accurately.",
        {
          attemptedLaneOffsetsMeters: RECONSTRUCTION_LANE_OFFSETS_METERS,
          publicSegmentIndex: nodes[1].publicSegmentIndex,
          startDistanceAlongRoute: nodes[0].distanceAlongRoute,
          endDistanceAlongRoute: nodes[1].distanceAlongRoute,
          ...(lastReconstruction ? { lastReconstruction } : {}),
          ...(lastError?.code ? { lastErrorCode: lastError.code } : {})
        }
      );
    }

    async function calculateRange(range, rangeDepartureTime) {
      const referencePayload = createTomTomPayload(
        range,
        geometry,
        rangeDepartureTime
      );
      let legs;

      try {
        const data = await callTomTom(referencePayload);
        legs = readTomTomLegs(data, referencePayload.legs).map((leg, index) => ({
          ...leg,
          publicSegmentIndex: range.nodes[index + 1].publicSegmentIndex
        }));
      } catch (error) {
        if (error?.code !== "IETT_ROUTE_RECONSTRUCTION_FAILED") {
          throw error;
        }

        if (range.nodes.length === 2) {
          return repairLeg(range.nodes, rangeDepartureTime);
        }

        const middleIndex = Math.floor((range.nodes.length - 1) / 2);
        const firstRange = {
          startIndex: range.startIndex,
          nodes: range.nodes.slice(0, middleIndex + 1)
        };
        const secondRange = {
          startIndex: range.startIndex + middleIndex,
          nodes: range.nodes.slice(middleIndex)
        };
        const firstLegs = await calculateRange(firstRange, rangeDepartureTime);
        const secondDepartureTime = addSeconds(
          firstLegs.at(-1).arrivalTimestamp,
          range.nodes[middleIndex].pauseDurationInSeconds
        );
        const secondLegs = await calculateRange(secondRange, secondDepartureTime);

        return [...firstLegs, ...secondLegs];
      }

      const invalidIndex = legs.findIndex(leg => !leg.reconstruction.valid);

      if (invalidIndex === -1) {
        return legs;
      }

      const validPrefix = legs.slice(0, invalidIndex);
      const invalidDepartureTime = invalidIndex === 0
        ? legs[invalidIndex].departureTime
        : addSeconds(
            validPrefix.at(-1).arrivalTimestamp,
            range.nodes[invalidIndex].pauseDurationInSeconds
          );
      const repairedLegs = await repairLeg(
        range.nodes.slice(invalidIndex, invalidIndex + 2),
        invalidDepartureTime,
        legs[invalidIndex]
      );
      const repairedLastLeg = repairedLegs.at(-1);
      const accepted = [...validPrefix, ...repairedLegs];

      if (invalidIndex === range.nodes.length - 2) {
        return accepted;
      }

      const suffixStartIndex = invalidIndex + 1;
      const suffix = {
        startIndex: range.startIndex + suffixStartIndex,
        nodes: range.nodes.slice(suffixStartIndex)
      };
      const suffixDepartureTime = addSeconds(
        repairedLastLeg.arrivalTimestamp,
        range.nodes[suffixStartIndex].pauseDurationInSeconds
      );
      const suffixLegs = await calculateRange(suffix, suffixDepartureTime);

      return [...accepted, ...suffixLegs];
    }

    const legs = await calculateRange(chunk, departureTime);

    return { legs, attemptCount, repairs, subdivisions, estimatedManeuvers };
  }

  async function calculate(routeCode, options) {
    const routeData = await iettClient.getRoutePin(routeCode);
    const record = routeRecord(routeData, routeCode);
    const geometry = buildRouteGeometry(record.line);
    const matchedStops = addStationSequenceNumbers(
      matchStopsToRoute(record.stationPlaces, geometry)
    );
    const nodes = selectRouteNodes(matchedStops, geometry, options);
    const { routingNodes, anchorCount } = buildRoutingNodes(
      nodes,
      geometry,
      options.dwellTimeSeconds
    );
    const chunks = chunkRouteNodes(routingNodes);
    const segmentAccumulators = createPublicSegments(nodes, options.dwellTimeSeconds);
    const reconstructionRepairs = [];
    const reconstructionSubdivisions = [];
    const estimatedManeuvers = [];
    let upstreamRequestCount = 0;
    let departureTime = options.departureTime;

    for (let chunkIndex = 0; chunkIndex < chunks.length; chunkIndex += 1) {
      const chunk = chunks[chunkIndex];
      const isLastChunk = chunkIndex === chunks.length - 1;
      const calculatedChunk = await calculateChunk(
        chunk,
        geometry,
        departureTime
      );
      const { legs } = calculatedChunk;

      upstreamRequestCount += calculatedChunk.attemptCount;
      reconstructionRepairs.push(...calculatedChunk.repairs);
      reconstructionSubdivisions.push(...calculatedChunk.subdivisions);
      estimatedManeuvers.push(...calculatedChunk.estimatedManeuvers);

      for (let legIndex = 0; legIndex < legs.length; legIndex += 1) {
        const leg = legs[legIndex];
        const segment = segmentAccumulators[leg.publicSegmentIndex];

        addProviderLeg(segment, leg);
      }

      if (!isLastChunk) {
        departureTime = addSeconds(
          legs.at(-1).arrivalTimestamp,
          chunk.nodes.at(-1).pauseDurationInSeconds
        );
      }
    }

    const segmentsWithReconstruction = finalizePublicSegments(segmentAccumulators);
    const segments = segmentsWithReconstruction.map(({ reconstruction, ...segment }) => segment);

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

    if (estimatedManeuvers.length) {
      result.routingQuality = "validated-with-iett-maneuver-estimate";
      result.warnings = [{
        code: "UNMAPPED_IETT_MANEUVER_ESTIMATED",
        message: "TomTom could not represent a bus-only IETT section, so that section was estimated from the IETT geometry.",
        count: estimatedManeuvers.length
      }];
    } else {
      result.routingQuality = "tomtom-geometry-validated";
    }

    if (options.debug) {
      result.debug = {
        chunkCount: chunks.length,
        upstreamRequestCount,
        reconstructionRepairs,
        reconstructionSubdivisions,
        estimatedManeuvers,
        routingAnchorCount: anchorCount,
        routingNodeCount: routingNodes.length,
        maximumReconstructionLegMeters: MAX_RECONSTRUCTION_LEG_METERS,
        reconstruction: segmentsWithReconstruction.map(segment => ({
          segmentIndex: segment.index,
          from: segment.from.type === "station" ? segment.from.name : segment.from.type,
          to: segment.to.type === "station" ? segment.to.name : segment.to.type,
          ...segment.reconstruction
        })),
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
