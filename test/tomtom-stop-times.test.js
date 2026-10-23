import assert from "node:assert/strict";
import test from "node:test";
import { buildRouteGeometry, pointAlongRoute } from "../src/routing/geometry.js";
import { distributeTomTomLegs } from "../src/routing/tomtom-stop-times.js";

const geometry = buildRouteGeometry("LINESTRING (29 41, 29.001 41, 29.002 41, 29.003 41)");
const node = distance => {
  const point = pointAlongRoute(geometry, distance);
  return { ...point, providerCoordinate: { lat: point.lat, lng: point.lng } };
};
const step = geometry.totalLength / 3;
const nodes = [0, step, step * 2, geometry.totalLength].map(node);
const path = points => ({ type: "LineString", coordinates: points.map(point => [point.lng, point.lat]) });
const leg = (points, duration, delay, distance) => ({
  path: path(points), drivingDurationSeconds: duration, liveTrafficDelaySeconds: delay,
  distanceMeters: distance, reconstruction: { valid: true }
});

test("uses progress times instead of uniform distance to allocate slow and fast stop intervals", () => {
  const localNodes = nodes.slice(0, 3);
  const pieces = distributeTomTomLegs([leg(localNodes, 100, 20, 200)],
    [localNodes[0], localNodes.at(-1)], localNodes, [
      { pathIndex: 0, travelDurationInSeconds: 0 },
      { pathIndex: 1, travelDurationInSeconds: 90 },
      { pathIndex: 2, travelDurationInSeconds: 100 }
    ]);
  assert.deepEqual(pieces.map(piece => piece.drivingDurationSeconds), [90, 10]);
  assert.deepEqual(pieces.map(piece => piece.liveTrafficDelaySeconds), [18, 2]);
  assert.equal(pieces.reduce((sum, piece) => sum + piece.distanceMeters, 0), 200);
  assert.ok(pieces.every(piece => piece.stopTimingSource === "tomtom-progress-interpolation"));
});

test("validated stop progress keeps a stop on the correct pass of a repeated road", () => {
  const returned = [nodes[0], nodes[1], nodes[0], nodes[1], nodes[2], nodes[3]];
  const pieces = distributeTomTomLegs([leg(returned, 100, 20, 500)],
    [nodes[0], nodes.at(-1)], nodes, [
      { pathIndex: 0, travelDurationInSeconds: 0 },
      { pathIndex: 3, travelDurationInSeconds: 90 },
      { pathIndex: 4, travelDurationInSeconds: 95 },
      { pathIndex: 5, travelDurationInSeconds: 100 }
    ], [0, step * 3, step * 4, step * 5]);
  assert.deepEqual(pieces.map(piece => piece.drivingDurationSeconds), [90, 5, 5]);
  assert.equal(pieces.reduce((sum, piece) => sum + piece.distanceMeters, 0), 500);
  assert.equal(pieces.reduce((sum, piece) => sum + piece.liveTrafficDelaySeconds, 0), 20);
});

test("keeps totals and time curves when a control point falls between bus stops", () => {
  const middle = node(step * 1.5);
  const pieces = distributeTomTomLegs([
    leg([nodes[0], nodes[1], middle], 60, 12, 150),
    leg([middle, nodes[2], nodes[3]], 90, 18, 150)
  ], [nodes[0], middle, nodes[3]], nodes, [
    { pathIndex: 0, travelDurationInSeconds: 0 },
    { pathIndex: 1, travelDurationInSeconds: 40 },
    { pathIndex: 2, travelDurationInSeconds: 60 },
    { pathIndex: 3, travelDurationInSeconds: 90 },
    { pathIndex: 4, travelDurationInSeconds: 150 }
  ]);
  const durations = nodes.slice(1).map((_, index) => pieces.filter(piece => piece.publicSegmentIndex === index)
    .reduce((sum, piece) => sum + piece.drivingDurationSeconds, 0));
  assert.deepEqual(durations, [40, 50, 60]);
  assert.equal(pieces.reduce((sum, piece) => sum + piece.liveTrafficDelaySeconds, 0), 30);
  assert.equal(pieces.reduce((sum, piece) => sum + piece.distanceMeters, 0), 300);
  assert.ok(pieces.every(piece => piece.drivingDurationSeconds >= piece.liveTrafficDelaySeconds));
});

test("maps raw progress indices correctly when returned paths contain duplicate coordinates", () => {
  const localNodes = nodes.slice(0, 3);
  const pieces = distributeTomTomLegs([leg([localNodes[0], localNodes[1], localNodes[1], localNodes[2]], 100, 20, 200)],
    [localNodes[0], localNodes.at(-1)], localNodes, [
      { pathIndex: 0, travelDurationInSeconds: 0 },
      { pathIndex: 1, travelDurationInSeconds: 90 },
      { pathIndex: 3, travelDurationInSeconds: 100 }
    ]);
  assert.deepEqual(pieces.map(piece => piece.drivingDurationSeconds), [90, 10]);
});

test("handles TomTom's repeated leg boundary indices and excludes waypoint pauses from driving totals", () => {
  const middle = node(step * 1.5);
  const pieces = distributeTomTomLegs([
    leg([nodes[0], nodes[1], middle], 60, 12, 150),
    leg([middle, nodes[2], nodes[3]], 90, 18, 150)
  ], [nodes[0], middle, nodes[3]], nodes, [
    { pathIndex: 0, travelDurationInSeconds: 0 },
    { pathIndex: 1, travelDurationInSeconds: 40 },
    { pathIndex: 2, travelDurationInSeconds: 60 },
    { pathIndex: 3, travelDurationInSeconds: 80 },
    { pathIndex: 4, travelDurationInSeconds: 110 },
    { pathIndex: 5, travelDurationInSeconds: 170 }
  ]);
  const durations = nodes.slice(1).map((_, index) => pieces.filter(piece => piece.publicSegmentIndex === index)
    .reduce((sum, piece) => sum + piece.drivingDurationSeconds, 0));
  assert.deepEqual(durations, [40, 50, 60]);
  assert.ok(pieces.every(piece => piece.stopTimingSource === "tomtom-progress-interpolation"));
});

test("missing or invalid progress uses a labeled distance fallback and conserves totals", () => {
  const localNodes = nodes.slice(0, 3);
  for (const progress of [undefined, {}, [], [
    { pathIndex: 0, travelDurationInSeconds: 0 },
    { pathIndex: 1, travelDurationInSeconds: 100 },
    { pathIndex: 2, travelDurationInSeconds: 90 }
  ]]) {
    const pieces = distributeTomTomLegs([leg(localNodes, 101, 20, 200)],
      [localNodes[0], localNodes.at(-1)], localNodes, progress);
    assert.equal(pieces.reduce((sum, piece) => sum + piece.drivingDurationSeconds, 0), 101);
    assert.equal(pieces.reduce((sum, piece) => sum + piece.liveTrafficDelaySeconds, 0), 20);
    assert.ok(pieces.every(piece => piece.stopTimingSource === "distance-interpolation"));
  }
});

test("fractional provider summaries retain exact totals without negative intervals", () => {
  const localNodes = nodes.slice(0, 3);
  const pieces = distributeTomTomLegs([leg(localNodes, 0.8, 0.5, 200)],
    [localNodes[0], localNodes.at(-1)], localNodes);
  assert.equal(pieces.reduce((sum, piece) => sum + piece.drivingDurationSeconds, 0), 0.8);
  assert.equal(pieces.reduce((sum, piece) => sum + piece.liveTrafficDelaySeconds, 0), 0.5);
  assert.ok(pieces.every(piece => piece.drivingDurationSeconds >= piece.liveTrafficDelaySeconds));
});
