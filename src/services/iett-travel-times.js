import { TOMTOM_HTTP_ATTEMPTS } from "../clients/tomtom-scheduler.js";
import { AppError } from "../shared/errors.js";
import {
  buildRouteGeometry,
  haversineDistance,
  pointAlongRoute
} from "../routing/geometry.js";
import { sliceRouteGeometry } from "../routing/timing.js";
import {
  createTomTomControls, isTomTomAlternativeLeg, localTomTomPlan, waypointOnlyTomTomPlan
} from "../routing/tomtom-controls.js";
import { evaluateTomTomLocalAlternative } from "../routing/tomtom-local-alternative.js";
import { distributeTomTomLegs } from "../routing/tomtom-stop-times.js";
import { createGeometryMatcher, compareGeometryMatches } from "../routing/geometry-match.js";
import {
  validateTravelTimeOptions, routeRecord, publicNode, cacheKey, compactGeometryMatch,
  roundSegmentDistances, createRoutePreparation, resultEnvelope
} from "./travel-time-common.js";
import { HereClient } from "../clients/here-client.js";
import { createHereRoutingService } from "./here-travel-times.js";
export { validateTravelTimeOptions } from "./travel-time-common.js";

const MAX_ROUTING_ATTEMPTS = 3;
const MAX_UNMAPPED_MANEUVER_METERS = 75;
const MAX_UNMAPPED_ROUTE_SECTION_METERS = 1_000;
const MIN_UNMAPPED_MANEUVER_TURN_DEGREES = 60;
const MIN_LONG_UNMAPPED_SECTION_TURN_DEGREES = 135;
const UNMAPPED_MANEUVER_SPEED_METERS_PER_SECOND = 2.5;
const MIN_UNMAPPED_MANEUVER_DURATION_SECONDS = 8;

function pointGeoJson(coordinate) {
  return {
    type: "Point",
    coordinates: [coordinate.lng, coordinate.lat]
  };
}

function createTomTomPayload(chunk, geometry, departureTime, plan) {
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

function totalFromSegments(segments) {
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

function createPublicSegments(nodes, dwellTimeSeconds) {
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

function addProviderLeg(segment, leg) {
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
  const matcher = createGeometryMatcher({ policy: geometryPolicy });
  const shapes = new Map();
  const preparingShapes = new Map();
  const preparation = createRoutePreparation();
  const { prepareRoute, prepareSection } = preparation;
  const hereService = createHereRoutingService({ hereClient, geometryPolicy,
    shapeCacheTtlMs, shapeCacheMaxEntries, clock });
  let cacheGeneration = 0;

  async function calculateAdaptiveRoute(nodes, geometry, options, learned) {
    let plan = { distances: learned?.distances ?? [],
      alternativeRanges: learned?.alternativeRanges ?? [], waypointOnly: learned?.waypointOnly ?? false };
    const attempts = [];
    const originalControls = createTomTomControls(nodes, geometry, options.dwellTimeSeconds);
    const referencePath = createTomTomPayload({ nodes: originalControls }, geometry, options.departureTime).legs[0].path;
    const stopDistances = nodes.map(node => node.distanceAlongRoute - nodes[0].distanceAlongRoute);
    let best;
    let reconstructionError;
    for (let attempt = 0; attempt < MAX_ROUTING_ATTEMPTS; attempt += 1) {
      const { distances } = plan;
      const controls = createTomTomControls(nodes, geometry, options.dwellTimeSeconds, distances);
      const payload = createTomTomPayload({ nodes: controls }, geometry, options.departureTime, plan);
      if (attempt === 0 && learned?.paths?.length === payload.legs.length) {
        payload.legs.forEach((leg, index) => {
          if (leg.path && learned.paths[index]) leg.path = structuredClone(learned.paths[index]);
        });
      }
      const currentAttempt = { strategy: plan.waypointOnly ? "waypoints-only"
        : plan.alternativeRanges.length ? "local-waypoints" : "reconstruction",
        learned: attempt === 0 && Boolean(learned), waypointCount: distances.length,
        distances: [...distances], httpRequestCount: 0 };
      attempts.push(currentAttempt);
      let response, legs;
      try {
        response = await tomTomClient.calculateRoute(payload);
        currentAttempt.httpRequestCount = response[TOMTOM_HTTP_ATTEMPTS] ?? 1;
        legs = readTomTomLegs(response, payload.legs);
        reconstructionError = undefined;
      } catch (error) {
        currentAttempt.httpRequestCount = error[TOMTOM_HTTP_ATTEMPTS] ?? (currentAttempt.httpRequestCount || 1);
        // Transport retries and 429 cooldowns belong exclusively to TomTomClient.
        if (error?.code !== "IETT_ROUTE_RECONSTRUCTION_FAILED") throw error;
        reconstructionError = error;
      }
      if (legs) {
        const returnedPath = { type: "LineString", coordinates: legs.flatMap((leg, index) =>
          index ? leg.path.coordinates.slice(1) : leg.path.coordinates) };
        let geometryMatch = matcher.evaluate(referencePath, returnedPath,
          legs.reduce((total, leg) => total + leg.distanceMeters, 0), stopDistances);
        const disconnected = legs.some((leg, index) => index > 0 && haversineDistance(
          { lng: legs[index - 1].path.coordinates.at(-1)[0], lat: legs[index - 1].path.coordinates.at(-1)[1] },
          { lng: leg.path.coordinates[0][0], lat: leg.path.coordinates[0][1] }
        ) > 5);
        if (disconnected) {
          geometryMatch.valid = false;
          geometryMatch.quality = "rejected";
          geometryMatch.reasons.push("DISCONNECTED_PROVIDER_LEGS");
        }
        geometryMatch = evaluateTomTomLocalAlternative({ matcher, match: geometryMatch,
          nodes, geometry, returnedPath, plan });
        const { stopProgressMeters, ...publicGeometryMatch } = geometryMatch;
        geometryMatch = publicGeometryMatch;
        const estimatedManeuvers = [];
        if (!geometryMatch.valid && legs.length === 1 && nodes.length === 2) {
          legs[0].reconstruction = geometryMatch;
          const maneuver = unmappedManeuver(nodes, geometry, legs[0]);
          if (maneuver && maneuver.length <= MAX_UNMAPPED_MANEUVER_METERS) {
            estimatedManeuvers.push({ providerLegIndex: 0, ...maneuver });
            legs[0] = { ...estimatedManeuverLeg(maneuver, legs[0].departureTime, legs[0]), path: referencePath };
          }
        }
        const candidate = { legs, geometryMatch, controls, distances: [...distances],
          plan, stopProgressMeters, response, estimatedManeuvers };
        if (!best || compareGeometryMatches(geometryMatch, best.geometryMatch) < 0) best = candidate;
        if (geometryMatch.valid || estimatedManeuvers.length) {
          best = candidate;
          break;
        }

      }
      if (attempt + 1 === MAX_ROUTING_ATTEMPTS) break;
      if (attempt === 0 && learned) {
        // A changed road network or closure may invalidate a previously matched
        // path. Retry the original trace without stale controls, leaving the
        // final attempt available for a local repair or waypoint-only fallback.
        plan = { distances: [], alternativeRanges: [], waypointOnly: false };
        continue;
      }
      const next = best ? localTomTomPlan(nodes, geometry, best.geometryMatch, plan, attempt > 0)
        : plan.waypointOnly ? localTomTomPlan(nodes, geometry, undefined, plan, true)
          : waypointOnlyTomTomPlan(nodes, geometry);
      if (JSON.stringify(next) === JSON.stringify(plan)) break;
      plan = next;
    }
    if (best?.geometryMatch.valid || best?.estimatedManeuvers.length) {
      // Public stop metrics use the same whole-section decision, without
      // applying fresh thresholds to artificial provider-leg boundaries.
      best.legs.forEach(leg => { if (!leg.reconstruction.estimated) leg.reconstruction = {
        ...best.geometryMatch,
        referenceLengthMeters: leg.distanceMeters,
        returnedLengthMeters: leg.distanceMeters
      }; });
      return { ...best, attempts,
        legs: distributeTomTomLegs(best.legs, best.controls, nodes,
          best.estimatedManeuvers.length ? null : best.response.routes[0].progressPoints, best.stopProgressMeters),
        providerPaths: best.legs.map(leg => leg.path) };
    }
    throw new AppError(502, "IETT_ROUTE_RECONSTRUCTION_FAILED",
      "TomTom could not match the IETT route within the configured geometry limits.", {
        upstreamRequestCount: attempts.reduce((sum, item) => sum + item.httpRequestCount, 0),
        maximumUpstreamRequestCount: MAX_ROUTING_ATTEMPTS * 2,
        geometryAttemptCount: attempts.length, maximumGeometryAttemptCount: MAX_ROUTING_ATTEMPTS,
        attemptedWaypointCounts: attempts.map(attempt => attempt.waypointCount),
        ...(best ? { lastReconstruction: best.geometryMatch } : {}),
        ...(reconstructionError ? { lastErrorCode: reconstructionError.code } : {})
      });
  }

  async function calculateWithSharedShape(routeCode, prepared, nodes, options) {
    const key = JSON.stringify([routeCode, prepared.fingerprint,
      nodes.map(node => [node.stationIndex, node.distanceAlongRoute, node.providerCoordinate])]);
    function learnedShape() {
      const entry = shapes.get(key);
      if (entry && entry.expiresAt > Number(clock())) return entry;
      shapes.delete(key);
      return undefined;
    }
    if (!learnedShape() && preparingShapes.has(key)) {
      // A failed departure never poisons another departure's traffic estimate.
      await preparingShapes.get(key).catch(() => {});
    }
    const learned = learnedShape();
    const generation = cacheGeneration;
    const calculation = calculateAdaptiveRoute(nodes, prepared.geometry, options, learned).then(result => {
      if (!result.estimatedManeuvers.length && generation === cacheGeneration) {
        if (shapes.size >= shapeCacheMaxEntries) shapes.delete(shapes.keys().next().value);
        shapes.set(key, { paths: result.providerPaths.map((path, index) =>
          isTomTomAlternativeLeg(result.plan, result.controls[index].distanceAlongRoute,
            result.controls[index + 1].distanceAlongRoute) ? null : structuredClone(path)),
          distances: [...result.distances], alternativeRanges: structuredClone(result.plan.alternativeRanges),
          waypointOnly: result.plan.waypointOnly,
          expiresAt: learned?.expiresAt ?? Number(clock()) + shapeCacheTtlMs });
      }
      return result;
    }).catch(error => {
      if (error?.code === "IETT_ROUTE_RECONSTRUCTION_FAILED" && shapes.get(key) === learned) shapes.delete(key);
      throw error;
    });
    if (!learned) {
      preparingShapes.set(key, calculation);
      const forget = () => { if (preparingShapes.get(key) === calculation) preparingShapes.delete(key); };
      calculation.then(forget, forget);
    }
    return calculation;
  }

  async function calculate(routeCode, options) {
    const routeData = await iettClient.getRoutePin(routeCode);
    const record = routeRecord(routeData, routeCode);
    const prepared = prepareRoute(record, options.provider);
    const { geometry, matchedStops } = prepared;
    const { nodes } = prepareSection(prepared, options);
    if (options.provider === "here") {
      return hereService.calculate({ routeCode, prepared, nodes, options });
    }
    const calculated = await calculateWithSharedShape(routeCode, prepared, nodes, options);
    const segmentAccumulators = createPublicSegments(nodes, options.dwellTimeSeconds);
    for (const leg of calculated.legs) addProviderLeg(segmentAccumulators[leg.publicSegmentIndex], leg);
    // Bus stops remain in the public timeline, without becoming forced routing
    // locations. Count every actual intermediate stop's dwell exactly once.
    let timestamp = Date.parse(calculated.legs[0].departureTime);
    for (const segment of segmentAccumulators) {
      segment.departureTime = addSeconds(timestamp, 0);
      timestamp += segment.drivingDurationSeconds * 1_000;
      segment.arrivalTime = addSeconds(timestamp, 0);
      timestamp += segment.dwellAfterArrivalSeconds * 1_000;
    }
    const estimatedManeuvers = calculated.estimatedManeuvers;
    const segmentsWithReconstruction = finalizePublicSegments(segmentAccumulators);
    const segments = roundSegmentDistances(segmentsWithReconstruction.map(({ reconstruction, ...segment }) => segment));

    const result = {
      ...resultEnvelope({ routeCode, provider: "tomtom-orbis", options, nodes, clock }),
      total: totalFromSegments(segments),
      geometryMatch: calculated.geometryMatch,
      stopTimingSource: segments.every(segment => segment.stopTimingSource === segments[0].stopTimingSource)
        ? segments[0].stopTimingSource : "mixed-interpolation",
      segments
    };
    result.total.distanceMeters = Math.round(result.total.distanceMeters * 10) / 10;

    if (estimatedManeuvers.length) {
      result.geometryMatch = { ...result.geometryMatch, quality: "estimated", providerGeometryValid: false };
      result.routingQuality = "validated-with-iett-maneuver-estimate";
      result.warnings = [{
        code: "UNMAPPED_IETT_MANEUVER_ESTIMATED",
        message: "TomTom could not represent a bus-only IETT section, so that section was estimated from the IETT geometry.",
        count: estimatedManeuvers.length
      }];
    } else if (calculated.geometryMatch.quality === "approximate") {
      result.routingQuality = "tomtom-geometry-approximate";
      result.warnings = [calculated.geometryMatch.acceptanceBasis === "stop-preserving-local-alternative"
        ? { code: "IETT_LOCAL_ROUTE_APPROXIMATION",
          message: "Travel time uses bounded local TomTom alternatives that preserve every stop in order. See geometryMatch.alternatives." }
        : { code: "IETT_GEOMETRY_APPROXIMATION",
          message: "Travel time uses a nearby TomTom path with bounded deviations from the IETT route. See geometryMatch." }];
    } else {
      result.routingQuality = "tomtom-geometry-validated";
    }

    if (segments.some(segment => segment.stopTimingSource === "distance-interpolation")) {
      result.warnings = [...(result.warnings ?? []), {
        code: "STOP_TIMES_DISTANCE_INTERPOLATED",
        message: "TomTom progress points were unavailable; stop-level driving times were allocated by distance. The provider's total driving duration is preserved."
      }];
    }

    const fullGeometryMatch = result.geometryMatch;
    result.geometryMatch = compactGeometryMatch(fullGeometryMatch);
    if (options.debug) {
      result.debug = {
        geometryMatch: fullGeometryMatch,
        chunkCount: 1,
        upstreamRequestCount: calculated.attempts.reduce((sum, item) => sum + item.httpRequestCount, 0),
        maximumUpstreamRequestCount: MAX_ROUTING_ATTEMPTS * 2,
        geometryAttemptCount: calculated.attempts.length,
        maximumGeometryAttemptCount: MAX_ROUTING_ATTEMPTS,
        waypointStrategy: "hybrid-local-adaptive",
        waypointAttempts: calculated.attempts,
        reconstructionRepairs: calculated.attempts.slice(1),
        reconstructionSubdivisions: [],
        estimatedManeuvers,
        routingAnchorCount: calculated.controls.length - 2,
        routingNodeCount: calculated.controls.length,
        omittedStopWaypointCount: nodes.slice(1, -1).filter(node => !calculated.controls
          .some(control => Math.abs(control.distanceAlongRoute - node.distanceAlongRoute) < .01)).length,
        controlPoints: calculated.controls.slice(1, -1).map(node => ({
          lat: node.providerCoordinate.lat, lng: node.providerCoordinate.lng,
          distanceAlongRoute: node.distanceAlongRoute
        })),
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
          providerCoordinate: { ...stop.providerCoordinate },
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
    const now = Number(clock());

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

    return promise;
  }

  return {
    calculateIettRouteTimes,
    clearCache() {
      cache.clear();
      matcher.clear();
      shapes.clear();
      preparingShapes.clear();
      cacheGeneration += 1;
      preparation.clear();
      hereService.clearCache();
    }
  };
}
