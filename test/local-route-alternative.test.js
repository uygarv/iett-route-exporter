import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { buildRouteGeometry, pointAlongRoute } from "../src/routing/geometry.js";
import { createGeometryMatcher } from "../src/routing/geometry-match.js";
import { matchStopsToRoute, sliceRouteGeometry } from "../src/routing/timing.js";
import { evaluateLocalRouteAlternative } from "../src/routing/local-route-alternative.js";
import { createTomTomControls, localTomTomPlan } from "../src/routing/tomtom-controls.js";

const fixture = JSON.parse(await readFile(new URL("./fixtures/256-local-routing.json", import.meta.url), "utf8"));
const geometry = buildRouteGeometry(fixture.routeData[0].line);
const nodes = matchStopsToRoute(fixture.routeData[0].stationPlaces, geometry).map(stop => ({
  type: "station", name: stop.name, stationIndex: stop.stationIndex,
  ...stop.coordinate, providerCoordinate: stop.providerCoordinate, distanceAlongRoute: stop.distanceAlongRoute
}));
const reference = { type: "LineString", coordinates: sliceRouteGeometry(geometry,
  nodes[0].distanceAlongRoute, nodes.at(-1).distanceAlongRoute).map(p => [p.lng, p.lat]) };
const route = fixture.cases[0].exchanges[1].response.routes[0];
const returnedPath = { type: "LineString", coordinates: route.legs.flatMap((leg, index) =>
  index ? leg.path.coordinates.slice(1) : leg.path.coordinates) };
const matcher = createGeometryMatcher();
const match = matcher.evaluate(reference, returnedPath, route.legs.reduce((sum, leg) => sum + leg.summary.lengthInMeters, 0),
  nodes.map(node => node.distanceAlongRoute - nodes[0].distanceAlongRoute));
const plan = localTomTomPlan(nodes, geometry, match, { distances: [], alternativeRanges: [], waypointOnly: false });
const evaluate = overrides => evaluateLocalRouteAlternative({ matcher, match, nodes, geometry, returnedPath, plan, ...overrides });

test("a nearby route needs an explicit local repair and retains its original failures when accepted", () => {
  assert.equal(match.valid, false);
  assert.equal(evaluate({ plan: { ...plan, alternativeRanges: [] } }).valid, false);
  const accepted = evaluate();
  assert.equal(accepted.valid, true);
  assert.equal(accepted.referenceGeometryValid, false);
  assert.deepEqual(accepted.referenceGeometryReasons, match.reasons);
  assert.equal(accepted.alternatives.length, 2);
  assert.ok(accepted.alternatives.some(interval => interval.referenceLengthMeters > 800 && interval.returnedLengthMeters < 510));
});

test("a local alternative cannot skip a stop or reorder nearby stops", () => {
  const finance = nodes.findIndex(node => node.name === "FİNANS MERKEZİ");
  const skipped = structuredClone(nodes);
  skipped[finance].providerCoordinate.lat += .003;
  assert.equal(evaluate({ nodes: skipped }).valid, false);
  const swapped = structuredClone(nodes);
  [swapped[finance].providerCoordinate, swapped[finance + 1].providerCoordinate]
    = [swapped[finance + 1].providerCoordinate, swapped[finance].providerCoordinate];
  assert.equal(evaluate({ nodes: swapped }).valid, false);
});

test("local direction exceptions cannot cover failures outside the declared intervals", () => {
  const result = evaluate({ plan: { ...plan, alternativeRanges: [
    { start: nodes[1].distanceAlongRoute, end: nodes[2].distanceAlongRoute }
  ] } });
  assert.equal(result.valid, false);
  assert.ok(result.localAlternativeRejectionReasons.includes("DEVIATION_OUTSIDE_ALTERNATIVE"));
});

test("combining affected stops into an interval over one kilometre is rejected", () => {
  const fewerStops = nodes.filter(node => node.name !== "FİNANS MERKEZİ");
  const result = evaluate({ nodes: fewerStops });
  assert.equal(result.valid, false);
  assert.ok(result.localAlternativeRejectionReasons.includes("ALTERNATIVE_INTERVAL_TOO_LONG"));
});

const point = (x, y) => [29 + x / (111_195 * Math.cos(41 * Math.PI / 180)), 41 + y / 111_195];
const path = points => ({ type: "LineString", coordinates: points.map(([x, y]) => point(x, y)) });
const fromPath = path => buildRouteGeometry(`LINESTRING (${path.coordinates.map(p => p.join(" ")).join(",")})`);
function synthetic(referencePath, returned, stopDistances, ranges) {
  const g = fromPath(referencePath), target = fromPath(returned);
  const localNodes = stopDistances.map((at, index) => {
    const p = pointAlongRoute(g, at);
    return { name: `STOP ${index}`, stationIndex: index, ...p, providerCoordinate: p };
  });
  const m = createGeometryMatcher();
  return evaluateLocalRouteAlternative({ matcher: m,
    match: m.evaluate(referencePath, returned, target.totalLength, stopDistances), nodes: localNodes,
    geometry: g, returnedPath: returned, plan: { alternativeRanges: ranges } });
}

test("a short stop interval cannot be replaced with a detour hidden in a long route", () => {
  const a = path([[0, 0], [10_000, 0]]);
  const b = path([[0, 0], [4_000, 0], [4_000, 100], [4_024, 100], [4_024, 0], [10_000, 0]]);
  const result = synthetic(a, b, [0, 4_000, 4_024, fromPath(a).totalLength], [{ start: 4_000, end: 4_024 }]);
  assert.equal(result.valid, false);
  assert.ok(result.localAlternativeRejectionReasons.includes("ALTERNATIVE_INTERVAL_LENGTH_MISMATCH"));
});

test("reversed loops and omitted out-and-back travel cannot use local acceptance", () => {
  for (const [a, b] of [
    [path([[0, 0], [1_000, 0], [1_000, 500], [0, 500], [0, 0], [2_000, 0]]),
      path([[0, 0], [0, 500], [1_000, 500], [1_000, 0], [0, 0], [2_000, 0]])],
    [path([[0, 0], [5_000, 0], [5_000, 30], [4_500, 30], [4_500, 0], [10_000, 0]]),
      path([[0, 0], [10_000, 0]])]
  ]) {
    const length = fromPath(a).totalLength;
    assert.equal(synthetic(a, b, [0, length], [{ start: 0, end: length }]).valid, false);
  }
});

test("large repairs respect TomTom's waypoint limit and keep controls at least sixty metres apart", () => {
  const g = fromPath(path([[0, 0], [30_000, 0]]));
  const manyNodes = Array.from({ length: 501 }, (_, i) => {
    const p = pointAlongRoute(g, g.totalLength * i / 500);
    return { ...p, providerCoordinate: p };
  });
  const repaired = localTomTomPlan(manyNodes, g, { deviations: { reference: [
    { startMeters: 0, endMeters: g.totalLength, maximumDeviationMeters: 200 }
  ] } }, { distances: [], alternativeRanges: [], waypointOnly: false }, true);
  assert.ok(repaired.distances.length <= 150);
  const controls = createTomTomControls(manyNodes, g, 20, repaired.distances);
  for (let i = 1; i < controls.length; i += 1) {
    assert.ok(controls[i].distanceAlongRoute - controls[i - 1].distanceAlongRoute >= 60);
  }
});
