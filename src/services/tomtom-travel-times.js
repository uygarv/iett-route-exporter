import { TOMTOM_HTTP_ATTEMPTS } from "../clients/tomtom-scheduler.js";
import { AppError } from "../shared/errors.js";
import { haversineDistance } from "../routing/geometry.js";
import { createTomTomControls, isTomTomAlternativeLeg, localTomTomPlan, waypointOnlyTomTomPlan } from "../routing/tomtom-controls.js";
import { evaluateLocalRouteAlternative } from "../routing/local-route-alternative.js";
import { distributeTomTomLegs } from "../routing/tomtom-stop-times.js";
import { createGeometryMatcher, compareGeometryMatches } from "../routing/geometry-match.js";
import { compactGeometryMatch, roundSegmentDistances, resultEnvelope } from "../routing/travel-time-result.js";
import {
  createTomTomPayload, readTomTomLegs, unmappedManeuver, estimatedManeuverLeg,
  totalFromSegments, createPublicSegments, addProviderLeg, finalizePublicSegments, addSeconds
} from "../routing/tomtom-route.js";

const MAX_ROUTING_ATTEMPTS = 3;

export function createTomTomRoutingService({ tomTomClient, geometryPolicy, shapeCacheTtlMs, shapeCacheMaxEntries, clock }) {
  const matcher = createGeometryMatcher({ policy: geometryPolicy });
  const shapes = new Map();
  const preparingShapes = new Map();
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
        geometryMatch = evaluateLocalRouteAlternative({ matcher, match: geometryMatch,
          nodes, geometry, returnedPath, plan });
        const { stopProgressMeters, ...publicGeometryMatch } = geometryMatch;
        geometryMatch = publicGeometryMatch;
        const estimatedManeuvers = [];
        if (!geometryMatch.valid && legs.length === 1 && nodes.length === 2) {
          legs[0].reconstruction = geometryMatch;
          const maneuver = unmappedManeuver(nodes, geometry, legs[0]);
          if (maneuver) {
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

  async function calculate({ routeCode, prepared, nodes, options }) {
    const { geometry, matchedStops } = prepared;
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
    const { attempts, controls } = calculated;
    const debug = () => ({
      geometryMatch: fullGeometryMatch,
      chunkCount: 1,
      upstreamRequestCount: attempts.reduce((sum, item) => sum + item.httpRequestCount, 0),
      maximumUpstreamRequestCount: MAX_ROUTING_ATTEMPTS * 2,
      geometryAttemptCount: attempts.length,
      maximumGeometryAttemptCount: MAX_ROUTING_ATTEMPTS,
      waypointStrategy: "hybrid-local-adaptive",
      waypointAttempts: attempts,
      reconstructionRepairs: attempts.slice(1),
      reconstructionSubdivisions: [],
      estimatedManeuvers,
      routingAnchorCount: controls.length - 2,
      routingNodeCount: controls.length,
      omittedStopWaypointCount: nodes.slice(1, -1).filter(node => !controls
        .some(control => Math.abs(control.distanceAlongRoute - node.distanceAlongRoute) < .01)).length,
      controlPoints: controls.slice(1, -1).map(node => ({
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
    });

    return { result, debug };
  }

  return {
    calculate,
    clearCache() {
      matcher.clear();
      shapes.clear();
      preparingShapes.clear();
      cacheGeneration += 1;
    }
  };
}
