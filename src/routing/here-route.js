import { AppError } from "../shared/errors.js";
import { buildRouteGeometry, pointAlongRoute, findRoutePositionCandidates, haversineDistance } from "./geometry.js";
import { decodeFlexiblePolyline } from "./flexible-polyline.js";
import { publicNode, roundSegmentDistances } from "../services/travel-time-common.js";

const point = p => ({ lng: p[0], lat: p[1] });
export const pathGeometry = path => buildRouteGeometry(`LINESTRING (${path.coordinates.map(p => p.join(" ")).join(",")})`,
  { minimumPointSpacingMeters: 0 });
const path = points => ({ type: "LineString", coordinates: points.map(p => [p.lng, p.lat]) });
const nonNegative = n => typeof n === "number" && Number.isFinite(n) && n >= 0;
const malformed = () => new AppError(502, "HERE_MALFORMED_RESPONSE", "HERE returned invalid route geometry or timing data.");
export const reconstructionError = details => new AppError(502, "IETT_ROUTE_RECONSTRUCTION_FAILED",
  "HERE returned geometry that does not follow the IETT route.", details);

export function referenceSlice(geometry, start, end) {
  const points = [pointAlongRoute(geometry, start), ...geometry.points.filter((_p, i) =>
    geometry.cumulativeDistances[i] > start && geometry.cumulativeDistances[i] < end), pointAlongRoute(geometry, end)];
  return points.filter((p, i) => !i || haversineDistance(points[i - 1], p) > 0.01);
}

export function createHereTrace(original, nodes, dwellTimeSeconds) {
  const offset = nodes[0].distanceAlongRoute;
  const referencePath = path(referenceSlice(original, offset, nodes.at(-1).distanceAlongRoute));
  const geometry = pathGeometry(referencePath);
  const markers = geometry.cumulativeDistances.map((at, i) => ({ at, coordinate: geometry.points[i] }));
  for (let at = 0; at < geometry.totalLength; at += 5) markers.push({ at, coordinate: pointAlongRoute(geometry, at) });
  nodes.slice(1, -1).forEach(node => {
    const at = Math.min(geometry.totalLength, node.distanceAlongRoute - offset);
    markers.push({ at, coordinate: pointAlongRoute(geometry, at), stop: true });
  });
  markers.sort((a, b) => a.at - b.at);
  const trace = [], via = [], traceDistances = [];
  let previous = -Infinity;
  for (const marker of markers) {
    if (marker.at - previous > 0.001) {
      trace.push({ lat: marker.coordinate.lat, lng: marker.coordinate.lng });
      traceDistances.push(marker.at);
      previous = marker.at;
    }
    if (marker.stop) via.push({ index: trace.length - 1, stopDuration: dwellTimeSeconds });
  }
  return { geometry, referencePath, trace, via, traceDistances, offset };
}

// Limits apply to each HERE request, never to the length of an IETT line.
// Share a boundary point so splitting cannot omit a metre of source geometry.
export function splitHereTrace(reference, { maximumPoints = 50_000, maximumBytes = 10 * 1024 * 1024 } = {}) {
  const parts = [];
  for (let first = 0; first < reference.trace.length - 1;) {
    let last = Math.min(reference.trace.length - 1, first + maximumPoints - 1);
    // Avoid creating a final sub-metre geometry from a single leftover vertex.
    while (last < reference.trace.length - 1 && last > first + 1
      && reference.geometry.totalLength - reference.traceDistances[last] < 2) last--;
    let trace, via;
    for (;;) {
      trace = reference.trace.slice(first, last + 1);
      via = reference.via.filter(v => v.index > first && v.index < last).map(v => ({ ...v, index: v.index - first }));
      if (Buffer.byteLength(JSON.stringify({ trace, via })) <= maximumBytes) break;
      last = first + Math.floor((last - first) / 2);
      if (last <= first) throw new RangeError("HERE trace request limits cannot fit two coordinates.");
    }
    const start = reference.traceDistances[first], end = reference.traceDistances[last];
    const referencePath = path(referenceSlice(reference.geometry, start, end));
    parts.push({ geometry: pathGeometry(referencePath), referencePath, trace, via,
      offset: reference.offset + start, start, end });
    first = last;
  }
  return parts;
}

export function readHereRoute(data) {
  const route = data?.routes?.[0];
  if (!route) throw new AppError(502, "HERE_NO_ROUTE", "HERE returned no usable route.");
  if (!Array.isArray(route.sections) || !route.sections.length) throw malformed();
  const routeNotices = [...(data.notices ?? []), ...(route.notices ?? [])];
  const notices = [...routeNotices, ...route.sections.flatMap(s => s.notices ?? [])];
  if (routeNotices.some(n => n.severity === "critical")) throw reconstructionError({
    notices: notices.map(n => ({ code: n.code, severity: n.severity }))
  });
  const pieces = route.sections.map((section, index) => {
    // A restriction on one imported section must not discard timing from the
    // remaining valid roads. Its original source interval becomes an estimate.
    if (section.notices?.some(n => n.severity === "critical")) return null;
    const summary = section.travelSummary;
    const departure = Date.parse(section.departure?.time), arrival = Date.parse(section.arrival?.time);
    if (!summary || !nonNegative(summary.duration) || !nonNegative(summary.length)
      || !nonNegative(summary.baseDuration) || (summary.typicalDuration !== undefined && !nonNegative(summary.typicalDuration))
      || !Number.isFinite(departure) || !Number.isFinite(arrival) || arrival < departure) throw malformed();
    // Import can snap successive stop indices to the same road position. Its
    // zero-driving section still contains dwell, which the public stop timeline
    // already accounts for. Do not build a geometry from that zero-length leg.
    if (summary.length === 0 && summary.duration === 0) return null;
    let decoded, geometry;
    try { decoded = decodeFlexiblePolyline(section.polyline); geometry = pathGeometry(decoded); }
    catch { throw malformed(); }
    if (geometry.totalLength <= 0 || (summary.length === 0 && summary.duration > 0)) throw malformed();
    const spans = section.spans;
    if (spans !== undefined && (!Array.isArray(spans) || spans.some((span, i) => !Number.isInteger(span.offset)
      || span.offset < 0 || span.offset >= decoded.coordinates.length
      || (i === 0 && span.offset !== 0) || (i > 0 && span.offset <= spans[i - 1].offset)
      || !nonNegative(span.duration) || !nonNegative(span.length)))) throw malformed();
    return { path: decoded, geometry, distanceMeters: summary.length, duration: summary.duration,
      baseDuration: summary.baseDuration, typicalDuration: summary.typicalDuration,
      spans, source: "provider", sectionIndex: index,
      summary: section.summary, travelSummary: summary,
      departureTime: section.departure.time, arrivalTime: section.arrival.time };
  }).filter(Boolean);
  if (!pieces.length) throw new AppError(502, "HERE_NO_ROUTE", "HERE returned no traversable route between the requested locations.",
    { notices: notices.map(n => ({ code: n.code, severity: n.severity })) });
  return { pieces, handle: typeof route.routeHandle === "string" ? route.routeHandle : undefined,
    sectionCount: route.sections.length,
    summaries: route.sections.map(s => ({ summary: s.summary, travelSummary: s.travelSummary,
      departureTime: s.departure.time, arrivalTime: s.arrival.time })),
    notices: notices.map(n => ({ code: n.code, severity: n.severity })) };
}

function position(geometry, coordinate, expected, minimum) {
  const candidates = findRoutePositionCandidates(geometry, point(coordinate))
    .filter(p => p.distanceAlongRoute >= minimum - 5);
  const score = p => p.distanceToRoute + Math.abs(p.distanceAlongRoute - expected) * 0.05;
  const best = candidates.reduce((a, b) => !a || score(b) < score(a) ? b : a, null);
  if (!best) throw reconstructionError({ reason: "PROVIDER_SECTION_ORDER_MISMATCH" });
  return best.distanceAlongRoute;
}

export function connector(reference, start, end, before, after) {
  const source = referenceSlice(reference.geometry, start, end);
  const coordinates = source.map(p => [p.lng, p.lat]);
  if (before) coordinates.unshift(before);
  if (after) coordinates.push(after);
  const distinct = coordinates.filter((p, i) => !i || haversineDistance(point(p), point(coordinates[i - 1])) > 0.01);
  if (distinct.length < 2) return null;
  const result = { path: { type: "LineString", coordinates: distinct }, start, end, source: "gap" };
  result.geometry = pathGeometry(result.path);
  result.distanceMeters = result.geometry.totalLength;
  return result.distanceMeters >= 1 ? result : null;
}

// Keep separate physical sections until every seam is accounted for. Joining
// polylines first would silently invent a zero-time connection across a gap.
export function locateHerePieces(native, reference) {
  const result = [];
  let progress = 0, lastCoordinate;
  for (const piece of native) {
    const first = piece.path.coordinates[0], last = piece.path.coordinates.at(-1);
    const start = position(reference.geometry, first, progress, progress);
    const end = position(reference.geometry, last, start + piece.geometry.totalLength, start);
    if (end < start - 1 || start < progress - 5) throw reconstructionError({ reason: "PROVIDER_SECTION_ORDER_MISMATCH" });
    const gapDistance = lastCoordinate ? haversineDistance(point(lastCoordinate), point(first))
      : haversineDistance(reference.geometry.points[0], point(first));
    if (start - progress > 5 || gapDistance > 5) {
      const gap = connector(reference, progress, Math.max(progress, start), lastCoordinate, first);
      if (gap) result.push(gap);
    }
    result.push({ ...piece, start: start - progress <= 5 && gapDistance <= 5 ? progress : Math.max(progress, start),
      end: Math.max(progress, end) });
    progress = Math.max(progress, end); lastCoordinate = last;
  }
  if (reference.geometry.totalLength - progress > 5
    || haversineDistance(point(lastCoordinate), reference.geometry.points.at(-1)) > 5) {
    const gap = connector(reference, progress, reference.geometry.totalLength, lastCoordinate);
    if (gap) result.push(gap);
  } else result.at(-1).end = reference.geometry.totalLength;
  return result;
}

export function joinHerePieces(pieces) {
  const coordinates = [];
  for (const piece of pieces) {
    piece.pathOffset = coordinates.length && haversineDistance(point(coordinates.at(-1)), point(piece.path.coordinates[0])) <= 0.01
      ? coordinates.length - 1 : coordinates.length;
    for (const p of piece.path.coordinates) {
      if (!coordinates.length || haversineDistance(point(coordinates.at(-1)), point(p)) > 0.01) coordinates.push(p);
    }
  }
  return { type: "LineString", coordinates };
}

// Salvage timing only where a provider section follows this occurrence of the
// source path. A rejected detour/reversed section never replaces IETT geometry.
// Link spans let us retain correct roads on either side of a bad section.
export function validatedHereCoverage(native, reference, matcher, stopDistances = []) {
  const accepted = [], rejected = [];
  let progress = 0;
  function consider(piece, split = true) {
    let start, end, match;
    try {
      start = Math.max(progress, position(reference.geometry, piece.path.coordinates[0], progress, progress));
      end = position(reference.geometry, piece.path.coordinates.at(-1), start + piece.geometry.totalLength, start);
      if (end - start < 1) throw reconstructionError({ reason: "PROVIDER_SECTION_ORDER_MISMATCH" });
      const source = path(referenceSlice(reference.geometry, start, end));
      match = matcher.evaluate(source, piece.path, piece.distanceMeters,
        [0, ...stopDistances.filter(at => at > start && at < end).map(at => at - start), end - start]);
      if (!match.valid) throw reconstructionError({ lastReconstruction: match });
      accepted.push({ ...piece, start, end }); progress = end;
    } catch (error) {
      if (error.code !== "IETT_ROUTE_RECONSTRUCTION_FAILED") throw error;
      if (split && piece.spans?.length > 1) {
        for (let i = 0; i < piece.spans.length; i++) {
          const from = piece.spans[i].offset, to = piece.spans[i + 1]?.offset ?? piece.path.coordinates.length - 1;
          if (to <= from) continue;
          const coordinates = piece.path.coordinates.slice(from, to + 1);
          const a = piece.geometry.cumulativeDistances[from], b = piece.geometry.cumulativeDistances[to];
          if (b - a < 1) continue;
          const duration = curveValue(piece, b, "duration") - curveValue(piece, a, "duration");
          consider({ ...piece, path: { type: "LineString", coordinates }, geometry: pathGeometry({ coordinates }),
            distanceMeters: curveValue(piece, b, "length") - curveValue(piece, a, "length"),
            duration, baseDuration: curveValue(piece, b, "baseDuration") - curveValue(piece, a, "baseDuration"),
            typicalDuration: piece.typicalDuration === undefined ? undefined
              : curveValue(piece, b, "typicalDuration") - curveValue(piece, a, "typicalDuration"),
            spans: [{ offset: 0, length: b - a, duration }] }, false);
        }
      } else rejected.push({ sectionIndex: piece.sectionIndex, reasons: match?.reasons ?? [error.details?.reason] });
    }
  }
  for (const piece of native) consider(piece);
  if (!accepted.length) return { pieces: [connector(reference, 0, reference.geometry.totalLength)].filter(Boolean), rejected };
  const pieces = [];
  progress = 0;
  for (const piece of accepted) {
    if (piece.start - progress > 1) pieces.push(connector(reference, progress, piece.start));
    else piece.start = progress;
    pieces.push(piece); progress = piece.end;
  }
  if (reference.geometry.totalLength - progress > 1) pieces.push(connector(reference, progress, reference.geometry.totalLength));
  else if (pieces.length) pieces.at(-1).end = reference.geometry.totalLength;
  return { pieces: pieces.filter(Boolean), rejected };
}

export function estimateHereGaps(pieces) {
  const gaps = pieces.filter(p => p.source === "gap");
  for (const [index, piece] of pieces.entries()) {
    if (piece.source !== "gap") continue;
    const neighbours = [pieces[index - 1], pieces[index + 1]].filter(p => p?.source === "provider" && p.duration > 0);
    const speed = Math.min(2.5, ...neighbours.map(p => p.distanceMeters / p.duration));
    piece.duration = Math.max(8, Math.ceil(piece.distanceMeters / Math.max(0.1, speed)));
    piece.estimation = { method: neighbours.length ? "adjacent-here-speed-capped" : "conservative-urban-speed",
      speedMetersPerSecond: Math.max(0.1, speed), maximumSpeedMetersPerSecond: 2.5, minimumDurationSeconds: 8 };
    piece.source = "estimate";
  }
  return gaps;
}

function curveValue(piece, distance, field) {
  const total = field === "length" ? piece.distanceMeters : piece[field];
  if (distance <= 0) return 0;
  if (distance >= piece.geometry.totalLength) return total;
  const spans = piece.spans;
  if (!spans?.length || !spans.every(s => nonNegative(s[field]))) {
    return total * Math.max(0, Math.min(1, distance / piece.geometry.totalLength));
  }
  const sum = spans.reduce((n, s) => n + s[field], 0);
  if (sum <= 0) return total * distance / piece.geometry.totalLength;
  let accumulated = 0;
  for (let i = 0; i < spans.length; i += 1) {
    const start = piece.geometry.cumulativeDistances[spans[i].offset];
    const end = i + 1 === spans.length ? piece.geometry.totalLength : piece.geometry.cumulativeDistances[spans[i + 1].offset];
    if (distance <= end && end > start) return total / sum
      * (accumulated + spans[i][field] * Math.max(0, Math.min(1, (distance - start) / (end - start))));
    accumulated += spans[i][field];
  }
  return total;
}

export function herePublicSegments(pieces, reference, nodes, options, departureTime) {
  // Stop progress was already matched to the authoritative IETT geometry.
  // Re-matching it to a provider polyline can confuse repeated stops and loops.
  const stops = nodes.map(n => n.distanceAlongRoute - reference.offset);
  const totals = pieces.reduce((a, p) => ({ driving: a.driving + (p.source === "provider" ? p.duration : 0),
    base: a.base + (p.baseDuration ?? 0) }), { driving: 0, base: 0 });
  const delay = Math.max(0, totals.driving - totals.base);
  const segments = nodes.slice(1).map((node, i) => ({ index: i, from: publicNode(nodes[i]), to: publicNode(node),
    distanceMeters: 0, providerDrivingDurationSeconds: 0, estimatedUnmappedDurationSeconds: 0,
    trafficDelaySeconds: 0, dwellAfterArrivalSeconds: i === nodes.length - 2 ? 0 : options.dwellTimeSeconds,
    sources: new Set() }));
  for (const piece of pieces) {
    const length = piece.geometry.totalLength, extent = piece.end - piece.start;
    for (const segment of segments) {
      // A perpendicular snapping connector has no longitudinal extent. Assign
      // its explicitly estimated time to the interval containing that seam.
      const ownsSeam = piece.start >= stops[segment.index]
        && (piece.start < stops[segment.index + 1] || segment.index === segments.length - 1);
      const from = extent > 0 ? Math.max(0, (stops[segment.index] - piece.start) / extent * length) : 0;
      const to = extent > 0 ? Math.min(length, (stops[segment.index + 1] - piece.start) / extent * length)
        : ownsSeam ? length : 0;
      if (to <= from) continue;
      const seconds = curveValue(piece, to, "duration") - curveValue(piece, from, "duration");
      if (piece.source === "provider") {
        segment.providerDrivingDurationSeconds += seconds;
        segment.trafficDelaySeconds += totals.driving ? seconds / totals.driving * delay : 0;
        segment.sources.add(piece.spans?.length ? "here-span-interpolation" : "distance-interpolation");
      } else {
        segment.estimatedUnmappedDurationSeconds += seconds;
        segment.sources.add("iett-section-estimate");
      }
    }
  }
  for (const segment of segments) segment.distanceMeters = stops[segment.index + 1] - stops[segment.index];
  // Round cumulative values so allocation cannot create or lose seconds.
  for (const field of ["providerDrivingDurationSeconds", "estimatedUnmappedDurationSeconds", "trafficDelaySeconds"]) {
    let cumulative = 0, previous = 0;
    for (const segment of segments) {
      cumulative += segment[field]; const rounded = Math.round(cumulative);
      segment[field] = rounded - previous; previous = rounded;
    }
  }
  let timestamp = Date.parse(departureTime);
  return roundSegmentDistances(segments.map(({ sources, ...s }) => {
    s.drivingDurationSeconds = s.providerDrivingDurationSeconds + s.estimatedUnmappedDurationSeconds;
    s.stopTimingSource = sources.size === 1 ? [...sources][0] : "mixed-interpolation";
    s.departureTime = new Date(timestamp).toISOString();
    timestamp += s.drivingDurationSeconds * 1_000;
    s.arrivalTime = new Date(timestamp).toISOString();
    timestamp += s.dwellAfterArrivalSeconds * 1_000;
    s.elapsedUntilNextDepartureSeconds = s.drivingDurationSeconds + s.dwellAfterArrivalSeconds;
    if (!s.estimatedUnmappedDurationSeconds) delete s.estimatedUnmappedDurationSeconds;
    return s;
  }));
}
