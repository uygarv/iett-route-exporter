import {
  clamp,
  measureControlPath,
  pointAlongRoute,
  resampleRoute
} from "./geometry.js";

const TURN_WINDOW_METERS = 80;
const TURN_SHIFT_METERS = 110;
const TURN_PEAK_WINDOW_METERS = 90;
const TURN_DECISION_ZONE_BEFORE_METERS = 100;
const TURN_DECISION_ZONE_AFTER_METERS = 30;
const CANDIDATE_MERGE_METERS = 60;
const STATION_TURN_MIN_OFFSET_METERS = 60;
const STATION_TURN_MAX_OFFSET_METERS = 160;
const STATION_TURN_TARGET_TOLERANCE_METERS = 50;
const STRONG_TURN_DEGREES = 55;
const MEDIUM_TURN_DEGREES = 25;
const MIN_SIGNIFICANCE_SCORE = 0.05;
const MIN_GEOMETRY_REDUCTION = 0.03;
const MIN_GAP_REDUCTION = 0.08;
const MIN_SWAP_IMPROVEMENT = 0.005;
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

function isStrongTurnCandidate(candidate) {
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

function candidateTurnFidelity(candidate) {
  const isTurnCandidate = candidate.reasons.has("post-turn")
    || candidate.reasons.has("station");

  return isTurnCandidate ? clamp(candidate.turnAngle / 90, 0, 1) : 0;
}

function requiredSpacing(candidate, minSpacing) {
  if (candidate.reasons.has("post-turn") && candidate.turnClass === "strong") {
    return minSpacing / 2;
  }

  if (candidate.reasons.has("post-turn") && candidate.turnClass === "medium") {
    return minSpacing * 0.7;
  }

  return minSpacing;
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
  const rootMeanSquareReduction = clamp(
    (currentMetrics.rootMeanSquareDeviation - trialMetrics.rootMeanSquareDeviation)
      / Math.max(currentMetrics.rootMeanSquareDeviation, 1),
    0,
    1
  );
  const coverageGain = clamp(
    (currentMaximumGap - trialMaximumGap) / Math.max(currentMaximumGap, 1),
    0,
    1
  );
  const turnFidelity = candidateTurnFidelity(candidate);
  const score = turnFidelity * 0.35
    + maxDeviationReduction * 0.25
    + percentile95Reduction * 0.15
    + rootMeanSquareReduction * 0.10
    + coverageGain * 0.15;
  const strongTurnScore = turnFidelity * 0.65
    + maxDeviationReduction * 0.15
    + percentile95Reduction * 0.10
    + coverageGain * 0.10;
  const coverageScore = maxDeviationReduction * 0.35
    + percentile95Reduction * 0.25
    + rootMeanSquareReduction * 0.15
    + coverageGain * 0.25;

  return {
    score,
    strongTurnScore,
    coverageScore,
    nearestDistance,
    requiredSpacing: requiredSpacing(candidate, minSpacing),
    trialMetrics,
    trialMaximumGap,
    components: {
      maxDeviationReduction,
      percentile95Reduction,
      rootMeanSquareReduction,
      coverageGain,
      turnFidelity,
      stationPreference: 0
    }
  };
}

function controlsFor(selected, startDistance, endDistance) {
  return [
    startDistance,
    endDistance,
    ...selected.map(candidate => candidate.distanceAlongRoute)
  ];
}

function spacingEligible(candidate, selected, startDistance, endDistance, minSpacing) {
  const ownSpacing = requiredSpacing(candidate, minSpacing);

  if (
    Math.abs(candidate.distanceAlongRoute - startDistance) < ownSpacing
    || Math.abs(endDistance - candidate.distanceAlongRoute) < ownSpacing
  ) {
    return false;
  }

  return selected.every(existing => {
    const spacing = Math.min(
      ownSpacing,
      requiredSpacing(existing, minSpacing)
    );

    return Math.abs(existing.distanceAlongRoute - candidate.distanceAlongRoute)
      >= spacing;
  });
}

function evaluateAgainstSelection({
  candidate,
  selected,
  geometry,
  samples,
  startDistance,
  endDistance,
  minSpacing
}) {
  const controlDistances = controlsFor(selected, startDistance, endDistance);
  const currentMetrics = measureControlPath(geometry, controlDistances, samples);
  const currentMaximumGap = maximumControlGap(controlDistances);

  return evaluateCandidate({
    candidate,
    geometry,
    samples,
    controlDistances,
    currentMetrics,
    currentMaximumGap,
    minSpacing
  });
}

function markSelected(candidate, evaluation, phase, order) {
  candidate.selected = true;
  candidate.selectionOrder = order;
  candidate.selectionScore = phase === "strong-turn"
    ? evaluation.strongTurnScore
    : phase === "coverage"
      ? evaluation.coverageScore
      : evaluation.score;
  candidate.selectionPhase = phase;
  candidate.selectionEvaluation = evaluation;
  candidate.protectedTurn = phase === "strong-turn";
  candidate.rejectionReason = null;
}

function selectStrongTurns(context, strongTurnBudget) {
  const {
    candidates,
    selected,
    maxWaypoints,
    startDistance,
    endDistance,
    minSpacing
  } = context;

  while (
    selected.length < maxWaypoints
    && selected.length < strongTurnBudget
  ) {
    const available = candidates
      .filter(candidate => candidate.selectable)
      .filter(candidate => !candidate.selected)
      .filter(isStrongTurnCandidate)
      .filter(candidate => {
        return spacingEligible(
          candidate,
          selected,
          startDistance,
          endDistance,
          minSpacing
        );
      });

    if (!available.length) {
      break;
    }

    const evaluated = available.map(candidate => ({
      candidate,
      evaluation: evaluateAgainstSelection({ candidate, selected, ...context })
    }));
    const choice = evaluated.sort((first, second) => {
      return second.evaluation.strongTurnScore - first.evaluation.strongTurnScore
        || second.candidate.turnAngle - first.candidate.turnAngle;
    })[0];

    markSelected(
      choice.candidate,
      choice.evaluation,
      "strong-turn",
      selected.length + 1
    );
    selected.push(choice.candidate);
  }
}

function fillCoverageFloor(context, coverageFloor) {
  const {
    candidates,
    selected,
    maxWaypoints,
    startDistance,
    endDistance,
    minSpacing
  } = context;
  let added = 0;

  while (added < coverageFloor && selected.length < maxWaypoints) {
    const available = candidates
      .filter(candidate => candidate.selectable)
      .filter(candidate => !candidate.selected)
      .filter(candidate => !candidate.protectedTurn)
      .filter(candidate => {
        return spacingEligible(
          candidate,
          selected,
          startDistance,
          endDistance,
          minSpacing
        );
      });

    if (!available.length) {
      break;
    }

    const evaluated = available.map(candidate => ({
      candidate,
      evaluation: evaluateAgainstSelection({ candidate, selected, ...context })
    }));
    const choice = evaluated.sort((first, second) => {
      return second.evaluation.coverageScore - first.evaluation.coverageScore
        || second.evaluation.nearestDistance - first.evaluation.nearestDistance;
    })[0];

    markSelected(
      choice.candidate,
      choice.evaluation,
      "coverage",
      selected.length + 1
    );
    selected.push(choice.candidate);
    added += 1;
  }
}

function isSignificant(candidate, evaluation) {
  const components = evaluation.components;
  const meaningfulChange = candidate.turnClass === "medium"
    || candidate.turnClass === "strong"
    || components.maxDeviationReduction >= MIN_GEOMETRY_REDUCTION
    || components.percentile95Reduction >= MIN_GEOMETRY_REDUCTION
    || components.rootMeanSquareReduction >= MIN_GEOMETRY_REDUCTION
    || components.coverageGain >= MIN_GAP_REDUCTION;

  return evaluation.score >= MIN_SIGNIFICANCE_SCORE && meaningfulChange;
}

function fillRemainingSlots(context) {
  const {
    candidates,
    selected,
    maxWaypoints,
    startDistance,
    endDistance,
    minSpacing
  } = context;
  let stoppedForSignificance = false;

  while (selected.length < maxWaypoints) {
    const available = candidates
      .filter(candidate => candidate.selectable)
      .filter(candidate => !candidate.selected)
      .filter(candidate => {
        return spacingEligible(
          candidate,
          selected,
          startDistance,
          endDistance,
          minSpacing
        );
      });

    if (!available.length) {
      break;
    }

    const evaluated = available.map(candidate => ({
      candidate,
      evaluation: evaluateAgainstSelection({ candidate, selected, ...context })
    }));
    const currentMetrics = measureControlPath(
      context.geometry,
      controlsFor(selected, startDistance, endDistance),
      context.samples
    );
    const geometryNeedsHelp = currentMetrics.maxDeviation
      > MAX_ACCEPTABLE_DEVIATION_METERS
      || currentMetrics.percentile95Deviation > P95_ACCEPTABLE_DEVIATION_METERS;
    const choice = evaluated.sort((first, second) => {
      const firstScore = geometryNeedsHelp
        ? first.evaluation.coverageScore
        : first.evaluation.score;
      const secondScore = geometryNeedsHelp
        ? second.evaluation.coverageScore
        : second.evaluation.score;

      return secondScore - firstScore
        || second.evaluation.nearestDistance - first.evaluation.nearestDistance;
    })[0];

    if (
      !geometryNeedsHelp
      && !isSignificant(choice.candidate, choice.evaluation)
    ) {
      stoppedForSignificance = true;
      break;
    }

    markSelected(
      choice.candidate,
      choice.evaluation,
      geometryNeedsHelp ? "geometry" : "fidelity",
      selected.length + 1
    );
    selected.push(choice.candidate);
  }

  return stoppedForSignificance;
}

function normalizedReduction(before, after) {
  return clamp((before - after) / Math.max(before, 1), 0, 1);
}

function turnZones(candidates) {
  const zones = new Map();

  for (const candidate of candidates) {
    if (
      !candidate.turnZoneId
      || candidate.turnAngle < STRONG_TURN_DEGREES
    ) {
      continue;
    }

    const fidelity = clamp(candidate.turnAngle / 90, 0, 1);
    zones.set(candidate.turnZoneId, Math.max(zones.get(candidate.turnZoneId) ?? 0, fidelity));
  }

  return zones;
}

function objectiveForSelection(context, selected, baseline) {
  const {
    candidates,
    geometry,
    samples,
    startDistance,
    endDistance
  } = context;
  const controlDistances = controlsFor(selected, startDistance, endDistance);
  const metrics = measureControlPath(geometry, controlDistances, samples);
  const maximumGap = maximumControlGap(controlDistances);
  const zones = turnZones(candidates);
  const totalTurnValue = [...zones.values()].reduce((sum, value) => sum + value, 0);
  const coveredZones = new Set(selected
    .map(candidate => candidate.turnZoneId)
    .filter(Boolean));
  const coveredTurnValue = [...coveredZones].reduce((sum, zoneId) => {
    return sum + (zones.get(zoneId) ?? 0);
  }, 0);
  const turnCoverage = totalTurnValue
    ? coveredTurnValue / totalTurnValue
    : 0;
  const maxDeviationQuality = normalizedReduction(
    baseline.metrics.maxDeviation,
    metrics.maxDeviation
  );
  const percentile95Quality = normalizedReduction(
    baseline.metrics.percentile95Deviation,
    metrics.percentile95Deviation
  );
  const rootMeanSquareQuality = normalizedReduction(
    baseline.metrics.rootMeanSquareDeviation,
    metrics.rootMeanSquareDeviation
  );
  const gapQuality = normalizedReduction(baseline.maximumGap, maximumGap);

  return {
    score: turnCoverage * 0.20
      + maxDeviationQuality * 0.35
      + percentile95Quality * 0.25
      + rootMeanSquareQuality * 0.15
      + gapQuality * 0.05,
    metrics,
    maximumGap,
    components: {
      turnCoverage,
      maxDeviationQuality,
      percentile95Quality,
      rootMeanSquareQuality,
      gapQuality
    }
  };
}

function optimizeWithSwaps(context) {
  const {
    candidates,
    selected,
    geometry,
    samples,
    startDistance,
    endDistance,
    minSpacing,
    maxWaypoints,
    strongTurnBudget
  } = context;

  if (!selected.length || selected.length < maxWaypoints) {
    return;
  }

  const baselineControls = [startDistance, endDistance];
  const baseline = {
    metrics: measureControlPath(geometry, baselineControls, samples),
    maximumGap: maximumControlGap(baselineControls)
  };
  let currentObjective = objectiveForSelection(context, selected, baseline);

  for (let iteration = 0; iteration < maxWaypoints; iteration += 1) {
    let bestSwap = null;

    for (const incoming of candidates) {
      if (!incoming.selectable || incoming.selected) {
        continue;
      }

      const selectedStrongTurns = selected.filter(isStrongTurnCandidate).length;

      if (
        isStrongTurnCandidate(incoming)
        && selectedStrongTurns >= strongTurnBudget
      ) {
        const canReplaceStrongTurn = selected.some(candidate => {
          return candidate.protectedTurn && isStrongTurnCandidate(candidate);
        });

        if (!canReplaceStrongTurn) {
          continue;
        }
      }

      for (const outgoing of selected) {
        const replacingProtectedTurn = outgoing.protectedTurn;

        if (
          replacingProtectedTurn
          && !isStrongTurnCandidate(incoming)
        ) {
          continue;
        }

        if (
          isStrongTurnCandidate(incoming)
          && selectedStrongTurns >= strongTurnBudget
          && !isStrongTurnCandidate(outgoing)
        ) {
          continue;
        }

        const remaining = selected.filter(candidate => candidate !== outgoing);

        if (!spacingEligible(
          incoming,
          remaining,
          startDistance,
          endDistance,
          minSpacing
        )) {
          continue;
        }

        const trial = [...remaining, incoming];
        const objective = objectiveForSelection(context, trial, baseline);
        const improvement = objective.score - currentObjective.score;
        const geometryDoesNotRegress = objective.metrics.maxDeviation
          <= currentObjective.metrics.maxDeviation + 1
          && objective.metrics.percentile95Deviation
            <= currentObjective.metrics.percentile95Deviation + 1;

        if (
          geometryDoesNotRegress
          && improvement >= MIN_SWAP_IMPROVEMENT
          && (!bestSwap || improvement > bestSwap.improvement)
        ) {
          bestSwap = {
            incoming,
            outgoing,
            replacingProtectedTurn,
            remaining,
            objective,
            improvement
          };
        }
      }
    }

    if (!bestSwap) {
      break;
    }

    const outgoingIndex = selected.indexOf(bestSwap.outgoing);
    const evaluation = evaluateAgainstSelection({
      candidate: bestSwap.incoming,
      selected: bestSwap.remaining,
      ...context
    });

    bestSwap.outgoing.selected = false;
    bestSwap.outgoing.rejectionReason = "replaced";
    bestSwap.outgoing.replacedByCandidateId = bestSwap.incoming.id;
    bestSwap.incoming.replacedCandidateId = bestSwap.outgoing.id;
    markSelected(
      bestSwap.incoming,
      evaluation,
      "swap",
      bestSwap.outgoing.selectionOrder
    );
    bestSwap.incoming.protectedTurn = bestSwap.replacingProtectedTurn;
    selected[outgoingIndex] = bestSwap.incoming;
    currentObjective = bestSwap.objective;
  }
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

  if (
    candidate.reasons.has("coverage")
    && candidate.reasons.has("segment-boundary")
  ) {
    return "coverage+segment-boundary";
  }

  if (candidate.reasons.has("segment-boundary")) {
    return "segment-boundary";
  }

  return "coverage";
}

function publicEvaluation(evaluation) {
  if (!evaluation) {
    return null;
  }

  return {
    score: evaluation.score,
    strongTurnScore: evaluation.strongTurnScore,
    coverageScore: evaluation.coverageScore,
    nearestDistance: evaluation.nearestDistance,
    requiredSpacing: evaluation.requiredSpacing,
    componentScores: evaluation.components
  };
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
  const strongTurnBudget = Math.min(
    maxWaypoints,
    maxWaypoints <= 3 ? maxWaypoints : Math.ceil(maxWaypoints / 3)
  );
  const context = {
    candidates,
    selected,
    geometry,
    samples,
    startDistance,
    endDistance,
    minSpacing,
    maxWaypoints,
    strongTurnBudget
  };

  selectStrongTurns(context, strongTurnBudget);
  fillCoverageFloor(context, coverageFloor);
  const stoppedForSignificance = fillRemainingSlots(context);
  optimizeWithSwaps(context);

  selected.sort((first, second) => first.distanceAlongRoute - second.distanceAlongRoute);

  for (const candidate of candidates) {
    const routePoint = pointAlongRoute(geometry, candidate.distanceAlongRoute);
    const moved = routePoint.lat !== candidate.lat || routePoint.lng !== candidate.lng;

    candidate.lat = routePoint.lat;
    candidate.lng = routePoint.lng;
    candidate.distanceAlongRoute = routePoint.distanceAlongRoute;

    if (candidate.reasons.has("station") && moved) {
      candidate.projectedToRoute = true;
    }

    const comparisonSelection = candidate.selected
      ? selected.filter(existing => existing !== candidate)
      : selected;

    candidate.finalEvaluation = evaluateAgainstSelection({
      candidate,
      selected: comparisonSelection,
      ...context
    });

    if (candidate.selected || !candidate.selectable) {
      continue;
    }

    if (candidate.rejectionReason === "replaced") {
      continue;
    }

    if (!spacingEligible(
      candidate,
      selected,
      startDistance,
      endDistance,
      minSpacing
    )) {
      candidate.rejectionReason = "too-close";
    } else if (selected.length >= maxWaypoints) {
      candidate.rejectionReason = "max-waypoints";
    } else if (stoppedForSignificance) {
      candidate.rejectionReason = "below-significance";
    } else {
      candidate.rejectionReason = "not-selected";
    }
  }

  const finalMetrics = measureControlPath(
    geometry,
    controlsFor(selected, startDistance, endDistance),
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
      componentScores: candidate.selected
        ? candidate.selectionEvaluation.components
        : candidate.finalEvaluation.components,
      turnAngle: candidate.turnAngle,
      turnClass: candidate.turnClass,
      turnSourceDistance: candidate.turnSourceDistance,
      protectedTurn: candidate.protectedTurn,
      selectionPhase: candidate.selectionPhase,
      selectionEvaluation: publicEvaluation(candidate.selectionEvaluation),
      finalEvaluation: publicEvaluation(candidate.finalEvaluation),
      nearSegmentBoundary: candidate.nearSegmentBoundary,
      boundaryOnly: candidate.boundaryOnly ?? false,
      weakTurnOnly: candidate.weakTurnOnly ?? false,
      nearTurnDecisionPoint: candidate.nearTurnDecisionPoint ?? false,
      nearestTurnSourceDistance: candidate.nearestTurnSourceDistance ?? null,
      selected: candidate.selected,
      selectionOrder: candidate.selectionOrder,
      rejectionReason: candidate.rejectionReason,
      replacedCandidateId: candidate.replacedCandidateId,
      replacedByCandidateId: candidate.replacedByCandidateId,
      reason: candidate.selected ? reasonFor(candidate) : [...candidate.reasons].join("+"),
      roles: [...candidate.reasons],
      stationName: candidate.stationName ?? null,
      stationIndex: candidate.stationIndex ?? null,
      distanceToRoute: candidate.distanceToRoute ?? null,
      projectedToRoute: candidate.projectedToRoute ?? false
    }))
  };
}
