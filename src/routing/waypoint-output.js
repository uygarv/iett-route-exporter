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

export function publicWaypoint(candidate) {
  return {
    lat: candidate.providerCoordinate?.lat ?? candidate.lat,
    lng: candidate.providerCoordinate?.lng ?? candidate.lng,
    distanceAlongRoute: candidate.distanceAlongRoute,
    score: candidate.selectionScore,
    turnAngle: candidate.turnAngle,
    reason: reasonFor(candidate),
    roles: [...candidate.reasons],
    providerAdjusted: Boolean(candidate.providerCoordinate),
    laneOffsetMeters: candidate.laneOffsetMeters,
    ...(candidate.stationName ? {
      stationName: candidate.stationName,
      stationIndex: candidate.stationIndex,
      distanceToRoute: candidate.distanceToRoute,
      projectedToRoute: candidate.projectedToRoute
    } : {})
  };
}

export function publicCandidate(candidate) {
  return {
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
    projectedToRoute: candidate.projectedToRoute ?? false,
    providerCoordinate: candidate.providerCoordinate ?? null,
    laneOffsetMeters: candidate.laneOffsetMeters ?? 0
  };
}
