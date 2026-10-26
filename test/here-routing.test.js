import test from "node:test";
import assert from "node:assert/strict";
import { createIettService } from "../src/services/iett-service.js";
import { createHereTrace, readHereRoute, splitHereTrace, pathGeometry } from "../src/routing/here-route.js";
import { decodeFlexiblePolyline } from "../src/routing/flexible-polyline.js";
import { buildRouteGeometry, haversineDistance } from "../src/routing/geometry.js";
import { AppError } from "../src/shared/errors.js";
import { HERE_HTTP_ATTEMPTS } from "../src/clients/here-client.js";
import { MockHereClient, routeData, withPath, section } from "./fixtures/here.js";

const options = { provider: "here", departureTime: "2026-10-21T08:06:00+03:00", debug: true };
function setup(client = new MockHereClient(), data = routeData(), extra = {}) {
  let iettCalls = 0, tomTomCalls = 0;
  const service = createIettService({ client: { async getRoutePin() { iettCalls++; return data; } }, hereClient: client,
    tomTomClient: { async calculateRoute() { tomTomCalls++; throw new Error("TomTom selected"); } }, ...extra });
  return { service, client, counts: () => ({ iettCalls, tomTomCalls }) };
}
const sum = (array, field) => array.reduce((n, s) => n + (s[field] ?? 0), 0);

test("provider selection defaults to TomTom and invalid values make no upstream calls", async () => {
  const { service, client, counts } = setup();
  for (const provider of ["", null, "HERE", "google", 0, {}, []]) {
    await assert.rejects(service.calculateIettRouteTimes("19_D_D0", { provider }), e => e.status === 400 && e.code === "INVALID_PROVIDER");
  }
  assert.deepEqual(counts(), { iettCalls: 0, tomTomCalls: 0 });
  for (const request of [{}, { provider: "tomtom" }]) {
    await assert.rejects(service.calculateIettRouteTimes("19_D_D0", request), /TomTom selected/);
  }
  assert.equal(client.calls.length, 0);
  assert.equal(counts().tomTomCalls, 2);
});

test("HERE imports the selected trace and preserves total driving, wait and segment durations", async () => {
  const { service, client, counts } = setup();
  const result = await service.calculateIettRouteTimes("19_D_D0", options);
  assert.equal(result.provider, "here");
  assert.equal(result.total.providerDrivingDurationSeconds, 750);
  assert.equal(result.total.drivingDurationSeconds, 750);
  assert.equal(result.total.dwellDurationSeconds, 30);
  assert.equal(result.total.estimatedDurationSeconds, 780);
  assert.equal(result.total.liveTrafficDelaySeconds, undefined);
  assert.equal(result.total.drivingDurationSeconds, sum(result.segments, "drivingDurationSeconds"));
  assert.equal(Date.parse(result.total.arrivalTime) - Date.parse(result.total.departureTime), 780000);
  assert.equal(result.total.trafficDelaySeconds, sum(result.segments, "trafficDelaySeconds"));
  assert.equal(result.geometryMatch.valid, true);
  assert.equal(result.routingQuality, "here-geometry-validated");
  assert.equal(counts().tomTomCalls, 0);
  const request = client.calls[0].request;
  assert.equal(request.departureTime, "2026-10-21T05:06:00.000Z");
  assert.equal(request.via.length, 2);
  assert.ok(request.via.every(v => v.stopDuration === 15));
  assert.ok(request.trace.slice(1).every((p, i) => haversineDistance(request.trace[i], p) < 5.1));
  assert.equal(result.debug.upstreamRequestCount, 1);
});

test("HERE supports selected stops, current locations, offsetless dates, now and custom dwell", async () => {
  const { service } = setup(undefined, routeData(), { clock: () => Date.parse("2026-10-20T19:00:00Z") });
  const partial = await service.calculateIettRouteTimes("19_D_D0", { ...options, startStation: "STOP 1", endStation: "STOP 3",
    departureTime: "2026-10-21T08:06:00", dwellTimeSeconds: 20 });
  assert.equal(partial.segments.length, 2);
  assert.equal(partial.total.dwellDurationSeconds, 20);
  assert.equal(partial.total.departureTime, "2026-10-21T05:06:00.000Z");
  const current = await service.calculateIettRouteTimes("19_D_D0", { ...options, departureTime: "now",
    currentLocation: { lat: 41, lng: 29.015 }, endStation: "STOP 2", dwellTimeSeconds: 0 });
  assert.equal(current.origin.type, "current-location");
  assert.equal(current.segments.length, 2);
  assert.equal(current.total.departureTime, "2026-10-20T19:00:00.000Z");
  assert.equal(current.total.dwellDurationSeconds, 0);
  assert.equal(current.trafficTimeContext, "immediate");
});

test("HERE estimates a short missing prefix without hiding its duration or geometry", async () => {
  const client = new MockHereClient({ modify(data) {
    const s = data.routes[0].sections[0];
    data.routes[0].sections[0] = withPath(s, decodeFlexiblePolyline(s.polyline).coordinates.slice(17));
    data.notices = [{ code: "importSplitRoute", severity: "info" }]; return data;
  } });
  const { service } = setup(client);
  const r = await service.calculateIettRouteTimes("19_D_D0", options);
  assert.equal(r.routingQuality, "validated-with-iett-section-estimate");
  assert.ok(r.total.estimatedUnmappedDurationSeconds >= 34);
  assert.equal(r.total.providerDrivingDurationSeconds, 750);
  assert.equal(r.total.drivingDurationSeconds, 750 + r.total.estimatedUnmappedDurationSeconds);
  assert.equal(r.geometryMatch.providerGeometryValid, false);
  assert.equal(r.geometryMatch.quality, "estimated");
  assert.equal(r.debug.estimatedSections.length, 1);
  assert.ok(r.warnings.some(w => w.code === "UNMAPPED_IETT_SECTION_ESTIMATED"));
  assert.equal(client.calls.filter(c => c.method === "repair").length, 1);
});

test("HERE prefers a validated local repair to estimating the missing piece", async () => {
  const client = new MockHereClient({ modify(data) {
    const s = data.routes[0].sections[0];
    data.routes[0].sections[0] = withPath(s, decodeFlexiblePolyline(s.polyline).coordinates.slice(10)); return data;
  }, repair(request) { return { routes: [{ sections: [section([[request.origin.lng, request.origin.lat],
    [request.destination.lng, request.destination.lat]], request.departureTime, 12)] }] }; } });
  const { service } = setup(client);
  const r = await service.calculateIettRouteTimes("19_D_D0", options);
  assert.equal(r.total.estimatedUnmappedDurationSeconds, undefined);
  assert.equal(r.total.providerDrivingDurationSeconds, 762);
  assert.equal(r.debug.reconstructionRepairs[0].accepted, true);
});

test("a local repair snapped to a zero-length route remains an explicit estimate", async () => {
  const client = new MockHereClient({ modify(data) {
    const s = data.routes[0].sections[0];
    data.routes[0].sections[0] = withPath(s, decodeFlexiblePolyline(s.polyline).coordinates.slice(10)); return data;
  }, repair(request) { const p = [request.destination.lng, request.destination.lat];
    return { routes: [{ sections: [section([p, p], request.departureTime, 0)] }] };
  } });
  const r = await setup(client).service.calculateIettRouteTimes("19_D_D0", options);
  assert.ok(r.total.estimatedUnmappedDurationSeconds > 0);
  assert.equal(r.debug.reconstructionRepairs[0].errorCode, "HERE_NO_ROUTE");
});

test("HERE counts disconnected seams explicitly and does not require one section per stop", async () => {
  const client = new MockHereClient({ modify(data) {
    const s = data.routes[0].sections[0], p = decodeFlexiblePolyline(s.polyline).coordinates;
    const split = Math.floor(p.length / 2);
    data.routes[0].sections.splice(0, 1,
      section(p.slice(0, split + 1), s.departure.time, 100),
      section(p.slice(split + 11), new Date(Date.parse(s.departure.time) + 100000).toISOString(), 100, 15));
    return data;
  } });
  const r = await setup(client).service.calculateIettRouteTimes("19_D_D0", options);
  assert.equal(r.segments.length, 3);
  assert.equal(r.debug.providerSectionCount, 4);
  assert.ok(r.total.estimatedUnmappedDurationSeconds > 0);
  assert.equal(r.total.providerDrivingDurationSeconds, 750);
});

test("HERE preserves a route with long gaps and discards large provider detours", async () => {
  for (const modify of [data => {
    const s = data.routes[0].sections[0]; data.routes[0].sections[0] = withPath(s, decodeFlexiblePolyline(s.polyline).coordinates.slice(24));
  }, data => {
    const s = data.routes[0].sections[0], p = decodeFlexiblePolyline(s.polyline).coordinates;
    data.routes[0].sections[0] = withPath(s, [p[0], [29.06, 41.03], p.at(-1)]);
  }]) {
    const client = new MockHereClient({ modify(data) { modify(data); return data; } });
    const result = await setup(client).service.calculateIettRouteTimes("19_D_D0", options);
    assert.ok(result.total.estimatedUnmappedDurationSeconds > 0);
    assert.ok(result.timingCoverage.providerCoverageRatio < 1);
    assert.equal(result.geometrySource, "iett");
    assert.deepEqual(result.geometry.coordinates, [[29, 41], [29.03, 41], [29.06, 41], [29.09, 41]]);
    assert.equal(result.total.drivingDurationSeconds, sum(result.segments, "drivingDurationSeconds"));
    assert.ok(client.calls.length <= 3);
  }
});

test("HERE uses and refreshes handles, separates dwell and source fingerprints and clears caches", async () => {
  const data = routeData(), { service, client } = setup(undefined, data);
  await service.calculateIettRouteTimes("19_D_D0", options);
  await service.calculateIettRouteTimes("19_D_D0", { ...options, departureTime: "2026-10-21T08:16:00+03:00" });
  assert.deepEqual(client.calls.map(c => c.method), ["import", "handle"]);
  client.invalidHandle = true;
  await service.calculateIettRouteTimes("19_D_D0", { ...options, departureTime: "2026-10-21T08:26:00+03:00" });
  assert.deepEqual(client.calls.slice(-2).map(c => c.method), ["handle", "import"]);
  await service.calculateIettRouteTimes("19_D_D0", { ...options, dwellTimeSeconds: 0 });
  assert.equal(client.calls.at(-1).method, "import");
  data[0].stationPlaces[1].stationName = "RENAMED";
  await service.calculateIettRouteTimes("19_D_D0", { ...options, departureTime: "2026-10-21T08:36:00+03:00" });
  assert.equal(client.calls.at(-1).method, "import");
  service.clearCaches();
  await service.calculateIettRouteTimes("19_D_D0", options);
  assert.equal(client.calls.at(-1).method, "import");
});

test("HERE shares concurrent shape preparation while each departure gets its own forecast", async () => {
  const { service, client } = setup();
  const [a, b] = await Promise.all([service.calculateIettRouteTimes("19_D_D0", options),
    service.calculateIettRouteTimes("19_D_D0", { ...options, departureTime: "2026-10-21T08:16:00+03:00" })]);
  assert.equal(client.calls.filter(c => c.method === "import").length, 1);
  assert.equal(client.calls.filter(c => c.method === "handle").length, 1);
  assert.notEqual(a.total.departureTime, b.total.departureTime);
  const count = client.calls.length;
  await service.calculateIettRouteTimes("19_D_D0", options);
  assert.equal(client.calls.length, count);
});

test("HERE quota failures do not trigger repair or a TomTom fallback and are not cached", async () => {
  const client = new MockHereClient();
  client.importRoute = async () => { client.calls.push({ method: "import" }); throw new AppError(429, "HERE_RATE_LIMITED", "Rate limited"); };
  const { service, counts } = setup(client);
  for (let i = 0; i < 2; i++) await assert.rejects(service.calculateIettRouteTimes("19_D_D0", options), e => e.code === "HERE_RATE_LIMITED");
  assert.equal(client.calls.length, 2);
  assert.equal(counts().tomTomCalls, 0);
});

test("HERE bounds optional repairs and reports actual HTTP attempts", async () => {
  const client = new MockHereClient({ modify(data) {
    const s = data.routes[0].sections[0];
    data.routes[0].sections[0] = withPath(s, decodeFlexiblePolyline(s.polyline).coordinates.slice(10));
    const last = data.routes[0].sections.at(-1);
    data.routes[0].sections[data.routes[0].sections.length - 1] = withPath(last, decodeFlexiblePolyline(last.polyline).coordinates.slice(0, -10));
    Object.defineProperty(data, HERE_HTTP_ATTEMPTS, { value: 2 }); return data;
  }, repair() { const error = new AppError(502, "HERE_NO_ROUTE", "No local route");
    Object.defineProperty(error, HERE_HTTP_ATTEMPTS, { value: 2 }); throw error;
  } });
  const { service } = setup(client);
  const r = await service.calculateIettRouteTimes("19_D_D0", options);
  assert.equal(r.debug.geometryAttemptCount, 3);
  assert.equal(r.debug.upstreamRequestCount, 6);
  assert.equal(client.calls.length, 3);
  assert.ok(r.debug.upstreamRequestCount <= r.debug.maximumUpstreamRequestCount);
  client.invalidHandle = true;
  const stale = await service.calculateIettRouteTimes("19_D_D0", { ...options, departureTime: "2026-10-21T08:16:00+03:00" });
  assert.equal(stale.debug.geometryAttemptCount, 4);
  assert.equal(stale.debug.upstreamRequestCount, 7);
  assert.ok(stale.debug.upstreamRequestCount <= stale.debug.maximumUpstreamRequestCount);
});

test("HERE rejects malformed summaries, polylines and critical notices", () => {
  const valid = { routes: [{ sections: [section([[29, 41], [29.01, 41]], options.departureTime, 100)] }] };
  for (const mutate of [d => d.routes[0].sections[0].travelSummary.duration = -1,
    d => d.routes[0].sections[0].polyline = "garbage",
    d => d.routes[0].sections[0].spans[0].offset = 1000,
    d => d.notices = [{ severity: "critical", code: "importFailed" }]]) {
    const d = structuredClone(valid); mutate(d); assert.throws(() => readHereRoute(d));
  }
});

test("HERE accepts missing coverage regardless of total length or proportion", async () => {
  // Three individually short 75m gaps previously rejected the entire line.
  const client = new MockHereClient({ modify(data) {
    data.routes[0].sections.slice(0, 3).forEach((s, i) => {
      data.routes[0].sections[i] = withPath(s, decodeFlexiblePolyline(s.polyline).coordinates.slice(15));
    }); return data;
  } });
  const large = await setup(client, routeData(6)).service.calculateIettRouteTimes("19_D_D0", options);
  assert.ok(large.timingCoverage.estimatedDistanceMeters > 200);
  assert.equal(large.debug.estimatedSections.length, 3);
  assert.equal(client.calls.length, 3);
  // A short gap on a short route still exceeds two percent of the route.
  const small = new MockHereClient({ modify(data) {
    const s = data.routes[0].sections[0]; data.routes[0].sections[0] = withPath(s, decodeFlexiblePolyline(s.polyline).coordinates.slice(5)); return data;
  } });
  const short = await setup(small, routeData(3, 0.001)).service.calculateIettRouteTimes("19_D_D0", options);
  assert.ok(short.timingCoverage.providerCoverageRatio < 0.98);
  assert.equal(short.geometryMatch.valid, true);
});

test("HERE handles approximation, reversed paths and omitted out-and-back geometry", async () => {
  const approximate = new MockHereClient({ modify(data) {
    const s = data.routes[0].sections[0];
    const coords = decodeFlexiblePolyline(s.polyline).coordinates, middle = Math.floor(coords.length / 2);
    const shifted = coords.map(([lng, lat], i) => [lng, lat + Math.max(0, 1 - Math.abs(i - middle) / 25) * 0.0008]);
    Object.assign(s, withPath(s, shifted)); return data;
  } });
  const accepted = await setup(approximate).service.calculateIettRouteTimes("19_D_D0", options);
  assert.equal(accepted.geometryMatch.quality, "approximate");
  for (const modify of [data => {
    const s = data.routes[0].sections[0]; data.routes[0].sections[0] = withPath(s, decodeFlexiblePolyline(s.polyline).coordinates.reverse());
  }, data => data.routes[0].sections.reverse()]) {
    const client = new MockHereClient({ modify(data) { modify(data); return data; } });
    const r = await setup(client).service.calculateIettRouteTimes("19_D_D0", options);
    assert.ok(r.total.providerDrivingDurationSeconds < 750, "reversed or misordered provider timing must be discarded");
    assert.ok(r.total.estimatedUnmappedDurationSeconds > 0);
    assert.ok(r.warnings.some(w => w.code === "HERE_GEOMETRY_SECTIONS_DISCARDED"));
  }
  const loop = [{ line: "LINESTRING (29 41,29.01 41,29.01 41.01,29.01 41,29.03 41)",
    stationPlaces: [{ stationName: "START", lat: 41, lng: 29 }, { stationName: "END", lat: 41, lng: 29.03 }] }];
  const shortcut = new MockHereClient({ modify(data) {
    const s = data.routes[0].sections[0], p = decodeFlexiblePolyline(s.polyline).coordinates;
    data.routes[0].sections[0] = withPath(s, [p[0], p.at(-1)]); return data;
  } });
  const r = await setup(shortcut, loop).service.calculateIettRouteTimes("19_D_D0", options);
  assert.equal(r.routingQuality, "iett-geometry-estimated-timing");
  assert.equal(r.total.providerDrivingDurationSeconds, 0);
  assert.deepEqual(r.geometry.coordinates, [[29, 41], [29.01, 41], [29.01, 41.01], [29.01, 41], [29.03, 41]]);
  assert.equal(r.total.distanceMeters, Math.round(buildRouteGeometry(loop[0].line).totalLength * 10) / 10);
});

test("HERE honours result and shape TTLs and the bounded handle cache", async () => {
  let now = Date.parse("2026-10-20T06:00:00Z");
  const { service, client } = setup(undefined, routeData(), {
    clock: () => now, timingCacheTtlMs: 100, shapeCacheTtlMs: 1000, shapeCacheMaxEntries: 1
  });
  await service.calculateIettRouteTimes("19_D_D0", options);
  now += 101;
  await service.calculateIettRouteTimes("19_D_D0", options);
  assert.equal(client.calls.at(-1).method, "handle");
  now += 1000;
  await service.calculateIettRouteTimes("19_D_D0", options);
  assert.equal(client.calls.at(-1).method, "import");
  await service.calculateIettRouteTimes("19_D_D0", { ...options, dwellTimeSeconds: 20 });
  now += 101;
  await service.calculateIettRouteTimes("19_D_D0", options);
  assert.equal(client.calls.at(-1).method, "import");
});

test("HERE shares traffic calculations across debug presentations, including pending requests and expiry", async () => {
  for (const firstDebug of [false, true]) {
    let now = Date.parse("2026-10-20T06:00:00Z");
    const { service, client } = setup(undefined, routeData(), { clock: () => now, timingCacheTtlMs: 100 });
    const first = await service.calculateIettRouteTimes("19_D_D0", { ...options, debug: firstDebug });
    const second = await service.calculateIettRouteTimes("19_D_D0", { ...options, debug: !firstDebug });
    assert.equal(client.calls.length, 1);
    assert.deepEqual(first.total, second.total);
    assert.equal((firstDebug ? second : first).debug, undefined);
    assert.equal((firstDebug ? first : second).debug.upstreamRequestCount, 1);
    now += 101;
    await service.calculateIettRouteTimes("19_D_D0", { ...options, debug: !firstDebug });
    assert.equal(client.calls.length, 2);
  }
  const { service, client } = setup();
  const [normal, debug] = await Promise.all([
    service.calculateIettRouteTimes("19_D_D0", { ...options, debug: false }),
    service.calculateIettRouteTimes("19_D_D0", { ...options, debug: true })
  ]);
  assert.equal(client.calls.length, 1);
  assert.equal(normal.debug, undefined);
  assert.ok(debug.debug.providerGeometryMatches.length > 0);
});

test("HERE preserves every original vertex and stop index when densifying the trace", () => {
  const geometry = buildRouteGeometry("LINESTRING (29 41,29.00001 41.00001,29.00002 41,29.01 41)");
  const nodes = [{ distanceAlongRoute: 0 }, { distanceAlongRoute: geometry.totalLength / 2 }, { distanceAlongRoute: geometry.totalLength }];
  const reference = createHereTrace(geometry, nodes, 15);
  for (const p of geometry.points) assert.ok(reference.trace.some(t => t.lat === p.lat && t.lng === p.lng));
  assert.equal(reference.via.length, 1);
  assert.ok(reference.via[0].index > 0 && reference.via[0].index < reference.trace.length - 1);
});

test("HERE returns the source line and explicit conservative timing when no road matches at all", async () => {
  const client = new MockHereClient();
  client.importRoute = async () => { throw new AppError(502, "HERE_NO_ROUTE", "No matching car roads"); };
  const r = await setup(client).service.calculateIettRouteTimes("19_D_D0", options);
  assert.equal(r.routingQuality, "iett-geometry-estimated-timing");
  assert.equal(r.trafficDataBasis, "unavailable-estimated");
  assert.equal(r.total.providerDrivingDurationSeconds, 0);
  assert.equal(r.total.drivingDurationSeconds, r.total.estimatedUnmappedDurationSeconds);
  assert.equal(r.timingCoverage.providerCoverageRatio, 0);
  assert.equal(r.timingCoverage.estimatedDistanceMeters, r.total.distanceMeters);
  assert.equal(r.segments.length, 3);
  assert.equal(r.total.dwellDurationSeconds, 30);
  assert.ok(r.warnings.some(w => w.code === "HERE_ROUTE_TIMING_UNAVAILABLE"));
  assert.equal(r.total.drivingDurationSeconds, Math.ceil(pathGeometry(r.geometry).totalLength / 2.5));
  assert.equal(Date.parse(r.total.arrivalTime) - Date.parse(r.total.departureTime), r.total.estimatedDurationSeconds * 1000);
  assert.ok(r.debug.estimatedSections.every(s => s.method === "conservative-urban-speed"));
});

test("HERE salvages valid link spans without assigning a detour's seconds to IETT", async () => {
  const client = new MockHereClient({ modify(data) {
    const s = data.routes[0].sections[0], p = decodeFlexiblePolyline(s.polyline).coordinates;
    const coords = [p[0], p[Math.floor(p.length / 2)], [p[Math.floor(p.length / 2)][0], 41.02], p.at(-1)];
    const bad = withPath(s, coords);
    bad.spans = [0, 1, 2].map((offset, i) => ({ offset, duration: i === 0 ? 100 : 50,
      length: haversineDistance({ lng: coords[i][0], lat: coords[i][1] }, { lng: coords[i + 1][0], lat: coords[i + 1][1] }) }));
    data.routes[0].sections[0] = bad; return data;
  } });
  const r = await setup(client).service.calculateIettRouteTimes("19_D_D0", options);
  assert.equal(r.total.providerDrivingDurationSeconds, 650);
  assert.ok(r.timingCoverage.providerCoverageRatio > 0.8 && r.timingCoverage.providerCoverageRatio < 0.9);
  assert.ok(r.total.estimatedUnmappedDurationSeconds > 0);
  assert.equal(sum(r.segments, "providerDrivingDurationSeconds"), 650);
  assert.equal(r.geometry.coordinates.every(p => p[1] === 41), true);
});

test("HERE source fallback does not hide transport or malformed-response errors", async () => {
  for (const code of ["HERE_TIMEOUT", "HERE_AUTH_FAILED", "HERE_REQUEST_FAILED", "HERE_MALFORMED_RESPONSE"]) {
    const client = new MockHereClient();
    client.importRoute = async () => { client.calls.push({ method: "import" }); throw new AppError(502, code, "Provider error"); };
    await assert.rejects(setup(client).service.calculateIettRouteTimes("19_D_D0", options), e => e.code === code);
    assert.equal(client.calls.length, 1);
  }
});

test("HERE trace splitting honours point and byte limits without dropping vertices or duplicating stops", () => {
  const geometry = buildRouteGeometry("LINESTRING (29 41,29.01 41,29.02 41)");
  const nodes = [0, 100, 200, 300, geometry.totalLength].map(distanceAlongRoute => ({ distanceAlongRoute }));
  const reference = createHereTrace(geometry, nodes, 20);
  for (const limits of [{ maximumPoints: 21 }, { maximumBytes: 1000 }]) {
    const parts = splitHereTrace(reference, limits);
    assert.ok(parts.length > 1);
    const joined = [];
    for (const [i, part] of parts.entries()) {
      assert.ok(part.trace.length <= (limits.maximumPoints ?? 50_000));
      assert.ok(Buffer.byteLength(JSON.stringify({ trace: part.trace, via: part.via })) <= (limits.maximumBytes ?? 10 * 1024 * 1024));
      if (i) assert.deepEqual(parts[i - 1].trace.at(-1), part.trace[0]);
      joined.push(...part.trace.slice(i ? 1 : 0));
      assert.ok(part.via.every(v => v.index > 0 && v.index < part.trace.length - 1 && v.stopDuration === 20));
    }
    assert.deepEqual(joined, reference.trace);
    assert.equal(parts[0].start, 0);
    assert.equal(parts.at(-1).end, geometry.totalLength);
  }
});

test("HERE imports lines exceeding 50,000 trace points in chunks and refreshes every chunk handle", async () => {
  const points = Array.from({ length: 50_100 }, (_, i) => [29 + i * 0.000001, 41]);
  const data = [{ line: `LINESTRING (${points.map(p => p.join(" ")).join(",")})`,
    stationPlaces: [0, points.length - 1].map((index, i) => ({ stationName: `STOP ${i}`, lng: points[index][0], lat: 41 })) }];
  const original = buildRouteGeometry(data[0].line, { minimumPointSpacingMeters: 0 });
  const trace = createHereTrace(original, [0, original.totalLength].map(distanceAlongRoute => ({ distanceAlongRoute })), 20);
  const boundary = splitHereTrace(trace)[0].trace.at(-1);
  data[0].stationPlaces.splice(1, 0, { ...boundary, stationName: "BOUNDARY STOP" });
  const { service, client } = setup(undefined, data);
  const request = { ...options, dwellTimeSeconds: 20 };
  const cold = await service.calculateIettRouteTimes("19_D_D0", request);
  assert.equal(cold.debug.importChunkCount, 2);
  assert.ok(client.calls.filter(c => c.method === "import").every(c => c.request.trace.length <= 50_000));
  assert.equal(cold.geometry.coordinates.length, points.length);
  assert.equal(cold.total.providerDrivingDurationSeconds, 400);
  assert.equal(cold.total.dwellDurationSeconds, 20);
  const imports = client.calls.filter(c => c.method === "import");
  assert.equal(Date.parse(imports[1].request.departureTime) - Date.parse(imports[0].request.departureTime), 220000);
  const warm = await service.calculateIettRouteTimes("19_D_D0", { ...request, departureTime: "2026-10-21T08:16:00+03:00" });
  assert.equal(client.calls.filter(c => c.method === "handle").length, 2);
  assert.equal(warm.total.providerDrivingDurationSeconds, cold.total.providerDrivingDurationSeconds);
  assert.deepEqual(warm.geometry, cold.geometry);
});

test("HERE preserves numbered repeated stops even when all timing needs estimation", async () => {
  const data = routeData(6);
  data[0].stationPlaces[1].stationName = "SAME STOP";
  data[0].stationPlaces[3].stationName = "SAME STOP";
  const client = new MockHereClient();
  client.importRoute = async () => { throw new AppError(502, "HERE_NO_ROUTE", "No map match"); };
  const r = await setup(client, data).service.calculateIettRouteTimes("19_D_D0", {
    ...options, startStation: "same stop (2)", dwellTimeSeconds: 40
  });
  assert.equal(r.origin.stationIndex, 3);
  assert.equal(r.origin.name, "SAME STOP (2)");
  assert.equal(r.segments.length, 2);
  assert.equal(r.total.dwellDurationSeconds, 40);
  assert.equal(r.total.providerDrivingDurationSeconds, 0);
  assert.equal(r.total.drivingDurationSeconds, sum(r.segments, "estimatedUnmappedDurationSeconds"));
});

test("a critical restriction on one HERE section preserves timing for the other source intervals", async () => {
  const client = new MockHereClient({ modify(data) {
    data.routes[0].sections[0].notices = [{ code: "violatedVehicleRestriction", severity: "critical" }];
    return data;
  } });
  const r = await setup(client).service.calculateIettRouteTimes("19_D_D0", options);
  assert.equal(r.total.providerDrivingDurationSeconds, 550);
  assert.ok(r.total.estimatedUnmappedDurationSeconds > 0);
  assert.ok(r.timingCoverage.providerCoverageRatio > 0.66 && r.timingCoverage.providerCoverageRatio < 0.67);
  assert.equal(r.geometry.coordinates.length, 4);
  assert.ok(r.warnings.find(w => w.code === "HERE_PROVIDER_NOTICES").notices.some(n => n.code === "violatedVehicleRestriction"));
});
