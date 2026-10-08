import {
  clamp,
  measureControlPath,
  pointAlongRoute,
  resampleRoute
} from "./geometry.js";

const TURN_WINDOW_METERS = 80;
const TURN_SHIFT_METERS = 110;
const CANDIDATE_MERGE_METERS = 60;
const STATION_TURN_ASSOCIATION_METERS = 200;
const STATION_PREFERENCE_RATIO = 0.8;
const MAX_ACCEPTABLE_DEVIATION_METERS = 75;
const P95_ACCEPTABLE_DEVIATION_METERS = 30;
const RESAMPLE_SPACING_METERS = 30;

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

function addCandidate(candidates, incoming) {
  const incomingIsStation = incoming.reasons.includes("station");
  let existing = null;

  if (!incomingIsStation && incoming.reasons.includes("post-turn")) {
    existing = candidates
      .filter(candidate => candidate.reasons.has("station"))
      .filter(candidate => {
        return candidate.distanceAlongRoute >= incoming.turnSourceDistance - 30
          && candidate.distanceAlongRoute
            <= incoming.turnSourceDistance + STATION_TURN_ASSOCIATION_METERS;
      })
      .sort((first, second) => {
        return Math.abs(first.distanceAlongRoute - incoming.distanceAlongRoute)
          - Math.abs(second.distanceAlongRoute - incoming.distanceAlongRoute);
      })[0] ?? null;
  }

  if (!existing) {
    existing = candidates.find(candidate => {
      const existingIsStation = candidate.reasons.has("station");

      if (incomingIsStation && existingIsStation) {
        return false;
      }

      return Math.abs(candidate.distanceAlongRoute - incoming.distanceAlongRoute)
        < CANDIDATE_MERGE_METERS;
    });
  }

  if (!existing) {
    candidates.push({
      ...incoming,
      reasons: new Set(incoming.reasons)
    });
    return;
  }

  for (const reason of incoming.reasons) {
    existing.reasons.add(reason);
  }

  existing.nearSegmentBoundary ||= incoming.nearSegmentBoundary;

  if (incoming.reasons.includes("station")) {
    existing.lat = incoming.lat;
    existing.lng = incoming.lng;
    existing.distanceAlongRoute = incoming.distanceAlongRoute;
    existing.stationName = incoming.stationName;
    existing.stationIndex = incoming.stationIndex;
    existing.distanceToRoute = incoming.distanceToRoute;
    existing.projectedToRoute = incoming.projectedToRoute;
  }

  if (incoming.turnAngle > existing.turnAngle) {
    existing.turnAngle = incoming.turnAngle;
    existing.turnSourceDistance = incoming.turnSourceDistance;

    if (!existing.reasons.has("station")) {
      existing.distanceAlongRoute = incoming.distanceAlongRoute;
      existing.lat = incoming.lat;
      existing.lng = incoming.lng;
    }
  }
}

function buildCandidates(geometry, samples, startDistance, endDistance, stationConstraints) {
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
    const projectedToRoute = station.projectedToRoute
      || routePoint.lat !== station.lat
      || routePoint.lng !== station.lng;

    addCandidate(candidates, {
      lat: routePoint.lat,
      lng: routePoint.lng,
      distanceAlongRoute: routePoint.distanceAlongRoute,
      turnAngle: turnAngleAt(geometry, routePoint.distanceAlongRoute),
      turnSourceDistance: null,
      nearSegmentBoundary: geometry.boundaryDistances.some(boundary => {
        return Math.abs(boundary - routePoint.distanceAlongRoute)
          <= CANDIDATE_MERGE_METERS;
      }),
      stationName: station.stationName,
      stationIndex: station.stationIndex,
      distanceToRoute: station.distanceToRoute,
      projectedToRoute,
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
      if (Math.abs(sample.distanceAlongRoute - distance) > 90) {
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
      nearSegmentBoundary: geometry.boundaryDistances.some(boundary => {
        return Math.abs(boundary - shiftedDistance) <= CANDIDATE_MERGE_METERS;
      }),
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
      turnAngle: turnAngleAt(geometry, boundaryDistance),
      turnSourceDistance: null,
      nearSegmentBoundary: true,
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
      turnAngle: turnAngleAt(geometry, distance),
      turnSourceDistance: null,
      nearSegmentBoundary: geometry.boundaryDistances.some(boundary => {
        return Math.abs(boundary - distance) <= CANDIDATE_MERGE_METERS;
      }),
      reasons: ["coverage"]
    });
  }

  return candidates
    .filter(candidate => candidate.distanceAlongRoute > startDistance + 30)
    .filter(candidate => candidate.distanceAlongRoute < endDistance - 30)
    .sort((first, second) => first.distanceAlongRoute - second.distanceAlongRoute)
    .map((candidate, index) => ({
      ...candidate,
      id: index,
      selected: false,
      selectionOrder: null,
      selectionScore: null
    }));
}

function minimumCoverageCount(remainingLength, maxWaypoints) {
  let count = 0;

  if (remainingLength >= 3_000) count = 1;
  if (remainingLength >= 12_000) count = 2;
  if (remainingLength >= 24_000) count = 3;

  return Math.min(count, maxWaypoints);
}

function maximumControlGap(controlDistances) {
  const ordered = [...controlDistances].sort((first, second) => first - second);
  let maximum = 0;

  for (let index = 1; index < ordered.length; index += 1) {
    maximum = Math.max(maximum, ordered[index] - ordered[index - 1]);
  }

  return maximum;
}

function evaluateCandidate({
  candidate,
  geometry,
  samples,
  controlDistances,
  currentMetrics,
  currentMaximumGap,
  minSpacing
}) {
  const trialDistances = [...controlDistances, candidate.distanceAlongRoute];
  const trialMetrics = measureControlPath(geometry, trialDistances, samples);
  const trialMaximumGap = maximumControlGap(trialDistances);
  const nearestDistance = Math.min(...controlDistances.map(distance => {
    return Math.abs(distance - candidate.distanceAlongRoute);
  }));
  const maxDeviationReduction = clamp(
    (currentMetrics.maxDeviation - trialMetrics.maxDeviation)
      / Math.max(currentMetrics.maxDeviation, 1),
    0,
    1
  );
  const percentile95Reduction = clamp(
    (currentMetrics.percentile95Deviation - trialMetrics.percentile95Deviation)
      / Math.max(currentMetrics.percentile95Deviation, 1),
    0,
    1
  );
  const coverageGain = clamp(
    (currentMaximumGap - trialMaximumGap) / Math.max(currentMaximumGap, 1),
    0,
    1
  );
  const rootMeanSquareReduction = clamp(
    (currentMetrics.rootMeanSquareDeviation - trialMetrics.rootMeanSquareDeviation)
      / Math.max(currentMetrics.rootMeanSquareDeviation, 1),
    0,
    1
  );
  const turnFidelity = candidate.reasons.has("post-turn")
    ? clamp(candidate.turnAngle / 90, 0, 1)
    : 0;
  const requiredSpacing = turnFidelity >= 0.5 ? minSpacing / 2 : minSpacing;
  const score = maxDeviationReduction * 0.40
    + percentile95Reduction * 0.20
    + rootMeanSquareReduction * 0.20
    + coverageGain * 0.15
    + turnFidelity * 0.10;

  return {
    score,
    nearestDistance,
    requiredSpacing,
    trialMetrics,
    trialMaximumGap,
    components: {
      maxDeviationReduction,
      percentile95Reduction,
      rootMeanSquareReduction,
      coverageGain,
      turnFidelity,
      stationPreference: candidate.reasons.has("station") ? 1 : 0
    }
  };
}

function reasonFor(candidate) {
  if (candidate.reasons.has("station")) {
    return "station";
  }

  if (candidate.reasons.has("post-turn") && candidate.nearSegmentBoundary) {
    return "post-turn+segment-boundary";
  }

  if (candidate.reasons.has("post-turn")) {
    return "post-turn";
  }

  if (candidate.reasons.has("segment-boundary")) {
    return "segment-boundary";
  }

  return "coverage";
}

function choosePreferredCandidate(evaluated) {
  const ordered = [...evaluated].sort((first, second) => {
    return second.evaluation.score - first.evaluation.score
      || Number(second.candidate.reasons.has("station"))
        - Number(first.candidate.reasons.has("station"))
      || second.evaluation.nearestDistance - first.evaluation.nearestDistance;
  });
  const best = ordered[0];

  if (!best || best.candidate.reasons.has("station")) {
    return best;
  }

  const bestStation = ordered.find(item => item.candidate.reasons.has("station"));

  if (
    bestStation
    && bestStation.evaluation.score >= best.evaluation.score * STATION_PREFERENCE_RATIO
  ) {
    return bestStation;
  }

  return best;
}

export function selectWaypoints(geometry, {
  startDistance = 0,
  endDistance = geometry.totalLength,
  maxWaypoints = 9,
  stationConstraints = []
} = {}) {
  const samples = resampleRoute(geometry, RESAMPLE_SPACING_METERS);
  const candidates = buildCandidates(
    geometry,
    samples,
    startDistance,
    endDistance,
    stationConstraints
  );
  const remainingLength = endDistance - startDistance;
  const minSpacing = clamp(
    remainingLength / Math.max(maxWaypoints * 2, 1),
    90,
    350
  );
  const coverageFloor = minimumCoverageCount(remainingLength, maxWaypoints);
  const selected = [];
  let stoppedForSignificance = false;

  while (selected.length < maxWaypoints) {
    const controlDistances = [
      startDistance,
      endDistance,
      ...selected.map(candidate => candidate.distanceAlongRoute)
    ];
    const currentMetrics = measureControlPath(geometry, controlDistances, samples);
    const currentMaximumGap = maximumControlGap(controlDistances);
    const spacingEligible = candidates.filter(candidate => {
      if (candidate.selected) {
        return false;
      }

      const turnFidelity = candidate.reasons.has("post-turn")
        ? clamp(candidate.turnAngle / 90, 0, 1)
        : 0;
      const requiredSpacing = turnFidelity >= 0.5 ? minSpacing / 2 : minSpacing;

      return controlDistances.every(distance => {
        return Math.abs(distance - candidate.distanceAlongRoute)
          >= requiredSpacing;
      });
    });
    const fallbackStations = candidates.filter(candidate => {
      return !candidate.selected
        && candidate.reasons.has("station")
        && controlDistances.every(distance => {
          return Math.abs(distance - candidate.distanceAlongRoute) >= 30;
        });
    });
    const available = spacingEligible.length ? spacingEligible : fallbackStations;
    const stationAvailable = available.some(candidate => {
      return candidate.reasons.has("station");
    });
    const geometryNeedsHelp = currentMetrics.maxDeviation
      > MAX_ACCEPTABLE_DEVIATION_METERS
      || currentMetrics.percentile95Deviation > P95_ACCEPTABLE_DEVIATION_METERS;

    if (!available.length) {
      break;
    }

    if (selected.length >= coverageFloor && !stationAvailable && !geometryNeedsHelp) {
      stoppedForSignificance = true;
      break;
    }

    const evaluated = available.map(candidate => ({
      candidate,
      evaluation: evaluateCandidate({
        candidate,
        geometry,
        samples,
        controlDistances,
        currentMetrics,
        currentMaximumGap,
        minSpacing
      })
    }));
    const choice = choosePreferredCandidate(evaluated);

    choice.candidate.selected = true;
    choice.candidate.selectionOrder = selected.length + 1;
    choice.candidate.selectionScore = choice.evaluation.score;
    selected.push(choice.candidate);
  }

  selected.sort((first, second) => first.distanceAlongRoute - second.distanceAlongRoute);

  const finalAnchors = [
    startDistance,
    endDistance,
    ...selected.map(candidate => candidate.distanceAlongRoute)
  ];
  const finalBaseMetrics = measureControlPath(geometry, finalAnchors, samples);
  const finalMaximumGap = maximumControlGap(finalAnchors);

  for (const candidate of candidates) {
    candidate.finalEvaluation = evaluateCandidate({
      candidate,
      geometry,
      samples,
      controlDistances: finalAnchors,
      currentMetrics: finalBaseMetrics,
      currentMaximumGap: finalMaximumGap,
      minSpacing
    });

    if (!candidate.selected) {
      if (
        candidate.finalEvaluation.nearestDistance
          < candidate.finalEvaluation.requiredSpacing
      ) {
        candidate.rejectionReason = "too-close";
      } else if (selected.length >= maxWaypoints) {
        candidate.rejectionReason = "max-waypoints";
      } else if (stoppedForSignificance) {
        candidate.rejectionReason = "below-significance";
      } else {
        candidate.rejectionReason = "not-selected";
      }
    }
  }

  for (const candidate of candidates) {
    const routePoint = pointAlongRoute(geometry, candidate.distanceAlongRoute);
    const moved = routePoint.lat !== candidate.lat || routePoint.lng !== candidate.lng;

    candidate.lat = routePoint.lat;
    candidate.lng = routePoint.lng;
    candidate.distanceAlongRoute = routePoint.distanceAlongRoute;

    if (candidate.reasons.has("station") && moved) {
      candidate.projectedToRoute = true;
    }
  }

  const finalMetrics = measureControlPath(
    geometry,
    [startDistance, ...selected.map(item => item.distanceAlongRoute), endDistance],
    samples
  );

  return {
    waypoints: selected.map(candidate => ({
      lat: candidate.lat,
      lng: candidate.lng,
      distanceAlongRoute: candidate.distanceAlongRoute,
      score: candidate.selectionScore,
      turnAngle: candidate.turnAngle,
      reason: reasonFor(candidate),
      roles: [...candidate.reasons],
      ...(candidate.stationName ? {
        stationName: candidate.stationName,
        stationIndex: candidate.stationIndex,
        distanceToRoute: candidate.distanceToRoute,
        projectedToRoute: candidate.projectedToRoute
      } : {})
    })),
    samples,
    metrics: finalMetrics,
    minSpacing,
    candidates: candidates.map(candidate => ({
      lat: candidate.lat,
      lng: candidate.lng,
      distanceAlongRoute: candidate.distanceAlongRoute,
      score: candidate.selected
        ? candidate.selectionScore
        : candidate.finalEvaluation.score,
      componentScores: candidate.finalEvaluation.components,
      turnAngle: candidate.turnAngle,
      nearSegmentBoundary: candidate.nearSegmentBoundary,
      selected: candidate.selected,
      selectionOrder: candidate.selectionOrder,
      rejectionReason: candidate.rejectionReason ?? null,
      reason: candidate.selected ? reasonFor(candidate) : [...candidate.reasons].join("+"),
      roles: [...candidate.reasons],
      stationName: candidate.stationName ?? null,
      stationIndex: candidate.stationIndex ?? null,
      distanceToRoute: candidate.distanceToRoute ?? null,
      projectedToRoute: candidate.projectedToRoute ?? false
    }))
  };
}
