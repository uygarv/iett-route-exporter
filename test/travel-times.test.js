import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { AppError } from "../src/shared/errors.js";
import { TOMTOM_HTTP_ATTEMPTS } from "../src/clients/tomtom-scheduler.js";
import { buildRouteGeometry, haversineDistance } from "../src/routing/geometry.js";
import { matchStopsToRoute } from "../src/routing/timing.js";
import { createIettService } from "../src/services/iett-service.js";

const FIXED_NOW = "2026-10-04T09:00:00.000Z";

function pathLength(path) {
  return path.coordinates.slice(1).reduce((total, coordinate, index) => {
    const previous = path.coordinates[index];

    return total + haversineDistance(
      { lng: previous[0], lat: previous[1] },
      { lng: coordinate[0], lat: coordinate[1] }
    );
  }, 0);
}

function createRouteData(stopCount = 47) {
  const stationPlaces = Array.from({ length: stopCount }, (_, index) => ({
    stationName: `STOP ${index}`,
    lat: 41,
    lng: 29 + index * 0.001
  }));
  const coordinates = stationPlaces.map(stop => `${stop.lng} ${stop.lat}`).join(", ");

  return [{
    line: `LINESTRING (${coordinates})`,
    stationPlaces
  }];
}

class MockTomTomClient {
  constructor({
    failAtCall = null,
    malformed = false,
    deviatingLeg = null,
    deviateOnlyOnFirstCall = false,
    deviateEveryLeg = false,
    shouldDeviate = null
  } = {}) {
    this.calls = [];
    this.failAtCall = failAtCall;
    this.malformed = malformed;
    this.deviatingLeg = deviatingLeg;
    this.deviateOnlyOnFirstCall = deviateOnlyOnFirstCall;
    this.deviateEveryLeg = deviateEveryLeg;
    this.shouldDeviate = shouldDeviate;
  }

  async calculateRoute(payload) {
    this.calls.push(payload);

    if (this.calls.length === this.failAtCall) {
      throw new Error("TomTom fixture failure");
    }

    if (this.malformed) {
      return { routes: [{ legs: [] }] };
    }

    let timestamp = payload.departureDateTime === "now"
      ? Date.parse(FIXED_NOW)
      : Date.parse(payload.departureDateTime);
    let pathIndex = 0;
    let cumulativeDriving = 0;
    const progressPoints = [{ pathIndex: 0, travelDurationInSeconds: 0 }];
    const locations = [payload.routePlanningLocations.origin.coordinates,
      ...(payload.routePlanningLocations.waypoints?.coordinates ?? []),
      payload.routePlanningLocations.destination.coordinates];
    const legs = payload.legs.map((rawLeg, index) => {
      const requestLeg = { ...rawLeg, path: rawLeg.path ?? {
        type: "LineString", coordinates: [locations[index], locations[index + 1]]
      } };
      const departureDateTime = new Date(timestamp).toISOString();
      let drivingDuration = 0;
      const edges = requestLeg.path.coordinates.length - 1;
      for (let edge = 0; edge < edges; edge += 1) {
        const seconds = 80 + pathIndex % 3;
        drivingDuration += seconds;
        cumulativeDriving += seconds;
        pathIndex += 1;
        progressPoints.push({ pathIndex, travelDurationInSeconds: cumulativeDriving });
      }
      const arrivalTimestamp = timestamp + drivingDuration * 1_000;
      const arrivalDateTime = new Date(arrivalTimestamp).toISOString();
      const selectedForDeviation = this.deviateEveryLeg
        || index === this.deviatingLeg
        || this.shouldDeviate?.({ payload, requestLeg, index });
      const shouldDeviate = selectedForDeviation
        && (!this.deviateOnlyOnFirstCall || this.calls.length === 1);
      const path = shouldDeviate
        ? {
            type: "LineString",
            coordinates: [
              requestLeg.path.coordinates[0],
              [
                requestLeg.path.coordinates[0][0] + 0.05,
                requestLeg.path.coordinates[0][1] + 0.05
              ],
              requestLeg.path.coordinates.at(-1)
            ]
          }
        : requestLeg.path;

      timestamp = arrivalTimestamp
        + (requestLeg.routeStop?.pauseDurationInSeconds ?? 0) * 1_000;

      return {
        path: structuredClone(path),
        summary: {
          lengthInMeters: Math.round(pathLength(path)),
          travelDurationInSeconds: drivingDuration,
          trafficDelayDurationInSeconds: 10 * edges,
          departureDateTime,
          arrivalDateTime
        }
      };
    });

    return { routes: [{ legs, progressPoints }] };
  }
}

function createService(stopCount = 47, tomTomClient = new MockTomTomClient(), options = {}) {
  const data = createRouteData(stopCount);
  const client = {
    calls: 0,
    async getRoutePin() {
      this.calls += 1;
      return data;
    }
  };

  return {
    client,
    tomTomClient,
    service: createIettService({
      client,
      tomTomClient,
      ...options,
      timingCacheTtlMs: options.timingCacheTtlMs ?? 60_000
    })
  };
}

test("calculates one traffic-aware segment for every adjacent stop", async () => {
  const { service, tomTomClient } = createService();
  const result = await service.calculateIettRouteTimes("256_D_D0", {
    debug: true
  });

  assert.equal(tomTomClient.calls.length, 1);
  assert.equal(result.provider, "tomtom-orbis");
  assert.equal(result.requestedTrafficMode, "live");
  assert.equal(result.trafficTimeContext, "immediate");
  assert.equal(result.trafficDataBasis, "live");
  assert.equal(result.segments.length, 46);
  assert.equal(result.origin.name, "STOP 0");
  assert.equal(result.destination.name, "STOP 46");
  assert.equal(result.total.drivingDurationSeconds, 3725);
  assert.equal(result.total.dwellDurationSeconds, 675);
  assert.equal(result.total.estimatedDurationSeconds, 4400);
  assert.ok(result.segments.slice(0, -1).every(segment => segment.dwellAfterArrivalSeconds === 15));
  assert.equal(result.total.liveTrafficDelaySeconds, 460);
  assert.equal("freeFlowDurationSeconds" in result.total, false);
  assert.equal(result.total.distanceMeters, Math.round(pathLength(tomTomClient.calls[0].legs[0].path)));
  assert.ok(result.segments.every(segment => segment.stopTimingSource === "tomtom-progress-interpolation"));
  assert.equal(result.segments.at(-1).dwellAfterArrivalSeconds, 0);
  assert.equal(result.debug.matchedStops.length, 47);

  const request = tomTomClient.calls[0];
  assert.equal(request.traffic, "live");
  assert.equal(request.routeType, "fast");
  assert.equal(request.travelMode, "car");
  assert.equal(request.departureDateTime, "now");
  assert.equal(request.routePlanningLocations.waypoints, undefined);
  assert.equal(request.path, undefined);
  assert.equal(request.legs.length, 1);
  assert.equal(request.legs[0].path.type, "LineString");
  assert.equal(request.legs[0].path.coordinates.length, 47);
  assert.deepEqual(request.legs[0].path.coordinates[0], [29, 41]);
  assert.deepEqual(request.legs[0].path.coordinates.at(-1), [29.046, 41]);
  assert.equal(request.legs[0].routeStop, undefined);
  assert.equal(result.debug.waypointStrategy, "hybrid-local-adaptive");
  assert.equal(result.debug.omittedStopWaypointCount, 45);
  assert.equal(result.segments[1].drivingDurationSeconds, 81);
  assert.equal(result.segments[2].drivingDurationSeconds, 82);
});

test("projects distant timing stops onto the IETT line instead of rejecting them", async () => {
  const tomTomClient = new MockTomTomClient();
  const data = [{
    line: "LINESTRING (29 41, 29.04 41)",
    stationPlaces: [
      { stationName: "START", lat: 41, lng: 29 },
      { stationName: "DISTANT STOP", lat: 41.003, lng: 29.02 },
      { stationName: "END", lat: 41, lng: 29.04 }
    ]
  }];
  const service = createIettService({
    client: {
      async getRoutePin() {
        return data;
      }
    },
    tomTomClient
  });
  const result = await service.calculateIettRouteTimes("256_G_D0", { debug: true });

  assert.equal(tomTomClient.calls[0].routePlanningLocations.waypoints, undefined);
  assert.equal(result.debug.routingAnchorCount, 0);
  assert.equal(result.segments.length, 2);
  assert.equal(result.debug.matchedStops[1].projectedToRoute, true);
  assert.ok(result.debug.matchedStops[1].distanceToRoute > 300);
});

test("normal responses summarize geometry while debug retains full diagnostics", async () => {
  const fixture = JSON.parse(await readFile(new URL("./fixtures/256-local-routing.json", import.meta.url), "utf8"));
  const scenario = fixture.cases[0];
  let calls = 0;
  const service = createIettService({ client: { getRoutePin: async () => fixture.routeData },
    tomTomClient: { async calculateRoute() {
      return structuredClone(scenario.exchanges[calls++ % 2].response);
    } } });
  const result = await service.calculateIettRouteTimes(fixture.routeCode, scenario.options);
  assert.equal(result.debug, undefined);
  assert.equal(result.total.dwellDurationSeconds, 43 * 15);
  assert.equal(result.total.estimatedDurationSeconds, result.total.drivingDurationSeconds + 43 * 15);
  assert.equal(result.geometryMatch.quality, "approximate");
  assert.equal(result.geometryMatch.acceptanceBasis, "stop-preserving-local-alternative");
  assert.equal(result.geometryMatch.orderMismatches, undefined);
  assert.equal(result.geometryMatch.deviations, undefined);
  assert.equal(result.geometryMatch.referenceGeometryReasons, undefined);
  assert.equal(result.warnings[0].alternatives, undefined);
  assert.equal(result.warnings[0].code, "IETT_LOCAL_ROUTE_APPROXIMATION");
  assert.deepEqual(Object.keys(result.geometryMatch.alternatives[0]), [
    "fromStationIndex", "toStationIndex", "referenceLengthMeters", "returnedLengthMeters"
  ]);
  for (const segment of result.segments) {
    assert.equal(segment.distanceMeters, Math.round(segment.distanceMeters * 10) / 10);
  }
  assert.equal(result.total.distanceMeters, 29281);
  assert.ok(Math.abs(result.segments.reduce((sum, segment) => sum + segment.distanceMeters, 0) - result.total.distanceMeters) < 1e-6);
  // Clear the learned plan so both projections use the same recorded requests.
  service.clearCaches();
  const debug = await service.calculateIettRouteTimes(fixture.routeCode, { ...scenario.options, debug: true });
  assert.deepEqual(debug.geometryMatch, result.geometryMatch);
  assert.ok(debug.debug.geometryMatch.orderMismatches.reference.length);
  assert.ok(debug.debug.geometryMatch.referenceGeometryReasons.length);
  assert.equal(debug.debug.geometryMatch.referenceGeometryValid, false);
  assert.ok(debug.debug.geometryMatch.alternatives[0].startDistanceAlongRoute > 0);
});

test("supports station ranges, current location, future departures, and custom dwell", async () => {
  const future = "2026-10-05T12:30:00+03:00";
  const first = createService(20);
  const stationRange = await first.service.calculateIettRouteTimes("256_D_D0", {
    startStation: "stop 3",
    endStation: "STOP 8",
    departureTime: future,
    dwellTimeSeconds: 0
  });

  assert.equal(stationRange.origin.stationIndex, 3);
  assert.equal(stationRange.destination.stationIndex, 8);
  assert.equal(stationRange.segments.length, 5);
  assert.equal(stationRange.total.dwellDurationSeconds, 0);
  assert.equal(stationRange.requestedTrafficMode, "live");
  assert.equal(stationRange.trafficTimeContext, "scheduled");
  assert.equal(
    stationRange.trafficDataBasis,
    "historical"
  );
  assert.equal(first.tomTomClient.calls[0].departureDateTime, "2026-10-05T09:30:00.000Z");
  assert.ok(first.tomTomClient.calls[0].legs.slice(0, -1).every(leg => {
    return (leg.routeStop?.pauseDurationInSeconds ?? 0) === 0;
  }));

  const second = createService(20);
  const currentLocation = { lat: 41, lng: 29.0052 };
  const currentRange = await second.service.calculateIettRouteTimes("256_D_D0", {
    currentLocation,
    endStation: "STOP 10"
  });

  assert.deepEqual(currentRange.origin, {
    type: "current-location",
    ...currentLocation
  });
  assert.equal(currentRange.destination.stationIndex, 10);
  assert.equal(currentRange.segments[0].to.stationIndex, 6);
  assert.equal(second.tomTomClient.calls[0].routePlanningLocations.origin.coordinates[0], 29.0052);

  const startOnly = createService(12);
  const fromStation = await startOnly.service.calculateIettRouteTimes("256_D_D0", {
    startStation: "STOP 4"
  });

  assert.equal(fromStation.origin.stationIndex, 4);
  assert.equal(fromStation.destination.stationIndex, 11);

  const endOnly = createService(12);
  const toStation = await endOnly.service.calculateIettRouteTimes("256_D_D0", {
    endStation: "STOP 4"
  });

  assert.equal(toStation.origin.stationIndex, 0);
  assert.equal(toStation.destination.stationIndex, 4);

  const localTime = createService(12);

  await localTime.service.calculateIettRouteTimes("256_D_D0", {
    departureTime: "2026-10-04T10:00:00"
  });

  assert.equal(
    localTime.tomTomClient.calls[0].departureDateTime,
    "2026-10-04T10:00:00"
  );
});

test("selects repeated stops by their numbered names", async () => {
  const tomTomClient = new MockTomTomClient();
  const data = createRouteData(8);

  data[0].stationPlaces[2].stationName = "SAME STOP";
  data[0].stationPlaces[5].stationName = "SAME STOP";

  const service = createIettService({
    client: {
      async getRoutePin() {
        return data;
      }
    },
    tomTomClient
  });
  const result = await service.calculateIettRouteTimes("256_D_D0", {
    startStation: "same stop (2)"
  });

  assert.equal(result.origin.stationIndex, 5);
  assert.equal(result.origin.name, "SAME STOP (2)");
  assert.equal("displayName" in result.origin, false);

  await assert.rejects(
    service.calculateIettRouteTimes("256_D_D0", {
      startStation: "SAME STOP"
    }),
    error => {
      return error.code === "AMBIGUOUS_START_STATION"
        && error.details.candidates.length === 2;
    }
  );
});

test("handles more than 150 stops in one sparse request and preserves every stop dwell", async () => {
  const { service, tomTomClient } = createService(154);
  const result = await service.calculateIettRouteTimes("LONG_G_D0", {
    debug: true,
    departureTime: "2026-10-04T09:00:00Z",
    dwellTimeSeconds: 30
  });

  assert.equal(tomTomClient.calls.length, 1);
  assert.equal(tomTomClient.calls[0].routePlanningLocations.waypoints, undefined);
  assert.equal(tomTomClient.calls[0].legs.length, 1);
  assert.equal(result.segments.length, 153);
  assert.equal(result.total.dwellDurationSeconds, 152 * 30);
  assert.equal(result.debug.omittedStopWaypointCount, 152);
  for (let index = 1; index < result.segments.length; index += 1) {
    assert.equal(Date.parse(result.segments[index].departureTime),
      Date.parse(result.segments[index - 1].arrivalTime) + 30_000);
  }
});

test("shares pending and successful calculations and evicts failures", async () => {
  const successful = createService(10);
  const [first, second] = await Promise.all([
    successful.service.calculateIettRouteTimes("256_D_D0", {}),
    successful.service.calculateIettRouteTimes("256_D_D0", {})
  ]);

  assert.equal(first, second);
  assert.equal(successful.tomTomClient.calls.length, 1);
  assert.equal(successful.client.calls, 1);

  await successful.service.calculateIettRouteTimes("256_D_D0", {});
  assert.equal(successful.tomTomClient.calls.length, 1);

  const failingTomTom = new MockTomTomClient({ failAtCall: 1 });
  const failing = createService(10, failingTomTom);

  await assert.rejects(failing.service.calculateIettRouteTimes("256_D_D0", {}));
  failingTomTom.failAtCall = null;
  await failing.service.calculateIettRouteTimes("256_D_D0", {});

  assert.equal(failingTomTom.calls.length, 2);

  const expiring = createService(10, new MockTomTomClient(), {
    timingCacheTtlMs: 5
  });

  await expiring.service.calculateIettRouteTimes("256_D_D0", {});
  await new Promise(resolve => setTimeout(resolve, 10));
  await expiring.service.calculateIettRouteTimes("256_D_D0", {});

  assert.equal(expiring.tomTomClient.calls.length, 2);
});

test("reuses route preparation without sharing mutable results or mixing departure times and dwell", async () => {
  const { service, tomTomClient } = createService(10);
  const common = { startStation: "STOP 2", endStation: "STOP 8", debug: true };
  const [first, second] = await Promise.all([
    service.calculateIettRouteTimes("256_D_D0", { ...common,
      departureTime: "2026-10-19T08:00:00+03:00" }),
    service.calculateIettRouteTimes("256_D_D0", { ...common,
      departureTime: "2026-10-19T08:30:00+03:00", dwellTimeSeconds: 0 })
  ]);
  assert.equal(tomTomClient.calls.length, 2);
  assert.equal(first.total.departureTime, "2026-10-19T05:00:00.000Z");
  assert.equal(second.total.departureTime, "2026-10-19T05:30:00.000Z");
  assert.equal(first.total.dwellDurationSeconds, 75);
  assert.equal(second.total.dwellDurationSeconds, 0);
  assert.equal(first.segments.length, 6);
  assert.equal(second.segments.length, 6);
  first.debug.matchedStops[0].providerCoordinate.lng = 99;
  first.segments[0].from.name = "changed by caller";
  const third = await service.calculateIettRouteTimes("256_D_D0", { ...common,
    departureTime: "2026-10-19T09:00:00+03:00" });
  assert.equal(third.debug.matchedStops[0].providerCoordinate.lng, 29);
  assert.equal(third.segments[0].from.name, "STOP 2");
  assert.equal(third.total.dwellDurationSeconds, 75);
});

test("route preparation is invalidated when IETT updates an existing route record", async () => {
  const data = createRouteData(10);
  const tomTomClient = new MockTomTomClient();
  const service = createIettService({ client: { getRoutePin: async () => data }, tomTomClient });
  await service.calculateIettRouteTimes("256_D_D0", {
    departureTime: "2026-10-19T08:00:00+03:00", startStation: "STOP 2"
  });
  data[0].stationPlaces[2].stationName = "UPDATED STOP";
  const updated = await service.calculateIettRouteTimes("256_D_D0", {
    departureTime: "2026-10-19T08:30:00+03:00", startStation: "UPDATED STOP"
  });
  assert.equal(updated.origin.name, "UPDATED STOP");
  assert.equal(tomTomClient.calls.length, 2);
  service.clearCaches();
  const refreshed = await service.calculateIettRouteTimes("256_D_D0", {
    departureTime: "2026-10-19T08:30:00+03:00", startStation: "UPDATED STOP"
  });
  assert.equal(tomTomClient.calls.length, 3);
  assert.deepEqual(refreshed.total, updated.total);
});

test("rejects invalid options and malformed TomTom legs", async () => {
  const normal = createService(10);

  await assert.rejects(
    normal.service.calculateIettRouteTimes("256_D_D0", { dwellTimeSeconds: 601 }),
    error => error.status === 400 && error.code === "INVALID_DWELL_TIME"
  );
  await assert.rejects(
    normal.service.calculateIettRouteTimes("256_D_D0", { departureTime: "not-a-date" }),
    error => error.status === 400 && error.code === "INVALID_DEPARTURE_TIME"
  );
  await assert.rejects(
    normal.service.calculateIettRouteTimes("256_D_D0", {
      startStation: "STOP 1",
      currentLocation: { lat: 41, lng: 29 }
    }),
    error => error.status === 400 && error.code === "CONFLICTING_START_OPTIONS"
  );

  const malformed = createService(10, new MockTomTomClient({ malformed: true }));

  await assert.rejects(
    malformed.service.calculateIettRouteTimes("256_D_D0", {}),
    error => error.status === 502 && error.code === "TOMTOM_MALFORMED_RESPONSE"
  );

  const deviating = createService(10, new MockTomTomClient({ deviateEveryLeg: true }));

  await assert.rejects(
    deviating.service.calculateIettRouteTimes("256_D_D0", {}),
    error => error.status === 502 && error.code === "IETT_ROUTE_RECONSTRUCTION_FAILED"
      && error.details.upstreamRequestCount <= 3
  );
  assert.ok(deviating.tomTomClient.calls.length <= 3);
});

test("repairs a deviation with ordered stops and omits paths only on the affected legs", async () => {
  const tomTomClient = new MockTomTomClient({
    deviatingLeg: 0,
    deviateOnlyOnFirstCall: true
  });
  const { service } = createService(10, tomTomClient);
  const result = await service.calculateIettRouteTimes("256_D_D0", { debug: true });

  assert.equal(tomTomClient.calls.length, 2);
  assert.equal(result.debug.upstreamRequestCount, 2);
  assert.deepEqual(result.debug.waypointAttempts.map(attempt => attempt.strategy), ["reconstruction", "local-waypoints"]);
  assert.equal(tomTomClient.calls[1].routePlanningLocations.waypoints.coordinates.length, 8);
  assert.ok(tomTomClient.calls[1].legs.every(leg => leg.path === undefined));
  assert.ok(result.segments.every(segment => segment.drivingDurationSeconds >= 0));
});

test("estimates a short IETT-only turn instead of accepting a long TomTom detour", async () => {
  const tomTomClient = new MockTomTomClient({
    deviatingLeg: 0,
    deviateOnlyOnFirstCall: true
  });
  const data = [{
    line: "LINESTRING (29 41, 29.001 41, 29.001 40.9999, 29 40.9999)",
    stationPlaces: [
      { stationName: "START", lat: 41, lng: 29 },
      { stationName: "TURN IN", lat: 41, lng: 29.001 },
      { stationName: "TURN OUT", lat: 40.9999, lng: 29.001 },
      { stationName: "END", lat: 40.9999, lng: 29 }
    ]
  }];
  const service = createIettService({
    client: {
      async getRoutePin() {
        return data;
      }
    },
    tomTomClient
  });
  const result = await service.calculateIettRouteTimes("TURN_G_D0", {
    debug: true, startStation: "TURN IN", endStation: "TURN OUT",
    dwellTimeSeconds: 0
  });

  assert.equal(result.routingQuality, "validated-with-iett-maneuver-estimate");
  assert.equal(result.warnings[0].code, "UNMAPPED_IETT_MANEUVER_ESTIMATED");
  assert.equal(result.segments[0].estimatedManeuverDurationSeconds, 8);
  assert.equal(result.total.estimatedManeuverDurationSeconds, 8);
  assert.equal(result.debug.estimatedManeuvers.length, 1);
  assert.ok(result.debug.estimatedManeuvers[0].turnAngle > 60);
  assert.equal(tomTomClient.calls.length, 1);
});

test("keeps a strongly turning IETT section with only necessary controls and bounded attempts", async () => {
  const tomTomClient = new MockTomTomClient({
    shouldDeviate({ requestLeg }) {
      return pathLength(requestLeg.path) > 500;
    }
  });
  const data = [{
    line: "LINESTRING (29 41, 29.001 41, 29.0008 40.99998, 28.992 40.9998)",
    stationPlaces: [
      { stationName: "START", lat: 41, lng: 29 },
      { stationName: "BUS TURN", lat: 41, lng: 29.001 },
      { stationName: "END", lat: 40.9998, lng: 28.992 }
    ]
  }];
  const service = createIettService({
    client: {
      async getRoutePin() {
        return data;
      }
    },
    tomTomClient
  });
  const result = await service.calculateIettRouteTimes("TURN_D_D0", {
    debug: true, dwellTimeSeconds: 0
  });
  assert.equal(result.routingQuality, "tomtom-geometry-validated");
  assert.equal(result.debug.estimatedManeuvers.length, 0);
  assert.ok(tomTomClient.calls.length <= 3);
  assert.ok(tomTomClient.calls.every(call =>
    (call.routePlanningLocations.waypoints?.coordinates.length ?? 0) <= 150));
});

test("the recorded 11T bounded deviations return an approximation after one request", async () => {
  const fixture = JSON.parse(await readFile(new URL("./fixtures/11t-sparse-routing.json", import.meta.url), "utf8"));
  const calls = [];
  const service = createIettService({
    client: { getRoutePin: async () => fixture.routeData },
    tomTomClient: { async calculateRoute(payload) {
      calls.push(payload);
      assert.ok(calls.length <= fixture.responses.length);
      return fixture.responses[calls.length - 1];
    } }
  });
  const result = await service.calculateIettRouteTimes(fixture.routeCode, fixture.options);
  assert.equal(result.routingQuality, "tomtom-geometry-approximate");
  assert.equal(result.geometryMatch.valid, true);
  assert.ok(result.debug.geometryMatch.returnedToReferenceMaxMeters > 80);
  assert.ok(result.debug.geometryMatch.returnedLongestDeviationMeters <= 400);
  assert.equal(result.warnings[0].code, "IETT_GEOMETRY_APPROXIMATION");
  assert.deepEqual(calls.map(payload => payload.routePlanningLocations.waypoints?.coordinates.length ?? 0), [0]);

});

test("absent progress points produce an explicit interpolation warning without changing provider totals", async () => {
  const base = new MockTomTomClient();
  const service = createIettService({
    client: { getRoutePin: async () => createRouteData(10) },
    tomTomClient: { async calculateRoute(payload) {
      const response = await base.calculateRoute(payload);
      delete response.routes[0].progressPoints;
      return response;
    } }
  });
  const result = await service.calculateIettRouteTimes("TEST_D_D0");
  assert.equal(result.stopTimingSource, "distance-interpolation");
  assert.equal(result.warnings[0].code, "STOP_TIMES_DISTANCE_INTERPOLATED");
  assert.equal(result.total.drivingDurationSeconds, 729);
  assert.equal(result.total.liveTrafficDelaySeconds, 90);
  assert.equal(result.total.dwellDurationSeconds, 120);
});

test("a provider rate limit is isolated from geometry retries and does not add waypoints", async () => {
  const base = new MockTomTomClient();
  let calls = 0;
  const service = createIettService({
    client: { getRoutePin: async () => createRouteData(10) },
    tomTomClient: { async calculateRoute(payload) {
      calls += 1;
      if (calls <= 2) throw new AppError(429, "TOMTOM_RATE_LIMITED", "Try later.", { retryAfter: "0.001" });
      return base.calculateRoute(payload);
    } }
  });
  await assert.rejects(service.calculateIettRouteTimes("TEST_D_D0", { debug: true }),
    error => error.code === "TOMTOM_RATE_LIMITED");
  assert.equal(calls, 1);

});

test("recorded full and partial 256 routes use bounded local alternatives and preserve provider totals", async () => {
  const fixture = JSON.parse(await readFile(new URL("./fixtures/256-local-routing.json", import.meta.url), "utf8"));
  for (const scenario of fixture.cases) {
    let calls = 0;
    const exchanges = [...scenario.exchanges, ...(scenario.warm ? [scenario.warm.exchange] : [])];
    const service = createIettService({ client: { getRoutePin: async () => fixture.routeData },
      tomTomClient: { async calculateRoute(payload) {
        const exchange = exchanges[calls++];
        assert.ok(exchange, "No unexpected geometry request");
        assert.deepEqual(payload, exchange.request);
        return structuredClone(exchange.response);
      } } });
    // These provider replies were recorded with an explicit 20-second dwell.
    const result = await service.calculateIettRouteTimes(fixture.routeCode, { ...scenario.options, dwellTimeSeconds: 20, debug: true });
    assert.equal(calls, 2);
    assert.equal(result.routingQuality, "tomtom-geometry-approximate");
    assert.equal(result.warnings[0].code, "IETT_LOCAL_ROUTE_APPROXIMATION");
    assert.equal(result.geometryMatch.acceptanceBasis, "stop-preserving-local-alternative");
    assert.equal(result.debug.geometryMatch.referenceGeometryValid, false);
    assert.ok(result.debug.geometryMatch.referenceGeometryReasons.includes("ORDERED_PATH_DEVIATION"));
    assert.ok(result.geometryMatch.maximumStopOffsetMeters <= 50);
    assert.equal(result.debug.maximumGeometryAttemptCount, 3);
    assert.equal(result.debug.maximumUpstreamRequestCount, 6);
    assert.deepEqual(result.debug.waypointAttempts.map(attempt => attempt.strategy), ["reconstruction", "local-waypoints"]);
    const repair = exchanges[1].request;
    assert.ok(repair.legs[0].path);
    assert.ok(repair.legs.at(-1).path);
    assert.equal(repair.legs.filter(leg => !leg.path).length, 2);
    assert.equal(result.total.dwellDurationSeconds, (result.segments.length - 1) * 20);
    const legs = exchanges[1].response.routes[0].legs;
    assert.equal(result.total.drivingDurationSeconds, legs.reduce((sum, leg) => sum + leg.summary.travelDurationInSeconds, 0));
    assert.ok(Math.abs(result.total.distanceMeters - legs.reduce((sum, leg) => sum + leg.summary.lengthInMeters, 0)) < 1e-6);
    assert.ok(Math.abs(result.total.liveTrafficDelaySeconds - legs.reduce((sum, leg) => sum + leg.summary.trafficDelayDurationInSeconds, 0)) < 1e-6);
    assert.equal(Date.parse(result.total.arrivalTime) - Date.parse(result.total.departureTime), result.total.estimatedDurationSeconds * 1_000);
    assert.ok(result.segments.every(segment => segment.drivingDurationSeconds >= 0));
    if (scenario.warm) {
      const warm = await service.calculateIettRouteTimes(fixture.routeCode, { ...scenario.warm.options, debug: true });
      assert.equal(calls, 3);
      assert.equal(warm.debug.geometryAttemptCount, 1);
      assert.equal(warm.debug.waypointAttempts[0].learned, true);
      assert.equal(warm.warnings[0].code, "IETT_LOCAL_ROUTE_APPROXIMATION");
      assert.equal(warm.total.dwellDurationSeconds, (warm.segments.length - 1) * 30);
      assert.equal(warm.total.departureTime, "2026-10-18T16:10:00.000Z");
    }
  }
});

test("concurrent departures share learned geometry preparation, while each gets its own dated estimate", async () => {
  const fixture = JSON.parse(await readFile(new URL("./fixtures/11t-sparse-routing.json", import.meta.url), "utf8"));
  const calls = [];
  let completeFirst;
  const ready = new Promise(resolve => { completeFirst = resolve; });
  const service = createIettService({ client: { getRoutePin: async () => fixture.routeData },
    tomTomClient: { async calculateRoute(payload) {
      calls.push(payload);
      if (calls.length === 1) await ready;
      const response = structuredClone(fixture.responses[0]);
      const summary = response.routes[0].legs[0].summary;
      const duration = Date.parse(payload.departureDateTime) === Date.parse(fixture.options.departureTime) ? 1_721 : 1_821;
      summary.travelDurationInSeconds = duration;
      summary.departureDateTime = payload.departureDateTime;
      summary.arrivalDateTime = new Date(Date.parse(payload.departureDateTime) + duration * 1_000).toISOString();
      response.routes[0].progressPoints.at(-1).travelDurationInSeconds = duration;
      return response;
    } } });
  const first = service.calculateIettRouteTimes(fixture.routeCode, fixture.options);
  const second = service.calculateIettRouteTimes(fixture.routeCode, { ...fixture.options, departureTime: "2026-10-19T08:22:00+03:00" });
  for (let i = 0; i < 10; i += 1) await Promise.resolve();
  assert.equal(calls.length, 1);
  completeFirst();
  const [a, b] = await Promise.all([first, second]);
  assert.equal(calls.length, 2);
  assert.equal(a.total.drivingDurationSeconds, 1_721);
  assert.equal(b.total.drivingDurationSeconds, 1_821);
  assert.equal(b.routingQuality, "tomtom-geometry-approximate");
  assert.ok(b.geometryMatch.orderedMaximumDeviationMeters > 80); // Still compared to IETT, not the learned TomTom path.
  assert.deepEqual(calls[1].legs[0].path, fixture.responses[0].routes[0].legs[0].path);
  assert.notEqual(calls[1].departureDateTime, calls[0].departureDateTime);
});

test("a worse repair preserves the closest first reconstruction in failure diagnostics", async () => {
  const base = new MockTomTomClient();
  let calls = 0;
  const service = createIettService({ client: { getRoutePin: async () => createRouteData(40) },
    tomTomClient: { async calculateRoute(payload) {
      const response = await base.calculateRoute(payload);
      calls += 1;
      response.routes[0].legs.forEach(leg => {
        const first = leg.path.coordinates[0], last = leg.path.coordinates.at(-1);
        leg.path = { type: "LineString", coordinates: [first, [(first[0] + last[0]) / 2,
          first[1] + (calls === 1 ? .002 : .05)], last] };
        leg.summary.lengthInMeters = pathLength(leg.path);
      });
      return response;
    } } });
  await assert.rejects(service.calculateIettRouteTimes("CLOSEST_D_D0"), error => {
    assert.equal(error.code, "IETT_ROUTE_RECONSTRUCTION_FAILED");
    assert.ok(error.details.lastReconstruction.orderedMaximumDeviationMeters < 300);
    assert.equal(error.details.geometryAttemptCount, 2);
    return true;
  });
  assert.equal(calls, 2);
});

test("disconnected provider legs cannot pass whole-section geometry validation", async () => {
  const base = new MockTomTomClient();
  let calls = 0;
  const service = createIettService({ client: { getRoutePin: async () => createRouteData(10) },
    tomTomClient: { async calculateRoute(payload) {
      calls += 1;
      const response = await base.calculateRoute(payload);
      const legs = response.routes[0].legs;
      if (calls === 1) {
        legs[0].path.coordinates[4][1] += .005;
        legs[0].summary.lengthInMeters = pathLength(legs[0].path);
      } else {
        legs[0].path.coordinates.at(-1)[1] += .0002;
        legs[1].path.coordinates[0][1] -= .0002;
      }
      return response;
    } } });
  await assert.rejects(service.calculateIettRouteTimes("DISCONNECTED_D_D0"), error =>
    error.code === "IETT_ROUTE_RECONSTRUCTION_FAILED"
      && error.details.lastReconstruction.reasons.includes("DISCONNECTED_PROVIDER_LEGS"));
  assert.ok(calls <= 3);
});

test("an invalidated learned path retries the original IETT trace within the shared budget", async () => {
  const base = new MockTomTomClient(), calls = [];
  const service = createIettService({ timingCacheTtlMs: 0, client: { getRoutePin: async () => createRouteData(10) },
    tomTomClient: { async calculateRoute(payload) {
      calls.push(structuredClone(payload));
      if (calls.length === 2) throw new AppError(502, "IETT_ROUTE_RECONSTRUCTION_FAILED", "road network changed");
      return base.calculateRoute(payload);
    } } });
  await service.calculateIettRouteTimes("CHANGED_D_D0", {});
  const result = await service.calculateIettRouteTimes("CHANGED_D_D0", { debug: true });
  assert.equal(result.routingQuality, "tomtom-geometry-validated");
  assert.equal(result.debug.geometryAttemptCount, 2);
  assert.equal(calls.length, 3);
  assert.deepEqual(calls[2].legs[0].path, calls[0].legs[0].path);
  assert.equal(calls[2].routePlanningLocations.waypoints, undefined);
});

test("a reconstruction failure falls back to waypoints without paths", async () => {
  const base = new MockTomTomClient(), calls = [];
  const service = createIettService({ client: { getRoutePin: async () => createRouteData(40) },
    tomTomClient: { async calculateRoute(payload) {
      calls.push(structuredClone(payload));
      if (calls.length === 1) throw new AppError(502, "IETT_ROUTE_RECONSTRUCTION_FAILED", "unmatched trace");
      assert.ok(payload.legs.every(leg => leg.path === undefined));
      return base.calculateRoute(payload);
    } } });
  const result = await service.calculateIettRouteTimes("FALLBACK_D_D0", { debug: true });
  assert.equal(result.routingQuality, "tomtom-geometry-validated");
  assert.equal(calls.length, 2);
  assert.ok((calls[1].routePlanningLocations.waypoints?.coordinates.length ?? 0) <= 18);
  assert.equal(result.debug.waypointAttempts[1].strategy, "waypoints-only");
});

test("geometry work stops at three calculations and counts all six HTTP attempts", async () => {
  const base = new MockTomTomClient();
  let calls = 0;
  const data = createRouteData(5);
  data[0].line = data[0].line.replaceAll(/29\.00([1-4])/g, (_, digit) => String(29 + Number(digit) * .003));
  data[0].stationPlaces.forEach((stop, i) => { stop.lng = 29 + i * .003; });
  const service = createIettService({ client: { getRoutePin: async () => data },
    tomTomClient: { async calculateRoute(payload) {
      calls += 1;
      if (calls === 1) {
        const error = new AppError(502, "IETT_ROUTE_RECONSTRUCTION_FAILED", "unmatched trace");
        error[TOMTOM_HTTP_ATTEMPTS] = 2;
        throw error;
      }
      const response = await base.calculateRoute(payload);
      for (const leg of response.routes[0].legs) {
        const a = leg.path.coordinates[0], b = leg.path.coordinates.at(-1);
        leg.path = { type: "LineString", coordinates: [a, [(a[0] + b[0]) / 2, a[1] + .003], b] };
        leg.summary.lengthInMeters = pathLength(leg.path);
      }
      response[TOMTOM_HTTP_ATTEMPTS] = 2;
      return response;
    } } });
  await assert.rejects(service.calculateIettRouteTimes("BUDGET_D_D0"), error => {
    assert.equal(error.code, "IETT_ROUTE_RECONSTRUCTION_FAILED");
    assert.equal(error.details.geometryAttemptCount, 3);
    assert.equal(error.details.maximumGeometryAttemptCount, 3);
    assert.equal(error.details.upstreamRequestCount, 6);
    assert.equal(error.details.maximumUpstreamRequestCount, 6);
    return true;
  });
  assert.equal(calls, 3);
});

test("transport failures do not trigger waypoint fallback", async () => {
  let calls = 0;
  const service = createIettService({ client: { getRoutePin: async () => createRouteData(10) },
    tomTomClient: { async calculateRoute() {
      calls += 1;
      throw new AppError(502, "TOMTOM_TIMEOUT", "timeout");
    } } });
  await assert.rejects(service.calculateIettRouteTimes("TIMEOUT_D_D0"), error => error.code === "TOMTOM_TIMEOUT");
  assert.equal(calls, 1);
});

test("learned geometry expires, is bounded and is invalidated by source changes and clearing caches", async () => {
  let now = 0;
  const data = createRouteData(10), calls = [];
  const base = new MockTomTomClient();
  const service = createIettService({ client: { getRoutePin: async () => data }, clock: () => now,
    shapeCacheTtlMs: 100, shapeCacheMaxEntries: 1, timingCacheTtlMs: 0,
    tomTomClient: { async calculateRoute(payload) {
      calls.push(structuredClone(payload));
      const response = structuredClone(await base.calculateRoute(payload));
      // A redundant midpoint makes reuse of the learned path observable.
      const path = response.routes[0].legs[0].path;
      const a = path.coordinates[0], b = path.coordinates[1];
      path.coordinates.splice(1, 0, [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2]);
      return response;
    } } });
  await service.calculateIettRouteTimes("CACHE_D_D0", {});
  now = 50;
  await service.calculateIettRouteTimes("CACHE_D_D0", {});
  assert.equal(calls[1].legs[0].path.coordinates.length, 11);
  now = 101;
  await service.calculateIettRouteTimes("CACHE_D_D0", {});
  assert.equal(calls[2].legs[0].path.coordinates.length, 10);
  data[0].line = data[0].line.replace("29.009 41", "29.009 41.00001");
  await service.calculateIettRouteTimes("CACHE_D_D0", {});
  assert.equal(calls[3].legs[0].path.coordinates.length, 10);
  service.clearCaches();
  await service.calculateIettRouteTimes("CACHE_D_D0", {});
  assert.equal(calls[4].legs[0].path.coordinates.length, 10);
  await service.calculateIettRouteTimes("OTHER_D_D0", {});
  await service.calculateIettRouteTimes("CACHE_D_D0", {});
  assert.equal(calls[6].legs[0].path.coordinates.length, 10);
});

test("rejects a genuinely ambiguous repeated stop sequence", () => {
  const outbound = Array.from({ length: 11 }, (_, index) => `${29 + index * 0.001} 41`);
  const returnTrip = Array.from({ length: 11 }, (_, index) => `${29.01 - index * 0.001} 41.005`);
  const repeated = Array.from({ length: 11 }, (_, index) => `${29 + index * 0.001} 41`);
  const geometry = buildRouteGeometry(
    `LINESTRING (${[...outbound, ...returnTrip, ...repeated].join(", ")})`
  );
  const stops = [2, 5, 8].map(index => ({
    stationName: `STOP ${index}`,
    lat: 41,
    lng: 29 + index * 0.001
  }));

  assert.throws(
    () => matchStopsToRoute(stops, geometry),
    error => error.status === 502 && error.code === "IETT_AMBIGUOUS_STOP_MATCH"
  );

  const orderedStops = [2, 5, 8].map(index => ({
    stationName: `OUTBOUND ${index}`,
    lat: 41,
    lng: 29 + index * 0.001
  }));

  orderedStops.push({
    stationName: "RETURN",
    lat: 41.005,
    lng: 29.005
  });

  const matched = matchStopsToRoute(orderedStops, geometry);

  assert.ok(matched.every((stop, index) => {
    return index === 0 || stop.distanceAlongRoute > matched[index - 1].distanceAlongRoute;
  }));
});
