import { clamp, measureControlPath, pointAlongRoute, resampleRoute } from "./geometry.js";
import { buildCandidates, adjustWaypointCoordinates, isStrongTurnCandidate, STRONG_TURN_DEGREES } from "./waypoint-candidates.js";
import { publicWaypoint, publicCandidate } from "./waypoint-output.js";

const MIN_SIGNIFICANCE_SCORE = 0.05;
const MIN_GEOMETRY_REDUCTION = 0.03;
const MIN_GAP_REDUCTION = 0.08;
const MIN_SWAP_IMPROVEMENT = 0.005;
const MAX_ACCEPTABLE_DEVIATION_METERS = 75;
const P95_ACCEPTABLE_DEVIATION_METERS = 30;
const RESAMPLE_SPACING_METERS = 30;

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

function selectionMetrics({
  selected,
  geometry,
  samples,
  startDistance,
  endDistance
}) {
  const controlDistances = controlsFor(selected, startDistance, endDistance);
  const currentMetrics = measureControlPath(geometry, controlDistances, samples);
  const currentMaximumGap = maximumControlGap(controlDistances);

  return { controlDistances, currentMetrics, currentMaximumGap };
}

function evaluateAgainstSelection(context, metrics = selectionMetrics(context)) {
  return evaluateCandidate({ ...context, ...metrics });
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

    const metrics = selectionMetrics(context);
    const evaluated = available.map(candidate => ({
      candidate,
      evaluation: evaluateAgainstSelection({ candidate, ...context }, metrics)
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

    const metrics = selectionMetrics(context);
    const evaluated = available.map(candidate => ({
      candidate,
      evaluation: evaluateAgainstSelection({ candidate, ...context }, metrics)
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

    const metrics = selectionMetrics(context);
    const evaluated = available.map(candidate => ({
      candidate,
      evaluation: evaluateAgainstSelection({ candidate, ...context }, metrics)
    }));
    const { currentMetrics } = metrics;
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

    if (!isSignificant(choice.candidate, choice.evaluation)) {
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
    geometry,
    samples,
    startDistance,
    endDistance
  } = context;
  const controlDistances = controlsFor(selected, startDistance, endDistance);
  const metrics = measureControlPath(geometry, controlDistances, samples);
  const maximumGap = maximumControlGap(controlDistances);
  const { zones, totalTurnValue } = baseline;
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
    maximumGap: maximumControlGap(baselineControls),
    zones: turnZones(candidates)
  };
  baseline.totalTurnValue = [...baseline.zones.values()].reduce((sum, value) => sum + value, 0);
  let currentObjective = objectiveForSelection(context, selected, baseline);

  for (let iteration = 0; iteration < maxWaypoints; iteration += 1) {
    let bestSwap = null;
    const selectedStrongTurns = selected.filter(isStrongTurnCandidate).length;

    for (const incoming of candidates) {
      if (!incoming.selectable || incoming.selected) {
        continue;
      }

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

export function selectWaypoints(geometry, {
  startDistance = 0,
  endDistance = geometry.totalLength,
  maxWaypoints = 9,
  stationConstraints = [],
  debug = false
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
    remainingLength / 18,
    400,
    1_200
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

  const finalSelectionMetrics = debug ? selectionMetrics(context) : null;
  for (const candidate of debug ? candidates : selected) {
    const routePoint = pointAlongRoute(geometry, candidate.distanceAlongRoute);
    const moved = routePoint.lat !== candidate.lat || routePoint.lng !== candidate.lng;

    candidate.lat = routePoint.lat;
    candidate.lng = routePoint.lng;
    candidate.distanceAlongRoute = routePoint.distanceAlongRoute;

    if (candidate.reasons.has("station") && moved) {
      candidate.projectedToRoute = true;
    }

    if (!debug) continue;

    candidate.finalEvaluation = evaluateAgainstSelection({ candidate, ...context }, finalSelectionMetrics);

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

  adjustWaypointCoordinates(geometry, selected, stationConstraints);

  return {
    waypoints: selected.map(publicWaypoint),
    samples,
    minSpacing,
    ...(debug ? {
      metrics: finalSelectionMetrics.currentMetrics,
      candidates: candidates.map(publicCandidate)
    } : {})
  };
}
