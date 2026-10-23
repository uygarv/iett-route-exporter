import {
  buildRouteGeometry, pointAlongRoute
} from "./geometry.js";
import { selectWaypoints } from "./waypoints.js";

const MIN_CONTROL_SPACING_METERS = 60;
const MAX_CONTROL_POINTS = 150;
const returnedGeometries = new Map();

function pathGeometry(path) {
  return buildRouteGeometry(`LINESTRING (${path.coordinates.map(point => point.join(" ")).join(", ")})`);
}

// Supporting path coordinates describe the route without forcing the router to
// stop or snap to a road separately at every bus stop.
export function createTomTomControls(nodes, geometry, dwellTimeSeconds, distances = []) {
  const start = nodes[0];
  const end = nodes.at(-1);
  const controls = [start, ...distances.map(distance => {
    const station = nodes.find(node => Math.abs(node.distanceAlongRoute - distance) < 0.01);
    if (station) return station;
    const point = pointAlongRoute(geometry, distance);
    return { type: "route-anchor", ...point, providerCoordinate: { lat: point.lat, lng: point.lng } };
  }), end];
  return controls.map((node, index) => ({
    ...node,
    pauseDurationInSeconds: index === 0 || index === controls.length - 1 ? 0
      : nodes.slice(1, -1).filter(stop => stop.distanceAlongRoute > controls[index - 1].distanceAlongRoute
        && stop.distanceAlongRoute <= node.distanceAlongRoute).length * dwellTimeSeconds
  }));
}

// A final repair targets turns near the remaining mismatches. Never fill the
// route with uniformly spaced anchors: snapping them can create large detours.
export function refineTomTomControls(geometry, controls, failedLeg, distances) {
  const start = controls[0].distanceAlongRoute;
  const end = controls.at(-1).distanceAlongRoute;
  if (end - start < MIN_CONTROL_SPACING_METERS * 3 || distances.length >= MAX_CONTROL_POINTS) return distances;
  const selected = [...distances];
  const limit = Math.min(MAX_CONTROL_POINTS, distances.length + 6);
  const centers = [...(failedLeg.geometryMatch?.orderMismatches?.reference ?? []).slice(0, 1).map(at => start + at),
    ...(failedLeg.geometryMatch?.deviations.reference ?? []).filter(region => !(failedLeg.geometryMatch?.orderMismatches?.reference ?? [])
      .some(at => at >= region.startMeters && at <= region.endMeters)).slice()
    .sort((a, b) => (b.endMeters - b.startMeters) - (a.endMeters - a.startMeters))
    .map(region => start + (region.startMeters + region.endMeters) / 2)];
  if (!centers.length) centers.push((start + end) / 2);
  const turns = [];
  function direction(a, b) {
    const x = geometry.projector.project(a), y = geometry.projector.project(b);
    return Math.atan2(y.x - x.x, y.y - x.y) * 180 / Math.PI;
  }
  for (let at = start + 40; at < end - 40; at += 20) {
    const a = pointAlongRoute(geometry, at - 40), b = pointAlongRoute(geometry, at), c = pointAlongRoute(geometry, at + 40);
    const angle = Math.abs((direction(b, c) - direction(a, b) + 540) % 360 - 180);
    if (angle >= 35) turns.push(at + 80);
  }
  function add(distance) {
    if (selected.length < limit && distance > start && distance < end
      && [start, ...selected, end].every(existing => Math.abs(existing - distance) >= MIN_CONTROL_SPACING_METERS)) {
      selected.push(distance);
      return true;
    }
    return false;
  }
  for (const center of centers.slice(0, 2)) {
    const localTurns = turns.filter(at => Math.abs(at - center) <= 600)
      .sort((a, b) => Math.abs(a - center) - Math.abs(b - center));
    if (!localTurns.some(add)) add(center);
  }
  // Preserve the exit from a tight turn, and avoid leaving one long failing
  // span on a short section. All controls are sent in the same final attempt.
  if (turns.length) {
    if (end - start <= 1_500) {
      const boundaries = [start, ...selected, end].sort((a, b) => a - b);
      const spans = boundaries.slice(1).map((to, i) => ({ from: boundaries[i], to })).sort((a, b) => (b.to - b.from) - (a.to - a.from));
      if (spans[0].to - spans[0].from > 500) add((spans[0].from + spans[0].to) / 2);
    } else {
      const region = failedLeg.geometryMatch?.deviations.reference.find(region =>
        Math.abs(start + (region.startMeters + region.endMeters) / 2 - centers[0]) <= 600);
      if (region) add(start + region.endMeters - 40);
    }
  }
  return selected.sort((a, b) => a - b);
}

export function waypointOnlyTomTomPlan(nodes, geometry) {
  const { waypoints } = selectWaypoints(geometry, {
    startDistance: nodes[0].distanceAlongRoute,
    endDistance: nodes.at(-1).distanceAlongRoute,
    maxWaypoints: 18,
    stationConstraints: nodes.filter(node => node.type === "station").map(node => ({
      ...node.providerCoordinate, rawCoordinate: { lat: node.lat, lng: node.lng },
      stationName: node.name, stationIndex: node.stationIndex,
      distanceAlongRoute: node.distanceAlongRoute, distanceToRoute: 0
    }))
  });
  const distances = [];
  for (const point of waypoints) {
    if ([nodes[0].distanceAlongRoute, ...distances, nodes.at(-1).distanceAlongRoute]
      .every(at => Math.abs(at - point.distanceAlongRoute) >= MIN_CONTROL_SPACING_METERS)) {
      distances.push(point.distanceAlongRoute);
    }
  }
  return { distances, alternativeRanges: [], waypointOnly: true };
}

export function localTomTomPlan(nodes, geometry, match, previous, refine = false) {
  const offset = nodes[0].distanceAlongRoute;
  const distances = [...previous.distances];
  const ranges = [...previous.alternativeRanges];
  const regions = [...(match?.deviations.reference ?? [])]
    .sort((a, b) => b.maximumDeviationMeters * (b.endMeters - b.startMeters)
      - a.maximumDeviationMeters * (a.endMeters - a.startMeters));
  if (!regions.length) regions.push({
    startMeters: (nodes.at(-1).distanceAlongRoute - offset) / 2,
    endMeters: (nodes.at(-1).distanceAlongRoute - offset) / 2
  });
  const endpoints = [offset, nodes.at(-1).distanceAlongRoute];
  function add(at) {
    if (distances.length < MAX_CONTROL_POINTS && !endpoints.includes(at)
      && [...endpoints, ...distances].every(existing => Math.abs(existing - at) >= MIN_CONTROL_SPACING_METERS)) {
      distances.push(at);
    }
  }
  for (const region of regions) {
    for (let i = 0; i < nodes.length - 1; i += 1) {
      const start = nodes[i].distanceAlongRoute, end = nodes[i + 1].distanceAlongRoute;
      const from = offset + region.startMeters, to = offset + region.endMeters;
      const overlaps = from === to ? start <= from && end > from : end > from && start < to;
      if (!overlaps) continue;
      add(start); add(end);
      if (!ranges.some(range => range.start === start && range.end === end)) ranges.push({ start, end });
    }
  }
  distances.sort((a, b) => a - b);
  const refined = refine ? refineTomTomControls(geometry,
    createTomTomControls(nodes, geometry, 0, distances), { geometryMatch: match }, distances) : distances;
  return { distances: refined, alternativeRanges: ranges.sort((a, b) => a.start - b.start),
    waypointOnly: previous.waypointOnly };
}

export function isTomTomAlternativeLeg(plan, from, to) {
  return plan.waypointOnly || plan.alternativeRanges.some(range => from < range.end && to > range.start);
}

export function returnedPathGeometry(path) {
  const key = JSON.stringify(path);
  if (returnedGeometries.has(key)) return returnedGeometries.get(key);
  const geometry = pathGeometry(path);
  if (returnedGeometries.size >= 64) returnedGeometries.delete(returnedGeometries.keys().next().value);
  returnedGeometries.set(key, geometry);
  return geometry;
}
