import { performance } from "node:perf_hooks";
import { createJourneyService } from "../src/services/journey-service.js";
import { createIettService } from "../src/services/iett-service.js";
import { haversineDistance } from "../src/routing/geometry.js";

// Offline benchmark: traffic durations differ by departure, while upstream
// latency and route geometry remain repeatable. No API key or network is used.
const delay = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));
const date = "2026-10-19";
const departures = Array.from({ length: 24 }, (_, index) => `08:${String(index).padStart(2, "0")}`);
const input = {
  date, departureTime: "07:00", arrivalTime: "12:00",
  routes: Object.fromEntries(Array.from({ length: 4 }, (_, index) => [`route-${index}`, {
    "1": { type: "WALK", duration: 10 },
    "2": {
      type: "BUS", route: "19_D_D0", line: `label-${index}`,
      startStation: "STOP 0", endStation: "STOP 59", departures
    }
  }]))
};

async function measure(name, calculateBusTimes, statistics) {
  const planner = createJourneyService({
    clock: () => Date.parse(`${date}T06:00:00+03:00`), calculateBusTimes
  });
  const start = performance.now();
  const result = await planner.evaluateJourneys(input);
  return {
    name, elapsedMs: Math.round(performance.now() - start), ...statistics(),
    candidates: result.options.reduce((count, option) => count + option.candidates.length, 0),
    bestArrival: result.bestOption?.arrivalTime
  };
}

let calls = 0;
let active = 0;
let maximum = 0;
console.log(JSON.stringify(await measure("provider-latency", async (route, options) => {
  calls += 1;
  active += 1;
  maximum = Math.max(maximum, active);
  await delay(40);
  active -= 1;
  return { total: { estimatedDurationSeconds: 600 + Date.parse(options.departureTime) / 60_000 % 24 } };
}, () => ({ providerCalls: calls, maxConcurrent: maximum }))));

const points = Array.from({ length: 1_200 }, (_, index) => [29 + index * 0.00001, 41]);
const routeData = [{
  line: `LINESTRING (${points.map(point => point.join(" ")).join(", ")})`,
  stationPlaces: Array.from({ length: 60 }, (_, index) => ({
    stationName: `STOP ${index}`, lat: 41, lng: points[index * 20][0]
  }))
}];
calls = 0;
const busService = createIettService({
  client: { getRoutePin: async () => routeData },
  tomTomClient: { async calculateRoute(payload) {
    calls += 1;
    await delay(1);
    let timestamp = Date.parse(payload.departureDateTime);
    return { routes: [{ legs: payload.legs.map(leg => {
      const distance = leg.path.coordinates.slice(1).reduce((sum, point, index) => {
        const previous = leg.path.coordinates[index];
        return sum + haversineDistance({ lng: previous[0], lat: previous[1] }, { lng: point[0], lat: point[1] });
      }, 0);
      const duration = Math.round(distance / 8);
      const departureDateTime = new Date(timestamp).toISOString();
      timestamp += duration * 1_000;
      const arrivalDateTime = new Date(timestamp).toISOString();
      timestamp += (leg.routeStop?.pauseDurationInSeconds ?? 0) * 1_000;
      return { path: leg.path, summary: {
        lengthInMeters: Math.round(distance), travelDurationInSeconds: duration, trafficDelayDurationInSeconds: 0,
        departureDateTime, arrivalDateTime
      } };
    }) }] };
  } }
});
console.log(JSON.stringify(await measure("repeated-route-geometry", busService.calculateIettRouteTimes,
  () => ({ providerCalls: calls }))));
