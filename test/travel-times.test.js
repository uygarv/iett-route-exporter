import assert from "node:assert/strict";
import test from "node:test";
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
    const legs = payload.legs.map((requestLeg, index) => {
      const departureDateTime = new Date(timestamp).toISOString();
      const drivingDuration = 80 + index % 3;
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
        path,
        summary: {
          lengthInMeters: Math.round(pathLength(path)),
          travelDurationInSeconds: drivingDuration,
          trafficDelayDurationInSeconds: 10,
          departureDateTime,
          arrivalDateTime
        }
      };
    });

    return { routes: [{ legs }] };
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
  assert.equal(result.trafficMode, "live");
  assert.equal(result.segments.length, 46);
  assert.equal(result.origin.name, "STOP 0");
  assert.equal(result.destination.name, "STOP 46");
  assert.equal(result.total.drivingDurationSeconds, 3725);
  assert.equal(result.total.dwellDurationSeconds, 900);
  assert.equal(result.total.estimatedDurationSeconds, 4625);
  assert.equal(result.total.trafficDelaySeconds, 460);
  assert.equal(result.total.freeFlowDurationSeconds, 3265);
  assert.equal(result.total.distanceMeters, 3864);
  assert.equal(result.segments.at(-1).dwellAfterArrivalSeconds, 0);
  assert.equal(result.debug.matchedStops.length, 47);

  const request = tomTomClient.calls[0];
  assert.equal(request.traffic, "live");
  assert.equal(request.routeType, "fast");
  assert.equal(request.travelMode, "car");
  assert.equal(request.departureDateTime, "now");
  assert.equal(request.routePlanningLocations.waypoints.coordinates.length, 45);
  assert.deepEqual(request.routePlanningLocations.waypoints.coordinates[0], [29.001, 41]);
  assert.deepEqual(request.routePlanningLocations.waypoints.coordinates.at(-1), [29.045, 41]);
  assert.equal(request.path, undefined);
  assert.equal(request.legs.length, 46);
  assert.equal(request.legs[0].path.type, "LineString");
  assert.deepEqual(request.legs[0].path.coordinates, [
    [29, 41],
    [29.001, 41]
  ]);
  assert.deepEqual(request.legs.at(-1).path.coordinates, [
    [29.045, 41],
    [29.046, 41]
  ]);
  assert.equal(request.legs[0].routeStop.pauseDurationInSeconds, 20);
  assert.equal(request.legs.at(-1).routeStop, undefined);
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

  assert.ok(tomTomClient.calls[0].routePlanningLocations.waypoints.coordinates.some(point => {
    return point[0] === 29.02 && point[1] === 41;
  }));
  assert.ok(result.debug.routingAnchorCount > 0);
  assert.equal(result.debug.matchedStops[1].projectedToRoute, true);
  assert.ok(result.debug.matchedStops[1].distanceToRoute > 300);
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

test("splits routes above 150 intermediate waypoints and carries boundary dwell", async () => {
  const { service, tomTomClient } = createService(154);
  const result = await service.calculateIettRouteTimes("LONG_G_D0", {
    departureTime: "2026-10-04T09:00:00Z",
    dwellTimeSeconds: 30
  });

  assert.equal(tomTomClient.calls.length, 2);
  assert.equal(tomTomClient.calls[0].routePlanningLocations.waypoints.coordinates.length, 150);
  assert.equal(tomTomClient.calls[1].routePlanningLocations.waypoints.coordinates.length, 1);
  assert.equal(result.segments.length, 153);
  assert.equal(result.total.dwellDurationSeconds, 152 * 30);

  const firstChunkLastLeg = tomTomClient.calls[0].legs.at(-1);
  assert.equal(firstChunkLastLeg.path.type, "LineString");
  assert.equal(firstChunkLastLeg.routeStop, undefined);

  const firstChunkLastSegment = result.segments[150];
  const expectedSecondDeparture = new Date(
    Date.parse(firstChunkLastSegment.arrivalTime) + 30_000
  ).toISOString();

  assert.equal(tomTomClient.calls[1].departureDateTime, expectedSecondDeparture);
  assert.equal(result.segments[151].departureTime, expectedSecondDeparture);
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
  );
});

test("retries a deviating reconstruction with a small lane offset", async () => {
  const tomTomClient = new MockTomTomClient({
    deviatingLeg: 2,
    deviateOnlyOnFirstCall: true
  });
  const { service } = createService(10, tomTomClient);
  const result = await service.calculateIettRouteTimes("256_D_D0", { debug: true });

  assert.equal(tomTomClient.calls.length, 3);
  assert.equal(result.debug.upstreamRequestCount, 3);
  assert.equal(result.debug.reconstructionRepairs.length, 1);
  assert.equal(result.debug.reconstructionRepairs[0].laneOffsetMeters, 4);
});

test("estimates a short IETT-only turn instead of accepting a long TomTom detour", async () => {
  const tomTomClient = new MockTomTomClient({
    deviatingLeg: 1,
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
    debug: true,
    dwellTimeSeconds: 0
  });

  assert.equal(result.routingQuality, "validated-with-iett-maneuver-estimate");
  assert.equal(result.warnings[0].code, "UNMAPPED_IETT_MANEUVER_ESTIMATED");
  assert.equal(result.segments[1].estimatedManeuverDurationSeconds, 8);
  assert.equal(result.total.estimatedManeuverDurationSeconds, 8);
  assert.equal(result.debug.estimatedManeuvers.length, 1);
  assert.ok(result.debug.estimatedManeuvers[0].turnAngle > 60);
  assert.equal(tomTomClient.calls.length, 2);
});

test("keeps a strongly turning IETT section when TomTom repeatedly shortcuts it", async () => {
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
    debug: true,
    dwellTimeSeconds: 0
  });

  assert.equal(result.routingQuality, "validated-with-iett-maneuver-estimate");
  assert.equal(result.debug.estimatedManeuvers.length, 1);
  assert.ok(result.debug.estimatedManeuvers[0].length > 700);
  assert.ok(result.debug.estimatedManeuvers[0].turnAngle > 135);
  assert.ok(result.segments[1].estimatedManeuverDurationSeconds > 0);
  assert.equal(tomTomClient.calls.length, 9);
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
