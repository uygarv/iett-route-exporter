import assert from "node:assert/strict";
import test from "node:test";
import { execFile } from "node:child_process";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { createServices } from "../src/create-services.js";

test("service composition preserves injected services and connects journeys to the supplied bus calculator", async () => {
  let received;
  const service = { calculateIettRouteTimes: async (...args) => {
    received = args;
    return { total: { estimatedDurationSeconds: 120 } };
  } };
  const services = createServices({ service });
  const result = await services.journeyService.calculateJourney({
    departureTime: "2026-10-24T08:00:00+03:00",
    route: { "1": { type: "BUS", route: "TEST_G_D0", startStation: "START", endStation: "END" } }
  });
  assert.equal(services.service, service);
  assert.equal(result.durationSeconds, 120);
  assert.deepEqual(received, ["TEST_G_D0", {
    startStation: "START", endStation: "END", departureTime: "2026-10-24T08:00:00.000+03:00"
  }]);
  const journeyService = {};
  assert.equal(createServices({ service, journeyService }).journeyService, journeyService);
});

test("importing the HTTP app does not load the host environment file", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "route-export-import-test-"));
  try {
    await writeFile(path.join(directory, ".env"), "ROUTE_EXPORT_IMPORT_SENTINEL=loaded\n");
    const env = { ...process.env };
    delete env.ROUTE_EXPORT_IMPORT_SENTINEL;
    const script = `import assert from "node:assert/strict";
      await import(${JSON.stringify(new URL("../src/app.js", import.meta.url).href)});
      assert.equal(process.env.ROUTE_EXPORT_IMPORT_SENTINEL, undefined);`;
    await promisify(execFile)(process.execPath, ["--input-type=module", "-e", script], { cwd: directory, env });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("the JavaScript library retains its existing public exports", async () => {
  const api = await import("../src/index.js");
  assert.deepEqual(Object.keys(api).sort(), [
    "IettClient", "TomTomClient", "HereClient", "createIettService", "parseRouteCode",
    "createTomTomScheduler", "createHereScheduler", "DEFAULT_GEOMETRY_POLICY",
    "createJourneyService", "DEFAULT_SCORING_WEIGHTS", "StepType", "DEFAULT_RING_ROUTE",
    "evaluateJourneys", "calculateJourney", "getIettRouteOptions", "prepareIettLine",
    "buildIettGoogleMapsRoute", "buildIettAppleMapsRoute", "buildIettYandexMapsRoute",
    "buildIettGpx", "calculateIettRouteTimes", "clearIettCaches"
  ].sort());
});
