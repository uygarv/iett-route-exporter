import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { buildRouteGeometry } from "../src/routing/geometry.js";
import { matchStopsToRoute } from "../src/routing/timing.js";
import { selectWaypoints } from "../src/routing/waypoints.js";

const routes = JSON.parse(await readFile(new URL("./fixtures/here-import-routing.json", import.meta.url)));
// Expected waypoint coordinates and scores were captured before the refactor.
const cases = JSON.parse(await readFile(new URL("./fixtures/waypoint-regression.json", import.meta.url)));

for (const recorded of cases) {
  test(`preserves ${recorded.routeCode} waypoints: limit ${recorded.maxWaypoints}, partial ${recorded.partial}`, () => {
    const data = routes.cases.find(route => route.routeCode === recorded.routeCode).routeData[0];
    const geometry = buildRouteGeometry(data.line);
    const stops = matchStopsToRoute(data.stationPlaces, geometry);
    const stationConstraints = stops.map(stop => ({
      ...stop.providerCoordinate, rawCoordinate: stop.coordinate,
      stationName: stop.name, stationIndex: stop.stationIndex,
      distanceAlongRoute: stop.distanceAlongRoute, distanceToRoute: stop.distanceToRoute
    }));
    const options = { maxWaypoints: recorded.maxWaypoints, stationConstraints,
      ...(recorded.partial ? { startDistance: stops[5].distanceAlongRoute,
        endDistance: stops[20].distanceAlongRoute } : {}) };
    const normal = selectWaypoints(geometry, options);
    const debug = selectWaypoints(geometry, { ...options, debug: true });
    assert.deepEqual(normal.waypoints, recorded.waypoints);
    assert.deepEqual(debug.waypoints, recorded.waypoints);
    assert.equal(normal.candidates, undefined);
    assert.equal(normal.metrics, undefined);
    assert.ok(debug.candidates.length > 0);
    assert.ok(Number.isFinite(debug.metrics.maxDeviation));
  });
}
