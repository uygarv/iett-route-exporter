import { buildGeometryFromCoordinates } from "./geometry.js";
import { matchStopsToRoute, sliceRouteGeometry } from "./timing.js";

const rounded = value => Math.round(value * 10) / 10;
const line = (geometry, start, end) => ({ type: "LineString",
  coordinates: sliceRouteGeometry(geometry, start, end).map(point => [point.lng, point.lat]) });

// Local alternatives have their own acceptance contract. Keep the original
// metrics and rejection reasons; do not relax the shared geometry policy.
export function evaluateLocalRouteAlternative({ matcher, match, nodes, geometry, returnedPath, plan }) {
  if (match.valid || !plan.alternativeRanges.length) return match;
  const failures = [];
  const require = (condition, reason) => { if (!condition) failures.push(reason); };
  require(!match.reasons.includes("DISCONNECTED_PROVIDER_LEGS"), "DISCONNECTED_PROVIDER_LEGS");
  require(Math.max(match.startOffsetMeters, match.endOffsetMeters) <= 40, "ENDPOINT_OFFSET");
  require(Math.abs(match.referenceLengthMeters - match.returnedLengthMeters) <= match.referenceLengthMeters * .10
    && Math.abs(match.referenceLengthMeters - match.returnedPathLengthMeters) <= match.referenceLengthMeters * .10,
  "LENGTH_MISMATCH");
  require(Math.abs(match.returnedLengthMeters - match.returnedPathLengthMeters)
    <= Math.max(75, match.returnedPathLengthMeters * .10), "REPORTED_LENGTH_MISMATCH");
  require(Math.max(match.referenceToReturnedP95Meters, match.returnedToReferenceP95Meters) <= 50, "P95_DEVIATION");
  require(Math.max(match.orderedMaximumDeviationMeters, match.referenceToReturnedMaxMeters,
    match.returnedToReferenceMaxMeters) <= 250, "MAXIMUM_DEVIATION");
  require(match.referenceOutsideCorridorMeters / match.referenceLengthMeters <= .08
    && match.returnedOutsideCorridorMeters / match.returnedPathLengthMeters <= .08, "OUTSIDE_CORRIDOR");
  require(Math.max(match.referenceLongestDeviationMeters, match.returnedLongestDeviationMeters) <= 800,
    "CONTINUOUS_DEVIATION");
  const rejected = () => ({ ...match, localAlternativeRejectionReasons: [...new Set(failures)] });
  if (failures.length) return rejected();

  const returned = buildGeometryFromCoordinates(returnedPath.coordinates);
  let stops;
  try {
    stops = matchStopsToRoute(nodes.map((node, index) => ({
      stationName: node.name ?? `CURRENT LOCATION ${index}`,
      ...node.providerCoordinate
    })), returned);
  } catch {
    failures.push("STOP_ORDER_OR_AMBIGUITY");
    return rejected();
  }
  require(stops.every(stop => stop.distanceToRoute <= 50), "STOP_OFFSET");
  // Pin endpoint progress to the provider's actual endpoints, so no length can
  // disappear before the first stop or after the last stop.
  stops[0].distanceAlongRoute = 0;
  stops.at(-1).distanceAlongRoute = returned.totalLength;
  const alternativeIntervals = nodes.slice(1).map((node, index) =>
    plan.alternativeRanges.some(range => nodes[index].distanceAlongRoute < range.end
      && node.distanceAlongRoute > range.start));
  const alternatives = [];
  for (let i = 0; i < nodes.length - 1; i += 1) {
    const referenceLength = nodes[i + 1].distanceAlongRoute - nodes[i].distanceAlongRoute;
    const returnedLength = stops[i + 1].distanceAlongRoute - stops[i].distanceAlongRoute;
    require(returnedLength > 1, "STOP_ORDER_MISMATCH");
    if (!alternativeIntervals[i]) continue;
    require(referenceLength <= 1_000, "ALTERNATIVE_INTERVAL_TOO_LONG");
    require(returnedLength >= referenceLength * .5 && returnedLength <= referenceLength * 1.5
      && Math.abs(returnedLength - referenceLength) <= 500, "ALTERNATIVE_INTERVAL_LENGTH_MISMATCH");
    alternatives.push({ fromStationIndex: nodes[i].stationIndex ?? null,
      toStationIndex: nodes[i + 1].stationIndex ?? null,
      startDistanceAlongRoute: rounded(nodes[i].distanceAlongRoute),
      endDistanceAlongRoute: rounded(nodes[i + 1].distanceAlongRoute),
      referenceLengthMeters: rounded(referenceLength), returnedLengthMeters: rounded(returnedLength) });
  }
  if (failures.length) return rejected();

  // Validate contiguous unchanged blocks, rather than inventing stricter
  // thresholds at every artificial waypoint boundary.
  for (let i = 0; i < alternativeIntervals.length;) {
    if (alternativeIntervals[i]) { i += 1; continue; }
    const start = i;
    while (i < alternativeIntervals.length && !alternativeIntervals[i]) i += 1;
    const referenceStart = nodes[start].distanceAlongRoute;
    const outside = matcher.evaluate(line(geometry, referenceStart, nodes[i].distanceAlongRoute),
      line(returned, stops[start].distanceAlongRoute, stops[i].distanceAlongRoute),
      stops[i].distanceAlongRoute - stops[start].distanceAlongRoute,
      nodes.slice(start, i + 1).map(node => node.distanceAlongRoute - referenceStart));
    if (!outside.valid) failures.push("DEVIATION_OUTSIDE_ALTERNATIVE");
  }
  if (failures.length) return rejected();
  return { ...match, valid: true, quality: "approximate", reasons: [],
    acceptanceBasis: "stop-preserving-local-alternative", referenceGeometryValid: false,
    referenceGeometryReasons: [...match.reasons], alternatives,
    maximumStopOffsetMeters: rounded(Math.max(...stops.map(stop => stop.distanceToRoute))),
    stopProgressMeters: stops.map(stop => stop.distanceAlongRoute) };
}
