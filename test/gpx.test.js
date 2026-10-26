import assert from "node:assert/strict";
import test from "node:test";
import { createIettService } from "../src/services/iett-service.js";

const line = "LINESTRING (29 41, 29.005 41, 29.01 41, 29.01 41.005, 29.02 41.01)";
const stationPlaces = [
  { stationName: "START & DEPOT", lat: 41, lng: 29 },
  { stationName: "SAME <STOP>", lat: 41, lng: 29.005 },
  { stationName: "MIDDLE", lat: 41, lng: 29.01 },
  { stationName: "SAME <STOP>", lat: 41.005, lng: 29.01 },
  { stationName: "END", lat: 41.01, lng: 29.02 }
];

function createService() {
  return createIettService({
    client: {
      async getRoutePin() {
        return [{ line, stationPlaces }];
      }
    }
  });
}

test("exports IETT geometry and stations as GPX", async () => {
  const result = await createService().buildIettGpx("TEST_G_D0");

  assert.equal(result.filename, "TEST_G_D0.gpx");
  assert.equal(result.contentType, "application/gpx+xml; charset=utf-8");
  assert.match(result.gpx, /^<\?xml version="1\.0" encoding="UTF-8"\?>/);
  assert.match(result.gpx, /<name>START &amp; DEPOT<\/name>/);
  assert.match(result.gpx, /<name>SAME &lt;STOP&gt; \(1\)<\/name>/);
  assert.match(result.gpx, /<name>SAME &lt;STOP&gt; \(2\)<\/name>/);
  assert.match(result.gpx, /<trkpt lat="41" lon="29" \/>/);
  assert.match(result.gpx, /<trkpt lat="41\.01" lon="29\.02" \/>/);
  assert.equal((result.gpx.match(/<wpt /g) ?? []).length, 5);
  assert.equal((result.gpx.match(/<trkpt /g) ?? []).length, 5);
});

test("trims GPX with numbered duplicate station labels", async () => {
  const service = createService();
  const result = await service.buildIettGpx("TEST_G_D0", {
    startStation: "same stop (2)",
    endStation: "END"
  });

  assert.doesNotMatch(result.gpx, /SAME &lt;STOP&gt; \(1\)/);
  assert.match(result.gpx, /SAME &lt;STOP&gt; \(2\)/);
  assert.equal((result.gpx.match(/<wpt /g) ?? []).length, 2);
  assert.match(result.gpx, /<trkpt lat="41\.005" lon="29\.01" \/>/);

  await assert.rejects(
    service.buildIettGpx("TEST_G_D0", {
      startStation: "SAME <STOP>"
    }),
    error => {
      return error.code === "AMBIGUOUS_START_STATION"
        && error.details.candidates[1].name === "SAME <STOP> (2)";
    }
  );
});

test("GPX and map exports select the same occurrence of a stop after a loop", async () => {
  const record = {
    line: "LINESTRING (29 41,29.01 41,29.01 41.01,29 41.01,29 41,28.99 41)",
    stationPlaces: [
      { stationName: "START", lat: 41, lng: 29 },
      { stationName: "MIDDLE", lat: 41.01, lng: 29.01 },
      { stationName: "RETURN", lat: 41, lng: 29 },
      { stationName: "END", lat: 41, lng: 28.99 }
    ]
  };
  const service = createIettService({ client: { getRoutePin: async () => [record] } });
  const options = { startStation: "RETURN", endStation: "END" };
  const gpx = await service.buildIettGpx("LOOP_G_D0", options);
  const maps = await service.buildIettGoogleMapsRoute("LOOP_G_D0", { ...options, maxWaypoints: 0 });
  assert.ok(maps.startDistanceAlongRoute > 3_000);
  assert.ok(maps.remainingRouteLengthMeters < 1_000);
  assert.equal((gpx.gpx.match(/<trkpt /g) ?? []).length, 2);
  assert.equal((gpx.gpx.match(/<wpt /g) ?? []).length, 2);
  assert.doesNotMatch(gpx.gpx, /lat="41\.01"/);
});

test("GPX keeps full geometry without stops and ignores invalid unrelated stops when trimming", async () => {
  const record = { line, stationPlaces: [] };
  const service = createIettService({ client: { getRoutePin: async () => [record] } });
  const full = await service.buildIettGpx("TEST_G_D0");
  assert.equal((full.gpx.match(/<trkpt /g) ?? []).length, 5);
  record.stationPlaces = [stationPlaces[0], { stationName: "BROKEN", lat: "bad", lng: 29 }, stationPlaces.at(-1)];
  const trimmed = await service.buildIettGpx("TEST_G_D0", { endStation: "END" });
  assert.match(trimmed.gpx, /<trkpt lat="41\.01" lon="29\.02" \/>/);
  assert.doesNotMatch(trimmed.gpx, /<name>BROKEN<\/name>/);
});
