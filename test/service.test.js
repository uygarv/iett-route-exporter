import assert from "node:assert/strict";
import test from "node:test";
import { IettClient } from "../src/clients/iett-client.js";
import {
  createIettService,
  isValidRoutePinResponse,
  parseRouteCode
} from "../src/services/iett-service.js";

const line = "LINESTRING (29 41, 29.01 41, 29.01 41.01, 29.02 41.01)";

function routeData(start = "START", end = "END") {
  return [{
    line,
    stationPlaces: [
      { stationName: start, lat: "41", lng: "29" },
      { stationName: end, lat: "41.01", lng: "29.02" }
    ]
  }];
}

test("parses route codes without limiting direction identifiers", () => {
  assert.deepEqual(parseRouteCode("256_OUTBOUND_SPECIAL_2"), {
    line: "256",
    direction: "OUTBOUND",
    variant: "SPECIAL_2"
  });
});

test("validates the minimum route-pin response shape", () => {
  assert.equal(isValidRoutePinResponse(routeData()), true);
  assert.equal(isValidRoutePinResponse([]), false);
  assert.equal(isValidRoutePinResponse([{ line: "", stationPlaces: [{}, {}] }]), false);
  assert.equal(isValidRoutePinResponse([{ line, stationPlaces: [{}] }]), false);
});

test("merges base and extra routes and groups them by actual endpoints", async () => {
  const client = {
    async getAllRoutes() {
      return [
        { GUZERGAH_GUZERGAH_KODU: "256_G_D1", GUZERGAH_ADI: "Gece" },
        { GUZERGAH_GUZERGAH_KODU: "256_G_D0", GUZERGAH_ADI: "IETT normal adı" },
        { GUZERGAH_GUZERGAH_KODU: "256_G_D0", GUZERGAH_ADI: "Duplicate" },
        { GUZERGAH_GUZERGAH_KODU: "256_D_D0", GUZERGAH_ADI: "Dönüş" },
        { GUZERGAH_GUZERGAH_KODU: "SPECIAL-OUTBOUND", GUZERGAH_ADI: "Özel sefer" },
        { GUZERGAH_ADI: "Missing code" },
        { GUZERGAH_GUZERGAH_KODU: "256_D_D1" }
      ];
    },
    async getRoutePin(code) {
      if (code === "256_D_D1") {
        throw new Error("fixture failure");
      }

      return code.startsWith("256_D_")
        ? routeData("END", "START")
        : routeData();
    }
  };
  const service = createIettService({ client });
  const result = await service.getIettRouteOptions("256");

  assert.equal(result.directions.length, 2);
  assert.equal(result.directions[0].label, "START - END");
  assert.equal(result.directions[0].id, "START__END");
  assert.equal(result.directions[0].variants.length, 3);
  assert.deepEqual(result.directions[0].variants.map(variant => variant.code), [
    "256_G_D0",
    "256_G_D1",
    "SPECIAL-OUTBOUND"
  ]);
  assert.equal(result.directions[0].variants[0].type, "base");
  assert.equal(result.directions[0].variants[0].name, "IETT normal adı");
  assert.equal(result.directions[0].variants[0].rawName, "IETT normal adı");
  assert.equal(result.directions[0].variants[1].name, "Gece");
  assert.equal(result.directions[0].variants[2].name, "Özel sefer");
  assert.equal(result.directions[1].label, "END - START");
  assert.equal(result.directions[1].variants[0].type, "base");
  assert.equal(result.directions[1].variants[0].name, "Dönüş");
  assert.equal(result.warnings.length, 2);
});

test("returns validated base directions when GetAllRoute is empty", async () => {
  const calls = [];
  const service = createIettService({
    client: {
      async getRoutePin(code) {
        calls.push(code);

        return code === "256_D_D0"
          ? routeData("END", "START")
          : routeData();
      },
      async getAllRoutes() {
        calls.push("GetAllRoute");
        return [];
      }
    }
  });
  const result = await service.getIettRouteOptions("256");

  assert.deepEqual(calls, ["256_G_D0", "256_D_D0", "GetAllRoute"]);
  assert.equal(result.directions.length, 2);
  assert.deepEqual(result.directions.flatMap(direction => {
    return direction.variants.map(variant => variant.code);
  }), ["256_G_D0", "256_D_D0"]);
  assert.ok(result.directions.every(direction => {
    return direction.variants[0].name === "Normal Düzergah";
  }));
});

test("labels repeated stop names and accepts the numbered internal label", async () => {
  const repeatedStops = [
    { stationName: "START", lat: "41", lng: "29" },
    { stationName: "UZUNÇAYIR METROBÜS", lat: "41", lng: "29.005" },
    { stationName: "MIDDLE", lat: "41", lng: "29.01" },
    { stationName: "UZUNÇAYIR METROBÜS", lat: "41.005", lng: "29.01" },
    { stationName: "END", lat: "41.01", lng: "29.02" }
  ];
  const client = {
    async getRoutePin() {
      return [{ line, stationPlaces: repeatedStops }];
    },
    async getAllRoutes() {
      return [];
    }
  };
  const service = createIettService({ client });
  const options = await service.getIettRouteOptions("256");
  const stops = options.directions[0].variants[0].stops;

  assert.equal(stops[1].stationIndex, 1);
  assert.equal(stops[1].name, "UZUNÇAYIR METROBÜS (1)");
  assert.equal(stops[3].name, "UZUNÇAYIR METROBÜS (2)");
  assert.equal("displayName" in stops[1], false);

  const route = await service.buildIettGoogleMapsRoute("256_G_D0", {
    startStation: "uzuncayir metrobus (2)"
  });

  assert.deepEqual(route.startStation, {
    name: "UZUNÇAYIR METROBÜS (2)",
    index: 3
  });

  await assert.rejects(
    service.buildIettGoogleMapsRoute("256_G_D0", {
      startStation: "UZUNÇAYIR METROBÜS"
    }),
    error => {
      return error.code === "AMBIGUOUS_START_STATION"
        && error.details.candidates[0].name === "UZUNÇAYIR METROBÜS (1)"
        && error.details.candidates[1].name === "UZUNÇAYIR METROBÜS (2)";
    }
  );
});

test("keeps a valid base direction when the opposite base route is unavailable", async () => {
  const service = createIettService({
    client: {
      async getRoutePin(code) {
        return code === "256_G_D0" ? routeData() : [];
      },
      async getAllRoutes() {
        return [];
      }
    }
  });
  const result = await service.getIettRouteOptions("256");

  assert.equal(result.directions.length, 1);
  assert.equal(result.directions[0].variants[0].code, "256_G_D0");
  assert.equal(result.warnings[0].code, "INVALID_BASE_ROUTE");
});

test("builds an encoded URL and falls back from invalid stop coordinates", async () => {
  const service = createIettService({
    client: {
      async getRoutePin() {
        return [{
          line,
          stationPlaces: [
            { stationName: "START", lat: "bad", lng: "29" },
            { stationName: "END", lat: "41.01", lng: "29.02" }
          ]
        }];
      }
    }
  });
  const result = await service.buildIettGoogleMapsRoute("256_G_D0", {
    maxWaypoints: 5,
    debug: true
  });
  const url = new URL(result.url);

  assert.deepEqual(result.origin, { lat: 41, lng: 29 });
  assert.equal(url.searchParams.get("api"), "1");
  assert.equal(url.searchParams.get("travelmode"), "driving");
  assert.ok(result.waypoints.length <= 5);
  assert.ok(result.debug.candidates.length > 0);
});

test("uses a bus stop itself when it can preserve an important turn", async () => {
  const service = createIettService({
    client: {
      async getRoutePin() {
        return [{
          line,
          stationPlaces: [
            { stationName: "START", lat: "41", lng: "29" },
            { stationName: "FIRST STOP", lat: "41", lng: "29.005" },
            { stationName: "CORNER STOP", lat: "41", lng: "29.01" },
            { stationName: "SECOND STOP", lat: "41.005", lng: "29.01" },
            { stationName: "END", lat: "41.01", lng: "29.02" }
          ]
        }];
      }
    }
  });
  const result = await service.buildIettGoogleMapsRoute("256_G_D0", {
    maxWaypoints: 2
  });

  assert.equal(result.stationCount, 5);
  assert.ok(result.stationWaypointCount >= 1);
  assert.ok(result.turnPreservingStationCount >= 1);
  assert.ok(result.waypoints.some(waypoint => {
    return waypoint.reason === "station" && waypoint.roles.includes("post-turn");
  }));
});

test("keeps distant stops as priorities and projects them onto the IETT line", async () => {
  const straightLine = "LINESTRING (29 41, 29.02 41)";
  const stationPlaces = [
    { stationName: "START", lat: 41, lng: 29 },
    { stationName: "DISTANT STOP", lat: 41.003, lng: 29.01 },
    { stationName: "END", lat: 41, lng: 29.02 }
  ];
  const service = createIettService({
    client: {
      async getRoutePin() {
        return [{ line: straightLine, stationPlaces }];
      }
    }
  });
  const result = await service.buildIettGoogleMapsRoute("256_G_D0", {
    maxWaypoints: 1
  });

  assert.equal(result.stationWaypointCount, 1);
  assert.equal(result.waypoints[0].reason, "station");
  assert.equal(result.waypoints[0].stationName, "DISTANT STOP");
  assert.equal(result.waypoints[0].projectedToRoute, true);
  assert.ok(result.waypoints[0].distanceToRoute > 300);
  assert.ok(Math.abs(result.waypoints[0].lat - 41) < 1e-9);
  assert.ok(Math.abs(result.waypoints[0].lng - 29.01) < 1e-9);

  const fromDistantStop = await service.buildIettGoogleMapsRoute("256_G_D0", {
    startStation: "DISTANT STOP",
    maxWaypoints: 0
  });

  assert.equal(fromDistantStop.originSource, "station");
  assert.ok(Math.abs(fromDistantStop.origin.lat - 41) < 1e-9);
  assert.ok(Math.abs(fromDistantStop.origin.lng - 29.01) < 1e-9);
});

test("uses an Apple Maps slot for a turn when it improves fidelity over a stop", async () => {
  const stationPlaces = Array.from({ length: 15 }, (_, index) => {
    if (index <= 4) {
      return {
        stationName: `STOP ${index}`,
        lat: "41",
        lng: String(29 + 0.002 * index)
      };
    }

    if (index <= 9) {
      return {
        stationName: `STOP ${index}`,
        lat: String(41 + 0.002 * (index - 4)),
        lng: "29.01"
      };
    }

    return {
      stationName: `STOP ${index}`,
      lat: "41.01",
      lng: String(29.01 + 0.002 * (index - 9))
    };
  });
  const service = createIettService({
    client: {
      async getRoutePin() {
        return [{ line, stationPlaces }];
      }
    }
  });
  const result = await service.buildIettAppleMapsRoute("256_G_D0");
  const url = new URL(result.url);

  assert.equal(result.provider, "apple-maps");
  assert.equal(result.waypoints.length, 13);
  assert.equal(result.stationWaypointCount, 12);
  assert.equal(result.additionalTurnWaypointCount, 1);
  assert.ok(result.waypoints.some(waypoint => waypoint.reason === "post-turn"));
  assert.equal(url.origin, "https://maps.apple.com");
  assert.equal(url.pathname, "/directions");
  assert.equal(url.searchParams.get("mode"), "driving");
  assert.equal(url.searchParams.getAll("waypoint").length, 13);
});

test("builds Yandex Maps URLs with up to eighteen ordered waypoints", async () => {
  const stationPlaces = Array.from({ length: 20 }, (_, index) => {
    if (index <= 6) {
      return {
        stationName: `STOP ${index}`,
        lat: "41",
        lng: String(29 + 0.01 * index / 6)
      };
    }

    if (index <= 12) {
      return {
        stationName: `STOP ${index}`,
        lat: String(41 + 0.01 * (index - 6) / 6),
        lng: "29.01"
      };
    }

    return {
      stationName: `STOP ${index}`,
      lat: "41.01",
      lng: String(29.01 + 0.01 * (index - 12) / 7)
    };
  });
  const service = createIettService({
    client: {
      async getRoutePin() {
        return [{ line, stationPlaces }];
      }
    }
  });
  const result = await service.buildIettYandexMapsRoute("256_G_D0");
  const url = new URL(result.url);
  const routePoints = url.searchParams.get("rtext").split("~");

  assert.equal(result.provider, "yandex-maps");
  assert.equal(result.waypoints.length, 18);
  assert.equal(url.origin, "https://yandex.com");
  assert.equal(url.pathname, "/maps/");
  assert.equal(url.searchParams.get("mode"), "routes");
  assert.equal(url.searchParams.get("rtt"), "auto");
  assert.equal(routePoints.length, 20);
  assert.equal(routePoints[0], `${result.origin.lat},${result.origin.lng}`);
  assert.equal(routePoints.at(-1), `${result.destination.lat},${result.destination.lng}`);
});

test("preserves IETT geometry when a Yandex route has more stops than its budget", async () => {
  const crowdedLine = "LINESTRING (29 41, 29.01 41, 29.01 41.01, 29.02 41.01)";
  const stationPlaces = [
    { stationName: "START", lat: 41, lng: 29 },
    ...Array.from({ length: 10 }, (_, index) => ({
      stationName: `LOWER ${index}`,
      lat: 41,
      lng: 29 + 0.0008 * (index + 1)
    })),
    ...Array.from({ length: 10 }, (_, index) => ({
      stationName: `UPPER ${index}`,
      lat: 41.01,
      lng: 29.012 + 0.0007 * index
    })),
    { stationName: "END", lat: 41.01, lng: 29.02 }
  ];
  const service = createIettService({
    client: {
      async getRoutePin() {
        return [{ line: crowdedLine, stationPlaces }];
      }
    }
  });
  const result = await service.buildIettYandexMapsRoute("CROWDED", { debug: true });

  assert.equal(stationPlaces.length, 22);
  assert.equal(result.waypoints.length, 18);
  assert.ok(result.stationWaypointCount < 18);
  assert.ok(result.additionalTurnWaypointCount > 0);
  assert.ok(result.waypoints.some(waypoint => waypoint.reason === "coverage"));
  assert.ok(result.debug.controlPath.maxDeviationMeters < 100);
});

test("starts at a named station and removes earlier route controls", async () => {
  const service = createIettService({
    client: {
      async getRoutePin() {
        return [{
          line,
          stationPlaces: [
            { stationName: "START", lat: "41", lng: "29" },
            { stationName: "KÖPRÜLÜ KAVŞAK", lat: "41", lng: "29.01" },
            { stationName: "LATER STOP", lat: "41.005", lng: "29.01" },
            { stationName: "END", lat: "41.01", lng: "29.02" }
          ]
        }];
      }
    }
  });
  const result = await service.buildIettAppleMapsRoute("256_G_D0", {
    startStation: "koprulu kavsak"
  });

  assert.equal(result.originSource, "station");
  assert.deepEqual(result.origin, { lat: 41, lng: 29.01 });
  assert.deepEqual(result.startStation, {
    name: "KÖPRÜLÜ KAVŞAK",
    index: 1
  });
  assert.ok(result.startDistanceAlongRoute > 800);
  assert.ok(result.waypoints.every(waypoint => {
    return waypoint.distanceAlongRoute > result.startDistanceAlongRoute;
  }));
  assert.equal(new URL(result.url).searchParams.get("source"), "41,29.01");
});

test("ends at a named station and removes later route controls", async () => {
  const service = createIettService({
    client: {
      async getRoutePin() {
        return [{
          line,
          stationPlaces: [
            { stationName: "START", lat: "41", lng: "29" },
            { stationName: "FIRST STOP", lat: "41", lng: "29.005" },
            { stationName: "KÖPRÜLÜ KAVŞAK", lat: "41", lng: "29.01" },
            { stationName: "LATER STOP", lat: "41.005", lng: "29.01" },
            { stationName: "END", lat: "41.01", lng: "29.02" }
          ]
        }];
      }
    }
  });
  const result = await service.buildIettGoogleMapsRoute("256_G_D0", {
    endStation: "koprulu kavsak"
  });

  assert.equal(result.originSource, "route-start");
  assert.equal(result.destinationSource, "station");
  assert.deepEqual(result.destination, { lat: 41, lng: 29.01 });
  assert.deepEqual(result.endStation, {
    name: "KÖPRÜLÜ KAVŞAK",
    index: 2
  });
  assert.ok(result.endDistanceAlongRoute < result.routeLengthMeters);
  assert.ok(result.waypoints.every(waypoint => {
    return waypoint.distanceAlongRoute < result.endDistanceAlongRoute;
  }));
  assert.equal(
    new URL(result.url).searchParams.get("destination"),
    "41,29.01"
  );
});

test("builds only the section between named start and end stations", async () => {
  const service = createIettService({
    client: {
      async getRoutePin() {
        return [{
          line,
          stationPlaces: [
            { stationName: "START", lat: "41", lng: "29" },
            { stationName: "FIRST STOP", lat: "41", lng: "29.005" },
            { stationName: "CORNER STOP", lat: "41", lng: "29.01" },
            { stationName: "LATER STOP", lat: "41.005", lng: "29.01" },
            { stationName: "END", lat: "41.01", lng: "29.02" }
          ]
        }];
      }
    }
  });
  const result = await service.buildIettAppleMapsRoute("256_G_D0", {
    startStation: "FIRST STOP",
    endStation: "LATER STOP"
  });

  assert.deepEqual(result.origin, { lat: 41, lng: 29.005 });
  assert.deepEqual(result.destination, { lat: 41.005, lng: 29.01 });
  assert.ok(result.startDistanceAlongRoute < result.endDistanceAlongRoute);
  assert.equal(
    result.remainingRouteLengthMeters,
    result.endDistanceAlongRoute - result.startDistanceAlongRoute
  );
  assert.ok(result.waypoints.every(waypoint => {
    return waypoint.distanceAlongRoute > result.startDistanceAlongRoute
      && waypoint.distanceAlongRoute < result.endDistanceAlongRoute;
  }));
});

test("rejects missing and conflicting start-station options", async () => {
  const service = createIettService({
    client: {
      async getRoutePin() {
        return routeData();
      }
    }
  });

  await assert.rejects(
    service.buildIettGoogleMapsRoute("256_G_D0", {
      startStation: "UNKNOWN STOP"
    }),
    error => error.code === "START_STATION_NOT_FOUND"
  );

  await assert.rejects(
    service.buildIettGoogleMapsRoute("256_G_D0", {
      startStation: "START",
      currentLocation: { lat: 41, lng: 29 }
    }),
    error => error.code === "CONFLICTING_START_OPTIONS"
  );

  await assert.rejects(
    service.buildIettGoogleMapsRoute("256_G_D0", {
      endStation: "UNKNOWN STOP"
    }),
    error => error.code === "END_STATION_NOT_FOUND"
  );

  await assert.rejects(
    service.buildIettGoogleMapsRoute("256_G_D0", {
      startStation: "END",
      endStation: "START"
    }),
    error => error.code === "INVALID_STATION_RANGE"
  );
});

test("trims at a current location and rejects locations far from the route", async () => {
  const service = createIettService({
    client: {
      async getRoutePin() {
        return routeData();
      }
    }
  });
  const currentLocation = { lat: 41.0001, lng: 29.008 };
  const result = await service.buildIettGoogleMapsRoute("256_G_D0", {
    currentLocation
  });

  assert.deepEqual(result.origin, currentLocation);
  assert.equal(result.originSource, "current-location");
  assert.ok(result.startDistanceAlongRoute > 500);
  assert.ok(result.remainingRouteLengthMeters < result.routeLengthMeters);
  assert.ok(result.waypoints.every(point => {
    return point.distanceAlongRoute > result.startDistanceAlongRoute;
  }));

  await assert.rejects(
    service.buildIettGoogleMapsRoute("256_G_D0", {
      currentLocation: { lat: 40, lng: 29 }
    }),
    error => error.code === "CURRENT_LOCATION_OFF_ROUTE"
  );
});

test("shares pending and completed IETT requests and evicts failures", async () => {
  let calls = 0;
  let fail = false;
  const fetchImpl = async () => {
    calls += 1;

    if (fail) {
      throw new Error("network");
    }

    return new Response("[]", {
      status: 200,
      headers: { "content-type": "application/json" }
    });
  };
  const client = new IettClient({ fetchImpl });

  await Promise.all([client.getRoutePin("A"), client.getRoutePin("A")]);
  await client.getRoutePin("A");
  assert.equal(calls, 1);

  fail = true;
  await assert.rejects(client.getRoutePin("B"));
  await assert.rejects(client.getRoutePin("B"));
  assert.equal(calls, 3);
});

test("rejects malformed route responses and invalid build options", async () => {
  const service = createIettService({
    client: {
      async getRoutePin() {
        return { bad: true };
      }
    }
  });

  await assert.rejects(
    service.buildIettGoogleMapsRoute("256_G_D0"),
    error => error.code === "IETT_MALFORMED_RESPONSE"
  );

  await assert.rejects(
    service.buildIettGoogleMapsRoute("256_G_D0", { maxWaypoints: 10 }),
    error => error.code === "INVALID_MAX_WAYPOINTS"
  );

  await assert.rejects(
    service.buildIettAppleMapsRoute("256_G_D0", { maxWaypoints: 14 }),
    error => error.code === "INVALID_MAX_WAYPOINTS"
  );

  await assert.rejects(
    service.buildIettYandexMapsRoute("256_G_D0", { maxWaypoints: 19 }),
    error => error.code === "INVALID_MAX_WAYPOINTS"
  );
});
