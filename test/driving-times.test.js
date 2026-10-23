import assert from "node:assert/strict";
import test from "node:test";
import { createDrivingTimeService } from "../src/services/driving-times.js";
import { TomTomClient } from "../src/clients/tomtom-client.js";
import { AppError } from "../src/shared/errors.js";

const input = {
  origin: { lat: 40.979940, lng: 29.128038 },
  destination: { lat: 40.974683, lng: 29.153881 },
  departureTime: "2026-10-19T08:15:00+03:00"
};
const response = () => ({ routes: [{ summary: {
  travelDurationInSeconds: 901, trafficDelayDurationInSeconds: 120, lengthInMeters: 5400
} }] });

test("driving service uses TomTom car routing, GeoJSON lng/lat order and a dated departure", async () => {
  let received;
  const tomTomClient = new TomTomClient({
    apiKey: "test-key",
    fetchImpl: async (url, options) => {
      received = { url, options, payload: JSON.parse(options.body) };
      return new Response(JSON.stringify(response()), { status: 200 });
    }
  });
  const result = await createDrivingTimeService({ tomTomClient }).calculateDrivingTimes(input);
  assert.deepEqual(received.payload, {
    routePlanningLocations: {
      origin: { type: "Point", coordinates: [29.128038, 40.979940] },
      destination: { type: "Point", coordinates: [29.153881, 40.974683] }
    },
    departureDateTime: "2026-10-19T05:15:00.000Z",
    travelMode: "car", routeType: "fast", traffic: "live"
  });
  assert.equal(received.options.headers["tomtom-api-key"], "test-key");
  assert.deepEqual(result, {
    durationSeconds: 901, provider: "tomtom-orbis", trafficDelaySeconds: 120, distanceMeters: 5400,
    requestedTrafficMode: "live", trafficTimeContext: "scheduled",
    trafficDataBasis: "historical-with-known-live-events"
  });
});

test("driving cache shares pending calculations and expires successful results 60 seconds after completion", async () => {
  let now = 0;
  let calls = 0;
  let complete;
  const service = createDrivingTimeService({ clock: () => now, tomTomClient: {
    calculateRoute: () => {
      calls += 1;
      if (calls === 1) return new Promise(resolve => { complete = resolve; });
      return Promise.resolve(response());
    }
  } });
  const first = service.calculateDrivingTimes(input);
  const sameInstant = service.calculateDrivingTimes({ ...input, departureTime: "2026-10-19T05:15:00Z" });
  assert.equal(first, sameInstant);
  assert.equal(calls, 1);
  now = 30_000;
  complete(response());
  await first;
  now = 89_999;
  await service.calculateDrivingTimes(input);
  assert.equal(calls, 1);
  now = 90_000;
  await service.calculateDrivingTimes(input);
  assert.equal(calls, 2);
  service.clearCache();
  await service.calculateDrivingTimes(input);
  assert.equal(calls, 3);
});

test("driving cache separates origin, destination and departure time", async () => {
  let calls = 0;
  const service = createDrivingTimeService({ tomTomClient: {
    calculateRoute: async () => { calls += 1; return response(); }
  } });
  await service.calculateDrivingTimes(input);
  await service.calculateDrivingTimes({ ...input, departureTime: "2026-10-19T08:30:00+03:00" });
  await service.calculateDrivingTimes({ ...input, origin: { ...input.origin, lat: 41 } });
  await service.calculateDrivingTimes({ ...input, destination: { ...input.destination, lat: 41 } });
  assert.equal(calls, 4);
});

test("failed driving calls are evicted and retried rather than cached", async () => {
  let calls = 0;
  const service = createDrivingTimeService({ tomTomClient: {
    calculateRoute: async () => {
      calls += 1;
      if (calls === 1) throw new AppError(502, "TOMTOM_TIMEOUT", "Timed out.");
      return response();
    }
  } });
  await assert.rejects(service.calculateDrivingTimes(input), { code: "TOMTOM_TIMEOUT" });
  assert.equal((await service.calculateDrivingTimes(input)).durationSeconds, 901);
  assert.equal(calls, 2);
});

test("driving service rejects malformed estimates instead of returning an invented duration", async () => {
  for (const summary of [undefined, {}, { travelDurationInSeconds: -1 },
    { travelDurationInSeconds: "900" }, { travelDurationInSeconds: NaN },
    { travelDurationInSeconds: 900, trafficDelayDurationInSeconds: -1 },
    { travelDurationInSeconds: 900, trafficDelayDurationInSeconds: 901 }]) {
    const service = createDrivingTimeService({ tomTomClient: {
      calculateRoute: async () => ({ routes: [{ summary }] })
    } });
    await assert.rejects(service.calculateDrivingTimes(input), { code: "TOMTOM_MALFORMED_RESPONSE" });
  }
});
