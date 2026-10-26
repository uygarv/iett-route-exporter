import { AppError } from "../shared/errors.js";
import { buildGeometryFromCoordinates, haversineDistance, pointAlongRoute } from "./geometry.js";
import { sliceRouteGeometry } from "./timing.js";
import { isTomTomAlternativeLeg } from "./tomtom-controls.js";
import { publicNode } from "./travel-time-result.js";

const MAX_UNMAPPED_MANEUVER_METERS = 75;
const MIN_UNMAPPED_MANEUVER_TURN_DEGREES = 60;
const UNMAPPED_MANEUVER_SPEED_METERS_PER_SECOND = 2.5;
const MIN_UNMAPPED_MANEUVER_DURATION_SECONDS = 8;

function pointGeoJson(coordinate) {
  return {
    type: "Point",
    coordinates: [coordinate.lng, coordinate.lat]
  };
}

export function createTomTomPayload(chunk, geometry, departureTime, plan) {
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
        const coordinate = node.providerCoordinate;

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
    const legPath = originalLegPath;
    const start = previousNode.providerCoordinate;
    const end = node.providerCoordinate;

    legPath[0] = start;
    legPath[legPath.length - 1] = end;
    const finalArrivalInChunk = index === arrivals.length - 1;
    const leg = plan && isTomTomAlternativeLeg(plan, previousNode.distanceAlongRoute, node.distanceAlongRoute)
      ? {} : { path: {
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
  try {
    return buildGeometryFromCoordinates(points.map(point => [point.lng, point.lat]));
  } catch {
    throw new AppError(
      502,
      "TOMTOM_MALFORMED_RESPONSE",
      "TomTom returned invalid route-leg geometry.",
      { legIndex }
    );
  }
}

export function readTomTomLegs(data, requestLegs) {
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

    const points = pathCoordinates(leg?.path, index);
    const returnedGeometry = geometryFromPoints(points, index);
    const reconstruction = {
      valid: true, referenceLengthMeters: 0, returnedLengthMeters: lengthInMeters,
      returnedPathLengthMeters: returnedGeometry.totalLength,
      referenceToReturnedP95Meters: 0, referenceToReturnedMaxMeters: 0,
      returnedToReferenceP95Meters: 0, returnedToReferenceMaxMeters: 0
    };

    return {
      path: leg.path,
      distanceMeters: lengthInMeters,
      drivingDurationSeconds: travelDurationInSeconds,
      liveTrafficDelaySeconds: trafficDelayDurationInSeconds,
      departureTime: summary.departureDateTime,
      arrivalTime: summary.arrivalDateTime,
      arrivalTimestamp: arrival.getTime(),
      reconstruction
    };
  });
}

export function addSeconds(timestamp, seconds) {
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

export function unmappedManeuver(nodes, geometry, failedLeg) {
  const startDistance = nodes[0].distanceAlongRoute;
  const endDistance = nodes[1].distanceAlongRoute;
  const length = endDistance - startDistance;

  if (length <= 0 || length > MAX_UNMAPPED_MANEUVER_METERS) {
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
  const meaningfulTurn = turnAngle >= MIN_UNMAPPED_MANEUVER_TURN_DEGREES;
  const returnedLength = failedLeg.reconstruction.returnedLengthMeters;
  const grossMismatch = Math.abs(returnedLength - length) > Math.max(100, length * 0.25);

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

export function estimatedManeuverLeg(maneuver, departureTime, failedLeg) {
  const parsedDeparture = Date.parse(departureTime);
  const departureTimestamp = Number.isNaN(parsedDeparture)
    ? Date.now()
    : parsedDeparture;
  const failedSpeed = failedLeg?.distanceMeters > 0
    && failedLeg?.drivingDurationSeconds > 0
    ? failedLeg.distanceMeters / failedLeg.drivingDurationSeconds
    : UNMAPPED_MANEUVER_SPEED_METERS_PER_SECOND;
  const estimatedSpeed = Math.min(13.9, Math.max(1, failedSpeed));
  const duration = Math.ceil(Math.max(
    MIN_UNMAPPED_MANEUVER_DURATION_SECONDS,
    maneuver.length / estimatedSpeed
  ));
  const trafficRatio = failedLeg?.drivingDurationSeconds > 0
    ? failedLeg.liveTrafficDelaySeconds / failedLeg.drivingDurationSeconds
    : 0;
  const trafficDelay = Math.min(duration, Math.round(duration * trafficRatio));
  const arrivalTimestamp = departureTimestamp + duration * 1_000;

  return {
    distanceMeters: maneuver.length,
    drivingDurationSeconds: duration,
    liveTrafficDelaySeconds: trafficDelay,
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

export function totalFromSegments(segments) {
  const total = segments.reduce((result, segment) => {
    result.distanceMeters += segment.distanceMeters;
    result.drivingDurationSeconds += segment.drivingDurationSeconds;
    result.dwellDurationSeconds += segment.dwellAfterArrivalSeconds;
    result.liveTrafficDelaySeconds += segment.liveTrafficDelaySeconds;
    result.estimatedManeuverDurationSeconds += segment.estimatedManeuverDurationSeconds ?? 0;
    return result;
  }, {
    distanceMeters: 0,
    drivingDurationSeconds: 0,
    dwellDurationSeconds: 0,
    liveTrafficDelaySeconds: 0,
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

export function createPublicSegments(nodes, dwellTimeSeconds) {
  return nodes.slice(0, -1).map((node, index) => ({
    index,
    from: publicNode(node),
    to: publicNode(nodes[index + 1]),
    distanceMeters: 0,
    drivingDurationSeconds: 0,
    liveTrafficDelaySeconds: 0,
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

export function addProviderLeg(segment, leg) {
  segment.distanceMeters += leg.distanceMeters;
  segment.drivingDurationSeconds += leg.drivingDurationSeconds;
  segment.stopTimingSource = segment.stopTimingSource && segment.stopTimingSource !== leg.stopTimingSource
    ? "mixed-interpolation" : leg.stopTimingSource;
  segment.liveTrafficDelaySeconds += leg.liveTrafficDelaySeconds;
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

export function finalizePublicSegments(segments) {
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

