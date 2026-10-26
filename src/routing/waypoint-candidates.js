import { clamp, pointAlongRoute } from "./geometry.js";

const TURN_WINDOW_METERS = 80;
const TURN_SHIFT_METERS = 110;
const TURN_PEAK_WINDOW_METERS = 90;
const TURN_DECISION_ZONE_BEFORE_METERS = 100;
const TURN_DECISION_ZONE_AFTER_METERS = 30;
const CANDIDATE_MERGE_METERS = 60;
const STATION_TURN_MIN_OFFSET_METERS = 60;
const STATION_TURN_MAX_OFFSET_METERS = 160;
const STATION_TURN_TARGET_TOLERANCE_METERS = 50;
export const STRONG_TURN_DEGREES = 55;
const MEDIUM_TURN_DEGREES = 25;
const EARTH_RADIUS_METERS = 6_371_008.8;
const LANE_SAMPLE_RADIUS_METERS = 1_200;
const MAX_STATION_OFFSET_METERS = 30;
const MAX_PROVIDER_LANE_OFFSET_METERS = 10;

function bearing(first, second, projector) {
  const start = projector.project(first);
  const end = projector.project(second);

  return Math.atan2(end.x - start.x, end.y - start.y) * 180 / Math.PI;
}

function turnAngleAt(geometry, distance) {
  const before = pointAlongRoute(geometry, distance - TURN_WINDOW_METERS);
  const center = pointAlongRoute(geometry, distance);
  const after = pointAlongRoute(geometry, distance + TURN_WINDOW_METERS);
  const incoming = bearing(before, center, geometry.projector);
  const outgoing = bearing(center, after, geometry.projector);

  return Math.abs(((outgoing - incoming + 540) % 360) - 180);
}

function turnClass(angle) {
  if (angle >= STRONG_TURN_DEGREES) {
    return "strong";
  }

  if (angle >= MEDIUM_TURN_DEGREES) {
    return "medium";
  }

  if (angle >= 10) {
    return "weak";
  }

  return "none";
}

function routeDirectionAt(geometry, distance) {
  const before = pointAlongRoute(geometry, distance - 20);
  const after = pointAlongRoute(geometry, distance + 20);
  const projectedBefore = geometry.projector.project(before);
  const projectedAfter = geometry.projector.project(after);
  const east = projectedAfter.x - projectedBefore.x;
  const north = projectedAfter.y - projectedBefore.y;
  const length = Math.hypot(east, north);

  if (length < 1) {
    return null;
  }

  return {
    east: east / length,
    north: north / length
  };
}

function signedRightOffset(geometry, distance, coordinate) {
  const direction = routeDirectionAt(geometry, distance);

  if (!direction) {
    return null;
  }

  const routePoint = pointAlongRoute(geometry, distance);
  const projectedRoute = geometry.projector.project(routePoint);
  const projectedCoordinate = geometry.projector.project(coordinate);
  const deltaEast = projectedCoordinate.x - projectedRoute.x;
  const deltaNorth = projectedCoordinate.y - projectedRoute.y;
  const rightEast = direction.north;
  const rightNorth = -direction.east;

  return deltaEast * rightEast + deltaNorth * rightNorth;
}

function buildLaneSamples(geometry, stationConstraints) {
  return stationConstraints.flatMap(station => {
    if (
      !station.rawCoordinate
      || station.distanceToRoute > MAX_STATION_OFFSET_METERS
    ) {
      return [];
    }

    const rightOffset = signedRightOffset(
      geometry,
      station.distanceAlongRoute,
      station.rawCoordinate
    );

    if (rightOffset === null || Math.abs(rightOffset) > MAX_STATION_OFFSET_METERS) {
      return [];
    }

    return [{
      distanceAlongRoute: station.distanceAlongRoute,
      rightOffset
    }];
  });
}

function localLaneOffset(candidate, laneSamples) {
  if (candidate.turnAngle >= MEDIUM_TURN_DEGREES) {
    return 0;
  }

  const localSamples = laneSamples.filter(sample => {
    return Math.abs(sample.distanceAlongRoute - candidate.distanceAlongRoute)
      <= LANE_SAMPLE_RADIUS_METERS;
  });
  const rightSideSamples = localSamples
    .filter(sample => sample.rightOffset >= 1)
    .sort((first, second) => first.rightOffset - second.rightOffset);

  if (
    rightSideSamples.length < 2
    || rightSideSamples.length / localSamples.length < 0.7
  ) {
    return 0;
  }

  const median = rightSideSamples[Math.floor(rightSideSamples.length / 2)].rightOffset;

  return clamp(median, 0, MAX_PROVIDER_LANE_OFFSET_METERS);
}

function moveRightOfRoute(geometry, candidate, offsetMeters) {
  if (offsetMeters < 1) {
    return null;
  }

  const direction = routeDirectionAt(geometry, candidate.distanceAlongRoute);

  if (!direction) {
    return null;
  }

  const rightEast = direction.north * offsetMeters;
  const rightNorth = -direction.east * offsetMeters;
  const latitudeRadians = candidate.lat * Math.PI / 180;

  return {
    lat: candidate.lat + rightNorth / EARTH_RADIUS_METERS * 180 / Math.PI,
    lng: candidate.lng
      + rightEast / (EARTH_RADIUS_METERS * Math.cos(latitudeRadians))
        * 180 / Math.PI
  };
}

export function isStrongTurnCandidate(candidate) {
  return candidate.reasons.has("post-turn")
    && candidate.turnAngle >= STRONG_TURN_DEGREES;
}

function stationForTurn(candidates, incoming) {
  if (incoming.turnAngle < MEDIUM_TURN_DEGREES) {
    return null;
  }

  const minimumDistance = incoming.turnSourceDistance
    + STATION_TURN_MIN_OFFSET_METERS;
  const maximumDistance = incoming.turnSourceDistance
    + STATION_TURN_MAX_OFFSET_METERS;

  return candidates
    .filter(candidate => candidate.reasons.has("station"))
    .filter(candidate => {
      return candidate.distanceAlongRoute >= minimumDistance
        && candidate.distanceAlongRoute <= maximumDistance
        && Math.abs(candidate.distanceAlongRoute - incoming.distanceAlongRoute)
          <= STATION_TURN_TARGET_TOLERANCE_METERS;
    })
    .sort((first, second) => {
      return Math.abs(first.distanceAlongRoute - incoming.distanceAlongRoute)
        - Math.abs(second.distanceAlongRoute - incoming.distanceAlongRoute);
    })[0] ?? null;
}

function mergeCandidate(existing, incoming) {
  const boundaryWouldAbsorbCoverage = existing.reasons.size === 1
    && existing.reasons.has("segment-boundary")
    && incoming.reasons.has("coverage");

  for (const reason of incoming.reasons) {
    existing.reasons.add(reason);
  }

  existing.nearSegmentBoundary ||= incoming.nearSegmentBoundary;
  existing.selectable ||= incoming.selectable;

  if (boundaryWouldAbsorbCoverage) {
    existing.lat = incoming.lat;
    existing.lng = incoming.lng;
    existing.distanceAlongRoute = incoming.distanceAlongRoute;
    existing.turnAngle = incoming.turnAngle;
    existing.turnSourceDistance = incoming.turnSourceDistance;
    existing.turnZoneId = incoming.turnZoneId;
    return;
  }

  if (incoming.turnAngle > existing.turnAngle) {
    existing.turnAngle = incoming.turnAngle;
    existing.turnSourceDistance = incoming.turnSourceDistance;
    existing.turnZoneId = incoming.turnZoneId;

    if (!existing.reasons.has("station")) {
      existing.distanceAlongRoute = incoming.distanceAlongRoute;
      existing.lat = incoming.lat;
      existing.lng = incoming.lng;
    }
  }
}

function addCandidate(candidates, incoming) {
  const incomingReasons = new Set(incoming.reasons);
  const incomingIsStation = incomingReasons.has("station");
  const incomingIsTurn = incomingReasons.has("post-turn");
  let existing = incomingIsTurn
    ? stationForTurn(candidates, incoming)
    : null;

  if (!existing) {
    existing = candidates.find(candidate => {
      const existingIsStation = candidate.reasons.has("station");
      const weakPostTurnWouldAbsorbCoverage = incomingReasons.has("coverage")
        && candidate.reasons.has("post-turn")
        && candidate.turnAngle < MEDIUM_TURN_DEGREES;

      if (
        incomingIsStation
        || existingIsStation
        || weakPostTurnWouldAbsorbCoverage
      ) {
        return false;
      }

      return Math.abs(candidate.distanceAlongRoute - incoming.distanceAlongRoute)
        < CANDIDATE_MERGE_METERS;
    });
  }

  if (!existing) {
    candidates.push({
      ...incoming,
      reasons: incomingReasons
    });
    return;
  }

  mergeCandidate(existing, {
    ...incoming,
    reasons: incomingReasons
  });
}

export function buildCandidates(geometry, samples, startDistance, endDistance, stationConstraints) {
  const candidates = [];
  const angles = samples.map(sample => {
    const insideTurnWindow = sample.distanceAlongRoute >= startDistance + TURN_WINDOW_METERS
      && sample.distanceAlongRoute <= endDistance - TURN_WINDOW_METERS;

    return insideTurnWindow ? turnAngleAt(geometry, sample.distanceAlongRoute) : 0;
  });

  for (const station of stationConstraints) {
    if (
      station.distanceAlongRoute <= startDistance + 30
      || station.distanceAlongRoute >= endDistance - 30
    ) {
      continue;
    }

    const routePoint = pointAlongRoute(geometry, station.distanceAlongRoute);
    const angle = turnAngleAt(geometry, routePoint.distanceAlongRoute);
    const projectedToRoute = station.projectedToRoute
      || routePoint.lat !== station.lat
      || routePoint.lng !== station.lng;

    addCandidate(candidates, {
      lat: routePoint.lat,
      lng: routePoint.lng,
      distanceAlongRoute: routePoint.distanceAlongRoute,
      turnAngle: angle,
      turnSourceDistance: null,
      turnZoneId: null,
      nearSegmentBoundary: geometry.boundaryDistances.some(boundary => {
        return Math.abs(boundary - routePoint.distanceAlongRoute)
          <= CANDIDATE_MERGE_METERS;
      }),
      stationName: station.stationName,
      stationIndex: station.stationIndex,
      distanceToRoute: station.distanceToRoute,
      projectedToRoute,
      rawCoordinate: station.rawCoordinate,
      selectable: angle >= MEDIUM_TURN_DEGREES,
      reasons: ["station"]
    });
  }

  for (let index = 0; index < samples.length; index += 1) {
    const angle = angles[index];

    if (angle < 10) {
      continue;
    }

    const distance = samples[index].distanceAlongRoute;
    const localMaximum = samples.every((sample, otherIndex) => {
      if (Math.abs(sample.distanceAlongRoute - distance) > TURN_PEAK_WINDOW_METERS) {
        return true;
      }

      return angles[otherIndex] <= angle;
    });

    if (!localMaximum) {
      continue;
    }

    const shiftedDistance = Math.min(distance + TURN_SHIFT_METERS, endDistance - 30);
    const shifted = pointAlongRoute(geometry, shiftedDistance);

    addCandidate(candidates, {
      ...shifted,
      turnAngle: angle,
      turnSourceDistance: distance,
      turnZoneId: `turn-${Math.round(distance)}`,
      nearSegmentBoundary: geometry.boundaryDistances.some(boundary => {
        return Math.abs(boundary - shifted.distanceAlongRoute)
          <= CANDIDATE_MERGE_METERS;
      }),
      selectable: true,
      reasons: ["post-turn"]
    });
  }

  for (const boundaryDistance of geometry.boundaryDistances) {
    if (boundaryDistance <= startDistance + 30 || boundaryDistance >= endDistance - 30) {
      continue;
    }

    const point = pointAlongRoute(geometry, boundaryDistance);

    addCandidate(candidates, {
      ...point,
      turnAngle: turnAngleAt(geometry, point.distanceAlongRoute),
      turnSourceDistance: null,
      turnZoneId: null,
      nearSegmentBoundary: true,
      selectable: true,
      reasons: ["segment-boundary"]
    });
  }

  const firstCoverageDistance = Math.ceil((startDistance + 30) / 240) * 240;

  for (
    let distance = firstCoverageDistance;
    distance < endDistance - 30;
    distance += 240
  ) {
    const point = pointAlongRoute(geometry, distance);

    addCandidate(candidates, {
      ...point,
      turnAngle: turnAngleAt(geometry, point.distanceAlongRoute),
      turnSourceDistance: null,
      turnZoneId: null,
      nearSegmentBoundary: geometry.boundaryDistances.some(boundary => {
        return Math.abs(boundary - point.distanceAlongRoute)
          <= CANDIDATE_MERGE_METERS;
      }),
      selectable: true,
      reasons: ["coverage"]
    });
  }

  const turnSources = candidates
    .filter(candidate => candidate.reasons.has("post-turn"))
    .filter(candidate => candidate.turnAngle >= MEDIUM_TURN_DEGREES)
    .map(candidate => candidate.turnSourceDistance);

  for (const candidate of candidates) {
    if (
      candidate.reasons.size === 1
      && candidate.reasons.has("segment-boundary")
    ) {
      candidate.selectable = false;
      candidate.boundaryOnly = true;
    }

    if (
      candidate.reasons.has("post-turn")
      && candidate.turnAngle < MEDIUM_TURN_DEGREES
      && !candidate.reasons.has("coverage")
      && !candidate.reasons.has("station")
    ) {
      candidate.selectable = false;
      candidate.weakTurnOnly = true;
    }

    if (candidate.reasons.has("post-turn")) {
      continue;
    }

    const nearestTurnSource = turnSources
      .map(distance => ({
        distance,
        offset: candidate.distanceAlongRoute - distance,
        separation: Math.abs(candidate.distanceAlongRoute - distance)
      }))
      .filter(match => {
        return match.offset > -TURN_DECISION_ZONE_BEFORE_METERS
          && match.offset < TURN_DECISION_ZONE_AFTER_METERS;
      })
      .sort((first, second) => first.separation - second.separation)[0];

    if (nearestTurnSource) {
      candidate.selectable = false;
      candidate.nearTurnDecisionPoint = true;
      candidate.nearestTurnSourceDistance = nearestTurnSource.distance;
    }
  }

  return candidates
    .filter(candidate => candidate.distanceAlongRoute > startDistance + 30)
    .filter(candidate => candidate.distanceAlongRoute < endDistance - 30)
    .sort((first, second) => first.distanceAlongRoute - second.distanceAlongRoute)
    .map((candidate, index) => ({
      ...candidate,
      id: index,
      turnClass: turnClass(candidate.turnAngle),
      protectedTurn: false,
      selected: false,
      selectionOrder: null,
      selectionScore: null,
      selectionPhase: null,
      selectionEvaluation: null,
      finalEvaluation: null,
      rejectionReason: candidate.selectable
        ? null
        : candidate.nearTurnDecisionPoint
          ? "junction-proximity"
          : candidate.boundaryOnly
            ? "boundary-only"
            : candidate.weakTurnOnly
              ? "weak-turn"
              : "weak-station",
      replacedCandidateId: null,
      replacedByCandidateId: null
    }));
}

export function adjustWaypointCoordinates(geometry, selected, stationConstraints) {
  const laneSamples = buildLaneSamples(geometry, stationConstraints);

  for (const candidate of selected) {
    const laneOffsetMeters = localLaneOffset(candidate, laneSamples);
    const providerCoordinate = moveRightOfRoute(
      geometry,
      candidate,
      laneOffsetMeters
    );

    candidate.laneOffsetMeters = providerCoordinate ? laneOffsetMeters : 0;
    candidate.providerCoordinate = providerCoordinate;
  }

}
