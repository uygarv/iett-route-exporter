import assert from "node:assert/strict";
import test from "node:test";
import { createRoutePreparation } from "../src/routing/route-preparation.js";

test("route preparation retains both provider geometries and invalidates them when source data changes", () => {
  const record = {
    line: "LINESTRING (29 41,29.000001 41,29.01 41)",
    stationPlaces: [{ stationName: "START", lng: 29, lat: 41 }, { stationName: "END", lng: 29.01, lat: 41 }]
  };
  const preparation = createRoutePreparation();
  const tomtom = preparation.prepareRoute(record, "tomtom");
  const here = preparation.prepareRoute(record, "here");
  assert.equal(tomtom.geometry.points.length, 2);
  assert.equal(here.geometry.points.length, 3);
  assert.equal(preparation.prepareRoute(record, "tomtom"), tomtom);
  assert.equal(preparation.prepareRoute(record, "here"), here);
  const options = { startStation: null, endStation: null, currentLocation: null };
  const section = preparation.prepareSection(tomtom, { ...options, dwellTimeSeconds: 0 });
  assert.equal(preparation.prepareSection(tomtom, { ...options, dwellTimeSeconds: 15 }), section);
  record.stationPlaces[1].stationName = "UPDATED END";
  assert.notEqual(preparation.prepareRoute(record, "tomtom"), tomtom);
  assert.notEqual(preparation.prepareRoute(record, "here"), here);
  const updated = preparation.prepareRoute(record, "tomtom");
  assert.equal(updated.matchedStops.at(-1).name, "UPDATED END");
  preparation.clear();
  assert.notEqual(preparation.prepareRoute(record, "tomtom"), updated);
});
