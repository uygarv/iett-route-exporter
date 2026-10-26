export function trafficMetadata(departureTime) {
  if (departureTime === "now") {
    return {
      requestedTrafficMode: "live",
      trafficTimeContext: "immediate",
      trafficDataBasis: "live"
    };
  }

  return {
    requestedTrafficMode: "live",
    trafficTimeContext: "scheduled",
    trafficDataBasis: "historical"
  };
}

export function publicNode(node) {
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

export function compactGeometryMatch(match) {
  const summary = Object.fromEntries([
    "valid", "quality", "acceptanceBasis", "orderedMaximumDeviationMeters",
    "maximumStopOffsetMeters", "providerGeometryValid", "estimatedLengthMeters"
  ].filter(key => match[key] !== undefined).map(key => [key, match[key]]));
  if (match.alternatives?.length) {
    summary.alternatives = match.alternatives.map(interval => ({
      fromStationIndex: interval.fromStationIndex,
      toStationIndex: interval.toStationIndex,
      referenceLengthMeters: interval.referenceLengthMeters,
      returnedLengthMeters: interval.returnedLengthMeters
    }));
  }
  return summary;
}

export function roundSegmentDistances(segments) {
  let cumulativeDistance = 0, previousRoundedDistance = 0;
  return segments.map(segment => {
    cumulativeDistance += segment.distanceMeters;
    const roundedDistance = Math.round(cumulativeDistance * 10);
    const distanceMeters = (roundedDistance - previousRoundedDistance) / 10;
    previousRoundedDistance = roundedDistance;
    return { ...segment, distanceMeters };
  });
}

export function resultEnvelope({ routeCode, provider, options, nodes, clock }) {
  const origin = nodes[0], destination = nodes.at(-1);
  return {
    routeCode, provider, ...trafficMetadata(options.departureTime),
    generatedAt: new Date(Number(clock())).toISOString(),
    origin: publicNode(origin), destination: publicNode(destination),
    startDistanceAlongRoute: Math.round(origin.distanceAlongRoute * 10) / 10,
    endDistanceAlongRoute: Math.round(destination.distanceAlongRoute * 10) / 10,
    iettGeometryLengthMeters: Math.round((destination.distanceAlongRoute - origin.distanceAlongRoute) * 10) / 10
  };
}
