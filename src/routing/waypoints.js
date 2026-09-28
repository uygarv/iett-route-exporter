import {
  clamp,
  measureControlPath,
  pointAlongRoute,
  resampleRoute
} from "./geometry.js";

const TURN_WINDOW_METERS = 80;
const TURN_SHIFT_METERS = 110;
const CANDIDATE_MERGE_METERS = 60;
const MIN_SIGNIFICANCE = 0.32;
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
  const existing = candidates.find(candidate => {
    return Math.abs(candidate.distanceAlongRoute - incoming.distanceAlongRoute) < CANDIDATE_MERGE_METERS;
  });

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

function buildCandidates(geometry, samples, startDistance, stationConstraints) {
  const candidates = [];
  const angles = samples.map(sample => {
    const insideTurnWindow = sample.distanceAlongRoute >= startDistance + TURN_WINDOW_METERS
      && sample.distanceAlongRoute <= geometry.totalLength - TURN_WINDOW_METERS;

    return insideTurnWindow ? turnAngleAt(geometry, sample.distanceAlongRoute) : 0;
  });

  for (const station of stationConstraints) {
    if (
      station.distanceAlongRoute <= startDistance + 30
      || station.distanceAlongRoute >= geometry.totalLength - 30
    ) {
      continue;
    }

    addCandidate(candidates, {
      lat: station.lat,
      lng: station.lng,
      distanceAlongRoute: station.distanceAlongRoute,
      turnAngle: turnAngleAt(geometry, station.distanceAlongRoute),
      turnSourceDistance: null,
      nearSegmentBoundary: geometry.boundaryDistances.some(boundary => {
        return Math.abs(boundary - station.distanceAlongRoute) <= CANDIDATE_MERGE_METERS;
      }),
      stationName: station.stationName,
      stationIndex: station.stationIndex,
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

    const shiftedDistance = Math.min(distance + TURN_SHIFT_METERS, geometry.totalLength - 30);
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
    if (boundaryDistance <= startDistance + 30 || boundaryDistance >= geometry.totalLength - 30) {
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
    distance < geometry.totalLength - 30;
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
    .filter(candidate => candidate.distanceAlongRoute < geometry.totalLength - 30)
    .sort((first, second) => first.distanceAlongRoute - second.distanceAlongRoute)
    .map((candidate, index) => ({
      ...candidate,
      id: index,
      selected: false,
      selectionOrder: null,
      selectionScore: null,
      forcedByGeometry: false
    }));
}

function minimumCoverageCount(remainingLength, maxWaypoints) {
  let count = 0;

  if (remainingLength >= 3_000) count = 1;
  if (remainingLength >= 12_000) count = 2;
  if (remainingLength >= 24_000) count = 3;

  return Math.min(count, maxWaypoints);
}

function scoreCandidate(candidate, anchors, minSpacing, coverageScale) {
  const nearestDistance = Math.min(...anchors.map(anchor => {
    return Math.abs(anchor - candidate.distanceAlongRoute);
  }));
  const curvature = clamp(candidate.turnAngle / 90, 0, 1);
  const coverage = clamp(nearestDistance / coverageScale, 0, 1);
  const spacing = clamp(nearestDistance / minSpacing, 0, 1);
  const boundaryBonus = candidate.nearSegmentBoundary ? 1 : 0;
  const score = curvature * 0.60
    + coverage * 0.25
    + spacing * 0.10
    + boundaryBonus * 0.05;

  return {
    score,
    nearestDistance,
    components: {
      curvature,
      coverage,
      spacing,
      boundaryBonus
    }
  };
}

function isSpaced(score, candidate, minSpacing) {
  if (score.nearestDistance >= minSpacing) {
    return true;
  }

  return candidate.turnAngle >= 70 && score.nearestDistance >= minSpacing / 2;
}

function reasonFor(candidate) {
  if (candidate.reasons.has("station")) {
    return "station";
  }

  if (candidate.forcedByGeometry) {
    return "geometric-deviation";
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

function selectStationCandidates({
  candidates,
  geometry,
  startDistance,
  maxWaypoints,
  selected
}) {
  const stationCandidates = candidates.filter(candidate => {
    return candidate.reasons.has("station");
  });
  const coverageScale = Math.max((geometry.totalLength - startDistance) / 2, 1_200);

  while (selected.length < maxWaypoints) {
    const available = stationCandidates.filter(candidate => !candidate.selected);

    if (!available.length) {
      break;
    }

    const controlDistances = [
      startDistance,
      ...selected.map(candidate => candidate.distanceAlongRoute),
      geometry.totalLength
    ];
    const anchors = [...controlDistances];
    const scored = available.map(candidate => {
      const deviation = measureControlPath(
        geometry,
        controlDistances,
        [candidate]
      ).maxDeviation;
      const nearestAnchor = Math.min(...anchors.map(anchor => {
        return Math.abs(anchor - candidate.distanceAlongRoute);
      }));
      const deviationScore = clamp(deviation / 500, 0, 1);
      const coverageScore = clamp(nearestAnchor / coverageScale, 0, 1);

      return {
        candidate,
        score: deviationScore * 0.75 + coverageScore * 0.25
      };
    });

    scored.sort((first, second) => second.score - first.score);

    const choice = scored[0];
    choice.candidate.selected = true;
    choice.candidate.selectionOrder = selected.length + 1;
    choice.candidate.selectionScore = choice.score;
    selected.push(choice.candidate);
  }
}

export function selectWaypoints(geometry, {
  startDistance = 0,
  maxWaypoints = 9,
  stationConstraints = []
} = {}) {
  const samples = resampleRoute(geometry, RESAMPLE_SPACING_METERS);
  const candidates = buildCandidates(
    geometry,
    samples,
    startDistance,
    stationConstraints
  );
  const remainingLength = geometry.totalLength - startDistance;
  const minSpacing = clamp(geometry.totalLength / 18, 400, 1_200);
  const coverageScale = Math.max(remainingLength / 2, 1_200);
  const coverageFloor = minimumCoverageCount(remainingLength, maxWaypoints);
  const selected = [];
  let stoppedForSignificance = false;

  selectStationCandidates({
    candidates,
    geometry,
    startDistance,
    maxWaypoints,
    selected
  });

  while (selected.length < maxWaypoints) {
    const anchors = [
      startDistance,
      geometry.totalLength,
      ...selected.map(candidate => candidate.distanceAlongRoute)
    ];

    const scored = candidates
      .filter(candidate => !candidate.selected)
      .map(candidate => ({
        candidate,
        evaluation: scoreCandidate(candidate, anchors, minSpacing, coverageScale)
      }))
      .filter(item => isSpaced(item.evaluation, item.candidate, minSpacing))
      .sort((first, second) => second.evaluation.score - first.evaluation.score);

    if (!scored.length) {
      break;
    }

    const controlDistances = [
      startDistance,
      ...selected.map(candidate => candidate.distanceAlongRoute),
      geometry.totalLength
    ];
    const metrics = measureControlPath(geometry, controlDistances, samples);
    const geometryNeedsHelp = metrics.maxDeviation > 250
      || metrics.percentile95Deviation > 100;
    let choice = scored[0];

    if (choice.evaluation.score < MIN_SIGNIFICANCE && selected.length >= coverageFloor) {
      if (!geometryNeedsHelp) {
        stoppedForSignificance = true;
        break;
      }

      const geometricChoice = [...scored].sort((first, second) => {
        const firstDistance = Math.abs(
          first.candidate.distanceAlongRoute - metrics.maxDeviationDistance
        );
        const secondDistance = Math.abs(
          second.candidate.distanceAlongRoute - metrics.maxDeviationDistance
        );

        return firstDistance - secondDistance;
      })[0];

      if (geometricChoice) {
        choice = geometricChoice;
        choice.candidate.forcedByGeometry = true;
      }
    }

    choice.candidate.selected = true;
    choice.candidate.selectionOrder = selected.length + 1;
    choice.candidate.selectionScore = choice.evaluation.score;
    selected.push(choice.candidate);
  }

  selected.sort((first, second) => first.distanceAlongRoute - second.distanceAlongRoute);

  const finalAnchors = [
    startDistance,
    geometry.totalLength,
    ...selected.map(candidate => candidate.distanceAlongRoute)
  ];

  for (const candidate of candidates) {
    candidate.finalEvaluation = scoreCandidate(
      candidate,
      finalAnchors,
      minSpacing,
      coverageScale
    );

    if (!candidate.selected) {
      if (!isSpaced(candidate.finalEvaluation, candidate, minSpacing)) {
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

  const finalMetrics = measureControlPath(
    geometry,
    [startDistance, ...selected.map(item => item.distanceAlongRoute), geometry.totalLength],
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
      ...(candidate.stationName ? {
        stationName: candidate.stationName,
        stationIndex: candidate.stationIndex
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
      stationName: candidate.stationName ?? null,
      stationIndex: candidate.stationIndex ?? null
    }))
  };
}
