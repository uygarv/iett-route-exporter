import { buildRouteGeometry, haversineDistance, pointAlongRoute } from "./geometry.js";

export const DEFAULT_GEOMETRY_POLICY = Object.freeze({
  sampleSpacingMeters: 10,
  endpointOffsetMeters: 40,
  strictP95Meters: 35,
  strictMaxMeters: 80,
  approximateP95Meters: 50,
  approximateMaxMeters: 150,
  corridorMeters: 35,
  maxOutsideFraction: 0.08,
  maxContinuousDeviationMeters: 400,
  lengthToleranceMeters: 75,
  lengthToleranceFraction: 0.10,
  localLengthToleranceFraction: 0.35,
  localWindowMeters: 500,
  maxOppositeDirectionRunMeters: 50
});

const CELL = 100;
const rounded = value => Math.round(value * 10) / 10;
const cellKey = (x, y) => `${x},${y}`;

function prepare(coordinates) {
  const geometry = buildRouteGeometry(`LINESTRING (${coordinates.map(p => p.join(" ")).join(",")})`);
  const points = geometry.points.map(p => geometry.projector.project(p));
  const edges = [], grid = new Map();
  for (let i = 1; i < points.length; i += 1) {
    const a = points[i - 1], b = points[i];
    const dx = b.x - a.x, dy = b.y - a.y, squared = dx * dx + dy * dy;
    if (!squared) continue;
    const edge = { a, dx, dy, squared, length: Math.sqrt(squared),
      start: geometry.cumulativeDistances[i - 1],
      span: geometry.cumulativeDistances[i] - geometry.cumulativeDistances[i - 1] };
    const index = edges.push(edge) - 1;
    const count = Math.max(1, Math.ceil(Math.max(Math.abs(dx), Math.abs(dy)) / CELL));
    const visited = new Set();
    for (let j = 0; j <= count; j += 1) {
      const x = Math.floor((a.x + dx * j / count) / CELL);
      const y = Math.floor((a.y + dy * j / count) / CELL);
      for (let ox = -1; ox <= 1; ox += 1) for (let oy = -1; oy <= 1; oy += 1) {
        const key = cellKey(x + ox, y + oy);
        if (visited.has(key)) continue;
        visited.add(key);
        if (!grid.has(key)) grid.set(key, []);
        grid.get(key).push(index);
      }
    }
  }
  return { geometry, edges, grid };
}

function nearestProjection(target, point) {
  const p = target.geometry.projector.project(point);
  const x = Math.floor(p.x / CELL), y = Math.floor(p.y / CELL);
  const indices = new Set();
  for (let ox = -1; ox <= 1; ox += 1) for (let oy = -1; oy <= 1; oy += 1) {
    for (const index of target.grid.get(cellKey(x + ox, y + oy)) ?? []) indices.add(index);
  }
  let best = { distance: Infinity, progress: 0 };
  function consider(edge) {
    const t = Math.max(0, Math.min(1, ((p.x - edge.a.x) * edge.dx + (p.y - edge.a.y) * edge.dy) / edge.squared));
    const distance = Math.hypot(p.x - edge.a.x - t * edge.dx, p.y - edge.a.y - t * edge.dy);
    if (distance < best.distance) best = { distance, progress: edge.start + t * edge.span };
  }
  if (indices.size) for (const index of indices) consider(target.edges[index]);
  else for (const edge of target.edges) consider(edge);
  if (indices.size && best.distance > 150) for (let index = 0; index < target.edges.length; index += 1) {
    if (!indices.has(index)) consider(target.edges[index]);
  }
  return best;
}

// A banded discrete Frechet alignment covers both paths in order, including
// loops. Nearest-point distances alone cannot detect an omitted out-and-back.
function orderedAlignment(reference, returned, policy) {
  function sample(geometry) {
    const result = [];
    for (let at = 0; ; at = Math.min(geometry.totalLength, at + policy.sampleSpacingMeters)) {
      const point = pointAlongRoute(geometry, at);
      const xy = reference.geometry.projector.project(point);
      result.push({ at, point, ...xy });
      if (at === geometry.totalLength) break;
    }
    return result;
  }
  const a = sample(reference.geometry), b = sample(returned.geometry);
  const band = Math.ceil(Math.max(1_500, Math.abs(reference.geometry.totalLength - returned.geometry.totalLength) + 500)
    / policy.sampleSpacingMeters);
  let previousMax = new Float64Array(b.length).fill(Infinity);
  let previousCost = new Float64Array(b.length).fill(Infinity);
  const parents = [];
  for (let i = 0; i < a.length; i += 1) {
    const currentMax = new Float64Array(b.length).fill(Infinity);
    const currentCost = new Float64Array(b.length).fill(Infinity);
    const center = Math.round(i / (a.length - 1) * (b.length - 1));
    const from = Math.max(0, center - band), to = Math.min(b.length - 1, center + band);
    const row = new Uint8Array(to - from + 1);
    for (let j = from; j <= to; j += 1) {
      const distance = Math.hypot(a[i].x - b[j].x, a[i].y - b[j].y);
      if (i === 0 && j === 0) { currentMax[j] = distance; currentCost[j] = distance ** 2; continue; }
      let maximum = i && j ? Math.max(distance, previousMax[j - 1]) : Infinity;
      let cost = i && j ? previousCost[j - 1] + distance ** 2 : Infinity;
      let direction = 1;
      if (i) {
        const nextMax = Math.max(distance, previousMax[j]);
        const nextCost = previousCost[j] + 100 + distance ** 2;
        if (nextMax < maximum || (nextMax === maximum && nextCost < cost)) {
          maximum = nextMax; cost = nextCost; direction = 2;
        }
      }
      if (j) {
        const nextMax = Math.max(distance, currentMax[j - 1]);
        const nextCost = currentCost[j - 1] + 100 + distance ** 2;
        if (nextMax < maximum || (nextMax === maximum && nextCost < cost)) {
          maximum = nextMax; cost = nextCost; direction = 3;
        }
      }
      currentMax[j] = maximum; currentCost[j] = cost; row[j - from] = direction;
    }
    parents.push({ from, row }); previousMax = currentMax; previousCost = currentCost;
  }
  const forward = new Array(a.length), reverse = new Array(b.length);
  let i = a.length - 1, j = b.length - 1;
  while (i >= 0 && j >= 0) {
    const distance = Math.hypot(a[i].x - b[j].x, a[i].y - b[j].y);
    if (!forward[i] || distance < forward[i].distance) forward[i] = { distance, progress: b[j].at };
    if (!reverse[j] || distance < reverse[j].distance) reverse[j] = { distance, progress: a[i].at };
    if (i === 0 && j === 0) break;
    const direction = parents[i].row[j - parents[i].from];
    if (direction === 1) { i -= 1; j -= 1; }
    else if (direction === 2) i -= 1;
    else if (direction === 3) j -= 1;
    else throw new Error("No ordered geometry alignment could be constructed.");
  }
  return { forward, reverse, maximum: previousMax.at(-1) };
}

function align(source, target, policy, ordered) {
  const matched = [], length = source.geometry.totalLength;
  let index = 0;
  for (let at = 0; ; at = Math.min(length, at + policy.sampleSpacingMeters)) {
    const point = pointAlongRoute(source.geometry, at);
    const a = target.geometry.projector.project(pointAlongRoute(source.geometry, at - 5));
    const b = target.geometry.projector.project(pointAlongRoute(source.geometry, at + 5));
    const tangent = { x: b.x - a.x, y: b.y - a.y, length: Math.hypot(b.x - a.x, b.y - a.y) };
    const nearest = nearestProjection(target, point);
    const progress = ordered[index].progress;
    const ta = target.geometry.projector.project(pointAlongRoute(target.geometry, progress - 5));
    const tb = target.geometry.projector.project(pointAlongRoute(target.geometry, progress + 5));
    const targetLength = Math.hypot(tb.x - ta.x, tb.y - ta.y);
    matched.push({ at, weight: Math.min(policy.sampleSpacingMeters, length - at), progress,
      // Continuous projection removes up to half a sample of discretization error
      // only where the nearest point is also consistent with the ordered match.
      distance: Math.abs(nearest.progress - progress) <= 20 ? nearest.distance : ordered[index].distance,
      cosine: tangent.length && targetLength ? (tangent.x * (tb.x - ta.x) + tangent.y * (tb.y - ta.y)) / (tangent.length * targetLength) : 1 });
    index += 1;
    if (at === length) break;
  }
  const orderMismatches = matched.filter(p => p.distance > policy.approximateMaxMeters).map(p => rounded(p.at));
  const orderViolation = orderMismatches.length > 0;
  let outside = 0, oppositeRun = 0, maxOppositeRun = 0;
  const intervals = [];
  let interval;
  for (const sample of matched) {
    if (sample.distance > policy.corridorMeters && sample.weight > 0) {
      outside += sample.weight;
      if (!interval) interval = { startMeters: sample.at, endMeters: sample.at, maximumDeviationMeters: 0 };
      interval.endMeters = sample.at + sample.weight;
      interval.maximumDeviationMeters = Math.max(interval.maximumDeviationMeters, sample.distance);
    } else if (interval) { intervals.push(interval); interval = null; }
    oppositeRun = sample.cosine < -0.5 ? oppositeRun + sample.weight : 0;
    maxOppositeRun = Math.max(maxOppositeRun, oppositeRun);
  }
  if (interval) intervals.push(interval);
  let weight = 0, p95 = 0;
  for (const sample of [...matched].sort((a, b) => a.distance - b.distance)) {
    weight += sample.weight;
    if (weight >= length * .95) { p95 = sample.distance; break; }
  }
  function progressAt(at) {
    const index = Math.min(matched.length - 2, Math.floor(at / policy.sampleSpacingMeters));
    const a = matched[Math.max(0, index)], b = matched[Math.max(0, index) + 1];
    return a.progress + (b.progress - a.progress) * (at - a.at) / (b.at - a.at);
  }
  let localDistortion = false;
  const window = policy.localWindowMeters;
  for (let at = 0; at + window <= length; at += window / 2) {
    const traveled = progressAt(at + window) - progressAt(at);
    if (Math.abs(traveled - window) > Math.max(policy.lengthToleranceMeters, window * policy.localLengthToleranceFraction)) {
      localDistortion = true;
    }
  }
  return { p95, maximum: Math.max(...matched.map(p => p.distance)), outside, orderMismatches,
    longestRun: Math.max(0, ...intervals.map(p => p.endMeters - p.startMeters)),
    maxOppositeRun, orderViolation, localDistortion, progressAt,
    intervals: intervals.map(p => Object.fromEntries(Object.entries(p).map(([k, v]) => [k, rounded(v)]))) };
}

export function createGeometryMatcher({ policy: input = {}, maxEntries = 128 } = {}) {
  const policy = { ...DEFAULT_GEOMETRY_POLICY, ...input };
  for (const [key, value] of Object.entries(policy)) {
    if (!Number.isFinite(value) || value <= 0) throw new RangeError(`Invalid geometry policy: ${key}`);
  }
  if (!Number.isInteger(maxEntries) || maxEntries < 1) throw new RangeError("Geometry cache size must be positive.");
  const geometries = new Map(), results = new Map();
  function remember(cache, key, value) {
    if (cache.size >= maxEntries) cache.delete(cache.keys().next().value);
    cache.set(key, value);
    return value;
  }
  function prepared(path) {
    const key = JSON.stringify(path.coordinates);
    return geometries.get(key) ?? remember(geometries, key, prepare(path.coordinates));
  }
  return {
    evaluate(referencePath, returnedPath, reportedLength, stopDistances = []) {
      const key = JSON.stringify([referencePath, returnedPath, reportedLength, stopDistances]);
      if (results.has(key)) return structuredClone(results.get(key));
      const reference = prepared(referencePath), returned = prepared(returnedPath);
      const a = reference.geometry, b = returned.geometry;
      const ordered = orderedAlignment(reference, returned, policy);
      const forward = align(reference, returned, policy, ordered.forward);
      const reverse = align(returned, reference, policy, ordered.reverse);
      const lengthTolerance = Math.max(policy.lengthToleranceMeters, a.totalLength * policy.lengthToleranceFraction);
      const reasons = [];
      if (ordered.maximum > policy.approximateMaxMeters) reasons.push("ORDERED_PATH_DEVIATION");
      const startOffset = haversineDistance(a.points[0], b.points[0]);
      const endOffset = haversineDistance(a.points.at(-1), b.points.at(-1));
      if (Math.max(startOffset, endOffset) > policy.endpointOffsetMeters) reasons.push("ENDPOINT_OFFSET");
      if (Math.abs(a.totalLength - b.totalLength) > lengthTolerance
        || Math.abs(a.totalLength - reportedLength) > lengthTolerance
        || Math.abs(b.totalLength - reportedLength) > Math.max(policy.lengthToleranceMeters, b.totalLength * .10)) reasons.push("LENGTH_MISMATCH");
      for (const [name, match, geometry] of [["reference", forward, a], ["returned", reverse, b]]) {
        if (match.p95 > policy.approximateP95Meters || match.maximum > policy.approximateMaxMeters) reasons.push(`${name.toUpperCase()}_DEVIATION`);
        if (match.outside / geometry.totalLength > policy.maxOutsideFraction) reasons.push(`${name.toUpperCase()}_OUTSIDE_CORRIDOR`);
        if (match.longestRun > policy.maxContinuousDeviationMeters) reasons.push(`${name.toUpperCase()}_CONTINUOUS_DEVIATION`);
        if (match.orderViolation) reasons.push(`${name.toUpperCase()}_ORDER_MISMATCH`);
        if (match.localDistortion) reasons.push(`${name.toUpperCase()}_LOCAL_SHORTCUT_OR_DETOUR`);
        if (match.maxOppositeRun >= policy.maxOppositeDirectionRunMeters) reasons.push(`${name.toUpperCase()}_WRONG_DIRECTION`);
      }
      for (let i = 1; i < stopDistances.length; i += 1) {
        const distance = stopDistances[i] - stopDistances[i - 1];
        const traveled = forward.progressAt(stopDistances[i]) - forward.progressAt(stopDistances[i - 1]);
        if (traveled < -2 || Math.abs(traveled - distance) > Math.max(policy.lengthToleranceMeters, distance * policy.localLengthToleranceFraction)) {
          reasons.push("STOP_INTERVAL_MISMATCH"); break;
        }
      }
      const strict = Math.max(forward.p95, reverse.p95) <= policy.strictP95Meters
        && Math.max(forward.maximum, reverse.maximum, ordered.maximum) <= policy.strictMaxMeters;
      const metrics = {
        orderedMaximumDeviationMeters: ordered.maximum,
        referenceLengthMeters: a.totalLength, returnedLengthMeters: reportedLength,
        returnedPathLengthMeters: b.totalLength, startOffsetMeters: startOffset, endOffsetMeters: endOffset,
        referenceToReturnedP95Meters: forward.p95, referenceToReturnedMaxMeters: forward.maximum,
        returnedToReferenceP95Meters: reverse.p95, returnedToReferenceMaxMeters: reverse.maximum,
        referenceOutsideCorridorMeters: forward.outside, returnedOutsideCorridorMeters: reverse.outside,
        referenceLongestDeviationMeters: forward.longestRun, returnedLongestDeviationMeters: reverse.longestRun
      };
      const result = { ...Object.fromEntries(Object.entries(metrics).map(([k, v]) => [k, rounded(v)])),
        valid: !reasons.length, quality: reasons.length ? "rejected" : strict ? "validated" : "approximate",
        reasons, deviations: { reference: forward.intervals, returned: reverse.intervals },
        orderMismatches: { reference: forward.orderMismatches, returned: reverse.orderMismatches } };
      remember(results, key, result);
      return structuredClone(result);
    },
    clear() { geometries.clear(); results.clear(); }
  };
}

export function compareGeometryMatches(a, b) {
  const score = match => [match.valid ? 0 : 1, match.quality === "validated" ? 0 : 1,
    match.orderedMaximumDeviationMeters,
    Math.max(match.referenceToReturnedP95Meters, match.returnedToReferenceP95Meters),
    Math.max(match.referenceToReturnedMaxMeters, match.returnedToReferenceMaxMeters),
    Math.abs(match.referenceLengthMeters - match.returnedLengthMeters)];
  const first = score(a), second = score(b);
  for (let i = 0; i < first.length; i += 1) if (first[i] !== second[i]) return first[i] - second[i];
  return 0;
}
