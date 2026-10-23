import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { AppError } from "../src/shared/errors.js";
import { createIettService } from "../src/services/iett-service.js";

const fixture = JSON.parse(await readFile(new URL("./fixtures/here-import-routing.json", import.meta.url), "utf8"));
for (const recorded of fixture.cases) {
  test(`recorded HERE ${recorded.name}: preserves the complete IETT route`, async () => {
    const pending = structuredClone(recorded.records);
    let calls = 0;
    const hereClient = Object.fromEntries(["importRoute", "getRouteByHandle", "calculateRoute"].map(method => [method, async () => {
      const exchange = pending.shift(); calls++;
      assert.equal(exchange?.method, method, "native HERE requests must follow the recorded bounded flow");
      if (exchange.error) throw new AppError(exchange.error.status, exchange.error.code, exchange.error.message);
      return exchange.response;
    }]));
    const service = createIettService({ client: { getRoutePin: async () => recorded.routeData }, hereClient });
    const r = await service.calculateIettRouteTimes(recorded.routeCode, recorded.options);
    assert.equal(r.provider, "here");
    assert.equal(r.geometrySource, "iett");
    assert.equal(r.geometryMatch.valid, true);
    assert.equal(r.timingCoverage.fullyProviderCovered, false);
    assert.ok(r.timingCoverage.providerCoverageRatio > 0.95);
    assert.equal(r.total.drivingDurationSeconds, r.total.providerDrivingDurationSeconds + r.total.estimatedUnmappedDurationSeconds);
    assert.equal(r.total.drivingDurationSeconds, r.segments.reduce((n, s) => n + s.drivingDurationSeconds, 0));
    assert.equal(r.total.estimatedDurationSeconds, r.total.drivingDurationSeconds + r.total.dwellDurationSeconds);
    if (recorded.name === "19-short") {
      assert.equal(r.provider, "here");
      assert.equal(r.geometryMatch.valid, true);
      assert.equal(r.geometryMatch.providerGeometryValid, false);
      assert.equal(r.total.providerDrivingDurationSeconds, 456);
      assert.equal(r.total.estimatedUnmappedDurationSeconds, 16);
      assert.equal(r.total.estimatedDurationSeconds, 592);
      assert.equal(r.total.drivingDurationSeconds, r.segments.reduce((n, s) => n + s.drivingDurationSeconds, 0));
      assert.equal(r.debug.upstreamRequestCount, 3);
      assert.ok(r.warnings.some(w => w.code === "UNMAPPED_IETT_SECTION_ESTIMATED"));
      const warm = await service.calculateIettRouteTimes(recorded.routeCode, {
        ...recorded.options, departureTime: "2026-10-21T08:16:00+03:00"
      });
      assert.equal(warm.debug.operations[0].type, "route-handle");
      assert.equal(warm.total.providerDrivingDurationSeconds, 464);
      assert.equal(warm.total.estimatedUnmappedDurationSeconds, 16);
    } else assert.ok(r.total.estimatedUnmappedDurationSeconds > 0, "formerly rejected native imports must return explicit estimates");
    assert.equal(pending.length, 0);
    assert.ok(calls <= (recorded.name === "19-short" ? 6 : 3));
  });
}
