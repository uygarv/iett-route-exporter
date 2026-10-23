import assert from "node:assert/strict";
import test from "node:test";
import { createTomTomScheduler, retryAfterMilliseconds } from "../src/clients/tomtom-scheduler.js";
import { TomTomClient } from "../src/clients/tomtom-client.js";
import { AppError } from "../src/shared/errors.js";
import { createIettService } from "../src/services/iett-service.js";

function virtualClock(initial = 0) {
  let now = initial, id = 0;
  const timers = new Map();
  const flush = async () => { for (let i = 0; i < 40; i += 1) await Promise.resolve(); };
  const clock = {
    clock: () => now,
    setTimer(callback, delay) { const next = ++id; timers.set(next, { at: now + delay, callback }); return next; },
    clearTimer: next => timers.delete(next),
    random: () => 0,
    async tick(milliseconds) {
      await flush();
      const end = now + milliseconds;
      for (let guard = 0; guard < 1_000; guard += 1) {
        const next = [...timers].sort((a, b) => a[1].at - b[1].at)[0];
        if (!next || next[1].at > end) break;
        now = next[1].at; timers.delete(next[0]); next[1].callback(); await flush();
      }
      now = end; await flush();
    },
    async finish() {
      await flush();
      for (let guard = 0; timers.size && guard < 1_000; guard += 1) {
        const at = Math.min(...[...timers.values()].map(t => t.at));
        await clock.tick(at - now);
      }
      assert.equal(timers.size, 0);
    },
    flush
  };
  return clock;
}

test("all queued HTTP attempts share four QPS and at most four in-flight requests", async () => {
  const time = virtualClock();
  const scheduler = createTomTomScheduler(time);
  const starts = [];
  let active = 0, maximum = 0;
  const work = Array.from({ length: 12 }, (_, i) => scheduler.execute(String(i), async () => {
    starts.push(time.clock()); maximum = Math.max(maximum, ++active);
    await new Promise(resolve => time.setTimer(resolve, 1_200));
    active -= 1;
    return i;
  }));
  await time.finish();
  assert.deepEqual(await Promise.all(work), Array.from({ length: 12 }, (_, i) => i));
  assert.equal(maximum, 4);
  assert.ok(starts.every((at, i) => !i || at - starts[i - 1] >= 250));
  for (const at of starts) assert.ok(starts.filter(t => t >= at && t < at + 1_000).length <= 4);
});

test("identical pending payloads are shared across separate BUS and RING clients", async () => {
  const time = virtualClock(), scheduler = createTomTomScheduler(time);
  const calls = [];
  const fetchImpl = async (_url, options) => {
    calls.push(JSON.parse(options.body));
    return new Response(JSON.stringify({ routes: [], tag: calls.length }));
  };
  const bus = new TomTomClient({ apiKey: "same", scheduler, fetchImpl });
  const ring = new TomTomClient({ apiKey: "same", scheduler, fetchImpl });
  const a = bus.calculateRoute({ traffic: "live", departureDateTime: "tomorrow" });
  const b = ring.calculateRoute({ departureDateTime: "tomorrow", traffic: "live" });
  const c = ring.calculateRoute({ traffic: "live", departureDateTime: "later" });
  await time.finish();
  assert.deepEqual(await a, await b);
  await c;
  assert.equal(calls.length, 2);
});

test("default clients share their scheduler across instances without dependency injection", async () => {
  const starts = [];
  const fetchImpl = async () => { starts.push(Date.now()); return new Response('{"routes":[]}'); };
  const key = "process-sharing-test";
  const clients = [new TomTomClient({ apiKey: key, fetchImpl }), new TomTomClient({ apiKey: key, fetchImpl })];
  await Promise.all([clients[0].calculateRoute({ departureDateTime: "a" }), clients[1].calculateRoute({ departureDateTime: "b" })]);
  assert.equal(starts.length, 2);
  assert.ok(starts[1] - starts[0] >= 240);
});

test("429 pauses unrelated queued work, retries once, and recovers after 60 successful seconds", async () => {
  const time = virtualClock(), scheduler = createTomTomScheduler(time);
  const starts = [];
  let attempts = 0;
  const a = scheduler.execute("a", async () => {
    starts.push(time.clock());
    if (++attempts === 1) throw new AppError(429, "TOMTOM_RATE_LIMITED", "limited", { retryAfter: "2" });
    return "a";
  });
  const b = scheduler.execute("b", async () => { starts.push(time.clock()); return "b"; });
  await time.finish();
  assert.equal(await a, "a"); assert.equal(await b, "b");
  assert.equal(attempts, 2);
  assert.ok(starts.slice(1).every(at => at >= 2_000));
  assert.ok(starts[2] - starts[1] >= 500);
  await time.tick(60_000);
  const later = Array.from({ length: 4 }, (_, i) => scheduler.execute(`next-${i}`, async () => { starts.push(time.clock()); }));
  await time.finish(); await Promise.all(later);
  assert.equal(starts.at(-1) - starts.at(-2), 250);
});

test("numeric and HTTP-date Retry-After are supported, long cooldowns fail promptly", async () => {
  const now = Date.parse("2026-10-19T00:00:00Z");
  assert.equal(retryAfterMilliseconds("1.5", now), 1_500);
  assert.equal(retryAfterMilliseconds("Mon, 19 Oct 2026 00:00:03 GMT", now), 3_000);
  assert.equal(retryAfterMilliseconds("nonsense", now), null);
  const time = virtualClock(now), scheduler = createTomTomScheduler(time);
  let calls = 0;
  const result = scheduler.execute("a", async () => {
    calls += 1;
    throw new AppError(429, "TOMTOM_RATE_LIMITED", "limited", { retryAfter: "30" });
  });
  const rejected = assert.rejects(result, error => error.code === "TOMTOM_RATE_LIMITED");
  await time.finish(); await rejected;
  const next = assert.rejects(scheduler.execute("b", () => { calls += 1; }), error => error.code === "TOMTOM_RATE_LIMITED");
  await time.finish(); await next;
  assert.equal(calls, 1);
});

test("temporary server errors retry once; reconstruction and authentication errors do not retry", async () => {
  for (const [code, status, expected] of [["TOMTOM_TIMEOUT", 502, 2], ["TOMTOM_BAD_STATUS", 503, 2],
    ["IETT_ROUTE_RECONSTRUCTION_FAILED", 502, 1], ["TOMTOM_AUTH_FAILED", 503, 1]]) {
    const time = virtualClock(), scheduler = createTomTomScheduler(time);
    let calls = 0;
    const rejected = assert.rejects(scheduler.execute(code, async () => {
      calls += 1; throw new AppError(status, code, "failure", { status });
    }), error => error.code === code);
    await time.finish(); await rejected;
    assert.equal(calls, expected, code);
  }
});

test("TomTomClient parses HTTP-date cooldowns through the shared transport", async () => {
  const time = virtualClock(Date.parse("2026-10-19T00:00:00Z"));
  const scheduler = createTomTomScheduler(time);
  let calls = 0;
  const client = new TomTomClient({ apiKey: "key", scheduler, fetchImpl: async () => {
    calls += 1;
    return calls === 1 ? new Response("{}", { status: 429, headers: { "retry-after": "Mon, 19 Oct 2026 00:00:03 GMT" } })
      : new Response('{"routes":[]}');
  } });
  const result = client.calculateRoute({});
  await time.finish(); assert.deepEqual(await result, { routes: [] });
  assert.equal(calls, 2); assert.ok(time.clock() >= Date.parse("2026-10-19T00:00:03Z"));
});

test("429 cooldown is applied from headers without waiting for the error response body", async () => {
  const time = virtualClock(), scheduler = createTomTomScheduler(time);
  let cancelled = false;
  const client = new TomTomClient({ apiKey: "key", scheduler, fetchImpl: async () => ({
    status: 429, headers: new Headers({ "retry-after": "30" }),
    body: { async cancel() { cancelled = true; } },
    json: () => new Promise(() => {})
  }) });
  const rejected = assert.rejects(client.calculateRoute({}), error => error.code === "TOMTOM_RATE_LIMITED");
  await time.finish(); await rejected;
  assert.equal(cancelled, true);
});

test("BUS diagnostics distinguish one geometry attempt from two HTTP attempts after a retry", async () => {
  const time = virtualClock(), scheduler = createTomTomScheduler(time);
  let calls = 0;
  const tomTomClient = new TomTomClient({ apiKey: "key", scheduler, fetchImpl: async (_url, options) => {
    calls += 1;
    if (calls === 1) return new Response("{}", { status: 503 });
    const request = JSON.parse(options.body);
    return new Response(JSON.stringify({ routes: [{ legs: [{ path: request.legs[0].path, summary: {
      lengthInMeters: 839, travelDurationInSeconds: 100, trafficDelayDurationInSeconds: 0,
      departureDateTime: "2026-10-19T08:00:00+03:00", arrivalDateTime: "2026-10-19T08:01:40+03:00"
    } }] }] }));
  } });
  const service = createIettService({ tomTomClient, client: { getRoutePin: async () => [{
    line: "LINESTRING (29 41, 29.01 41)", stationPlaces: [
      { stationName: "A", lat: 41, lng: 29 }, { stationName: "B", lat: 41, lng: 29.01 }
    ]
  }] } });
  const calculation = service.calculateIettRouteTimes("TEST_D_D0", { debug: true });
  await time.finish();
  const result = await calculation;
  assert.equal(result.debug.geometryAttemptCount, 1);
  assert.equal(result.debug.upstreamRequestCount, 2);
  assert.equal(result.debug.maximumGeometryAttemptCount, 3);
  assert.equal(result.debug.maximumUpstreamRequestCount, 6);
});

test("an earlier 429 cannot become the cause of a later geometry failure", async () => {
  const time = virtualClock(), scheduler = createTomTomScheduler(time);
  let calls = 0;
  const tomTomClient = new TomTomClient({ apiKey: "key", scheduler, fetchImpl: async () => {
    calls += 1;
    if (calls === 1) return new Response("{}", { status: 429, headers: { "retry-after": "0.001" } });
    return new Response(JSON.stringify({ detailedError: { code: "CANNOT_RESTORE_BASEROUTE" } }), { status: 400 });
  } });
  const service = createIettService({ tomTomClient, client: { getRoutePin: async () => [{
    line: "LINESTRING (29 41, 29.01 41)", stationPlaces: [
      { stationName: "A", lat: 41, lng: 29 }, { stationName: "B", lat: 41, lng: 29.01 }
    ]
  }] } });
  const rejected = assert.rejects(service.calculateIettRouteTimes("ERROR_D_D0"), error => {
    assert.equal(error.code, "IETT_ROUTE_RECONSTRUCTION_FAILED");
    assert.equal(error.details.lastErrorCode, "IETT_ROUTE_RECONSTRUCTION_FAILED");
    assert.equal(error.details.upstreamRequestCount, 4);
    assert.equal(error.details.geometryAttemptCount, 3);
    return true;
  });
  await time.finish(); await rejected;
  assert.equal(calls, 4);
});
