import assert from "node:assert/strict";
import test from "node:test";
import { createApp } from "../src/app.js";
import { AppError } from "../src/shared/errors.js";
import { createJourneyService } from "../src/services/journey-service.js";

async function withServer(service, run, journeyService) {
  const app = createApp({ service, journeyService });
  const server = app.listen(0, "127.0.0.1");

  await new Promise(resolve => server.once("listening", resolve));

  try {
    const address = server.address();
    await run(`http://127.0.0.1:${address.port}`);
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
}

test("serves health, discovery, and route-building endpoints", async () => {
  const service = {
    async getIettRouteOptions(lineCode) {
      return { line: lineCode, directions: [], warnings: [] };
    },
    async buildIettGoogleMapsRoute(routeCode, options) {
      return { routeCode, received: options, url: "https://www.google.com/maps/dir/" };
    },
    async buildIettAppleMapsRoute(routeCode, options) {
      return { routeCode, received: options, url: "https://maps.apple.com/directions" };
    },
    async buildIettYandexMapsRoute(routeCode, options) {
      return { routeCode, received: options, url: "https://yandex.com/maps/" };
    },
    async calculateIettRouteTimes(routeCode, options) {
      return {
        routeCode,
        received: options,
        provider: "tomtom-orbis",
        segments: []
      };
    },
    async buildIettGpx(routeCode, options) {
      return {
        routeCode,
        received: options,
        filename: `${routeCode}.gpx`,
        contentType: "application/gpx+xml; charset=utf-8",
        gpx: "<gpx />"
      };
    }
  };

  await withServer(service, async baseUrl => {
    const health = await fetch(`${baseUrl}/health`).then(response => response.json());
    assert.deepEqual(health, { status: "ok" });

    const options = await fetch(`${baseUrl}/api/iett/lines/256`).then(response => {
      return response.json();
    });
    assert.equal(options.line, "256");

    const route = await fetch(`${baseUrl}/api/iett/routes/256_G_D0/google-maps`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ maxWaypoints: 4 })
    }).then(response => response.json());
    assert.equal(route.routeCode, "256_G_D0");
    assert.equal(route.received.maxWaypoints, 4);

    const appleRoute = await fetch(`${baseUrl}/api/iett/routes/256_G_D0/apple-maps`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ maxWaypoints: 13 })
    }).then(response => response.json());
    assert.equal(appleRoute.routeCode, "256_G_D0");
    assert.equal(appleRoute.received.maxWaypoints, 13);

    const yandexRoute = await fetch(`${baseUrl}/api/iett/routes/256_G_D0/yandex-maps`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ maxWaypoints: 18 })
    }).then(response => response.json());
    assert.equal(yandexRoute.routeCode, "256_G_D0");
    assert.equal(yandexRoute.received.maxWaypoints, 18);

    const travelTimes = await fetch(`${baseUrl}/api/iett/routes/256_G_D0/travel-times`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ dwellTimeSeconds: 30 })
    }).then(response => response.json());
    assert.equal(travelTimes.routeCode, "256_G_D0");
    assert.equal(travelTimes.provider, "tomtom-orbis");
    assert.equal(travelTimes.received.dwellTimeSeconds, 30);

    const gpxResponse = await fetch(
      `${baseUrl}/api/iett/routes/256_G_D0/gpx?startStation=START`
    );

    assert.equal(gpxResponse.status, 200);
    assert.match(gpxResponse.headers.get("content-type"), /application\/gpx\+xml/);
    assert.equal(
      gpxResponse.headers.get("content-disposition"),
      'attachment; filename="256_G_D0.gpx"'
    );
    assert.equal(await gpxResponse.text(), "<gpx />");
  });
});

test("evaluates journeys through the separate endpoint using direct calls to the shared IETT service", async () => {
  const calls = [];
  const service = {
    async calculateIettRouteTimes(route, options) {
      calls.push({ route, options });
      return { routeCode: route, total: { estimatedDurationSeconds: 1800 }, provider: "tomtom-orbis",
        routingQuality: "tomtom-geometry-approximate", geometryMatch: { valid: true, quality: "approximate" },
        warnings: [{ code: "IETT_GEOMETRY_APPROXIMATION" }] };
    }
  };
  const journeyService = createJourneyService({
    calculateBusTimes: service.calculateIettRouteTimes,
    clock: () => Date.parse("2026-10-19T06:00:00+03:00")
  });
  await withServer(service, async baseUrl => {
    const response = await fetch(`${baseUrl}/api/journeys/evaluate`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ date: "2026-10-19", arrivalTime: "09:00", routes: {
        "MBUS-19": {
          "1": { type: "WALK", duration: 15 }, "2": { type: "MBUS", duration: 13 },
          "3": { type: "BUS", route: "19_D_D0", line: "19", startStation: "START", endStation: "END", departures: ["08.05", "09.20"] }
        }
      } })
    });
    const result = await response.json();
    assert.equal(response.status, 200);
    assert.equal(result.options.find(option => option.id === result.recommendedOptionId).departure, "07:37");
    assert.equal(result.options[0].route, "Metrobus + Bus 19");
    assert.equal(result.options[0].steps[2].transport, "Bus 19");
    assert.equal(Object.hasOwn(result.options[0].steps[2], "geometryMatch"), false);
    assert.match(result.options[0].notes[0], /road route close to the bus route/);
    assert.equal(result.options.length, 2);
    assert.equal(calls.length, 2);
    assert.deepEqual(calls[0], { route: "19_D_D0", options: {
      startStation: "START", endStation: "END", departureTime: "2026-10-19T08:05:00.000+03:00"
    } });
    const oldResponse = await fetch(`${baseUrl}/api/iett/routes/19_D_D0/travel-times`, {
      method: "POST", headers: { "content-type": "application/json" }, body: "{}"
    });
    assert.equal(oldResponse.status, 200);
    assert.equal(calls.length, 3);
  }, journeyService);
});

test("journey endpoint maps invalid requests to 400 and returns 200 when no option can be recommended", async () => {
  const service = { calculateIettRouteTimes: async () => ({ total: { estimatedDurationSeconds: 1800 } }) };
  const journeyService = createJourneyService({
    calculateBusTimes: service.calculateIettRouteTimes,
    clock: () => Date.parse("2026-10-19T10:00:00+03:00")
  });
  await withServer(service, async baseUrl => {
    for (const body of ["{}", "{invalid"]) {
      const invalid = await fetch(`${baseUrl}/api/journeys/evaluate`, {
        method: "POST", headers: { "content-type": "application/json" }, body
      });
      assert.equal(invalid.status, 400);
    }
    const response = await fetch(`${baseUrl}/api/journeys/evaluate`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ arrivalTime: "09:00", routes: { walk: { "1": { type: "WALK", duration: 15 } } } })
    });
    const result = await response.json();
    assert.equal(response.status, 200);
    assert.equal(result.recommendedOptionId, null);
    assert.equal(result.options[0].status, "Required departure time has passed");
  }, journeyService);
});

test("evaluate recommends the highest score within the arrival deadline", async () => {
  const calls = [];
  const service = { calculateIettRouteTimes: async (route, options) => {
    calls.push(options.departureTime);
    return { total: { estimatedDurationSeconds: {
      "08:15": 2400, "08:25": 900, "08:35": 1200
    }[options.departureTime.slice(11, 16)] } };
  } };
  const journeyService = createJourneyService({
    calculateBusTimes: service.calculateIettRouteTimes,
    clock: () => Date.parse("2026-10-19T06:00:00+03:00")
  });
  await withServer(service, async baseUrl => {
    const response = await fetch(`${baseUrl}/api/journeys/evaluate`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ departureTime: "2026-10-20T08:00:00+03:00", arrivalTime: "09:00", routes: {
        bus: { "1": { type: "BUS", route: "19_D_D0", startStation: "START", endStation: "END",
          departures: ["08:15", "08:25", "08:35"] } }
      } })
    });
    const result = await response.json();
    assert.equal(response.status, 200);
    assert.equal(result.options.find(option => option.id === result.recommendedOptionId).departure, "08:35");
    assert.equal(result.options.find(option => option.id === result.recommendedOptionId).arrival, "08:55");
    assert.equal(result.options.length, 3);
    assert.equal(result.options[0].id, result.recommendedOptionId);
    assert.equal(calls.length, 3);
    assert.equal(Object.hasOwn(result, "scoring"), false);
    assert.equal(Object.hasOwn(result.options[0], "rank"), false);
    const durationOnlyResponse = await fetch(`${baseUrl}/api/journeys/evaluate`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ departureTime: "2026-10-20T08:00:00+03:00", arrivalTime: "09:00",
        scoring: { weights: { lateDeparture: 0, duration: 1, transfers: 0 } }, routes: {
          bus: { "1": { type: "BUS", route: "19_D_D0", startStation: "START", endStation: "END",
            departures: ["08:15", "08:25", "08:35"] } }
        } })
    });
    assert.equal(durationOnlyResponse.status, 200);
    const durationOnly = await durationOnlyResponse.json();
    assert.equal(durationOnly.options[0].departure, "08:25");
    assert.equal(durationOnly.options[0].durationMinutes, 15);
    assert.equal(Object.hasOwn(durationOnly.options[0], "score"), false);
    assert.equal(calls.length, 6);
    const invalidResponse = await fetch(`${baseUrl}/api/journeys/evaluate`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ arrivalTime: "09:00", scoring: { weights: { typo: 1 } },
        routes: { bus: { "1": { type: "BUS", route: "19_D_D0", startStation: "START", endStation: "END", departure: "08:00" } } } })
    });
    assert.equal(invalidResponse.status, 400);
    assert.equal((await invalidResponse.json()).error.code, "INVALID_SCORING");
    assert.equal(calls.length, 6);
  }, journeyService);
});

test("journey endpoint accepts departure-only and combined date-time boundaries for tomorrow", async () => {
  const calls = [];
  const service = { calculateIettRouteTimes: async (route, options) => {
    calls.push(options);
    return { total: { estimatedDurationSeconds: 1800 } };
  } };
  const journeyService = createJourneyService({
    calculateBusTimes: service.calculateIettRouteTimes,
    clock: () => Date.parse("2026-10-19T06:00:00+03:00")
  });
  await withServer(service, async baseUrl => {
    for (const arrivalTime of [undefined, "2026-10-20T09:00:00+03:00"]) {
      const response = await fetch(`${baseUrl}/api/journeys/evaluate`, {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ departureTime: "2026-10-20T07:00:00+03:00", arrivalTime,
          routes: { bus: { "1": { type: "BUS", route: "19_D_D0", startStation: "START", endStation: "END", departureTime: "08:05" } } }
        })
      });
      const result = await response.json();
      assert.equal(response.status, 200);
      assert.equal(result.options.find(option => option.id === result.recommendedOptionId).departure, "08:05");
      assert.equal(result.options.find(option => option.id === result.recommendedOptionId).arrival, "08:35");
    }
    assert.equal(calls.length, 2);
    assert.ok(calls.every(call => call.departureTime === "2026-10-20T08:05:00.000+03:00"));
    const missing = await fetch(`${baseUrl}/api/journeys/evaluate`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ routes: { walk: { "1": { type: "WALK", duration: 10 } } } })
    });
    assert.equal(missing.status, 400);
    assert.equal((await missing.json()).error.code, "MISSING_JOURNEY_TIME");
  }, journeyService);
});

test("calculates a single journey through a separate endpoint and calls the shared IETT function directly", async () => {
  const calls = [];
  const service = { calculateIettRouteTimes: async (route, options) => {
    calls.push({ route, ...options });
    return { total: { estimatedDurationSeconds: 1800 } };
  } };
  await withServer(service, async baseUrl => {
    const input = { routeId: "MBUS-19", startStep: 2, departureTime: "2026-10-20T07:50:00+03:00", route: {
      "1": { type: "WALK", duration: 15 }, "2": { type: "MBUS", duration: 13 },
      "3": { type: "BUS", route: "19_D_D0", startStation: "START", endStation: "END", departures: ["08:05", "08:22"] }
    } };
    const post = body => fetch(`${baseUrl}/api/journeys/calculate`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body)
    });
    const response = await post(input);
    const result = await response.json();
    assert.equal(response.status, 200);
    assert.equal(result.date, "2026-10-20");
    assert.equal(result.timezone, "Europe/Istanbul");
    assert.equal(result.options[0].departure, "07:50");
    assert.equal(result.options.find(option => option.id === (result.recommendedOptionId ?? result.options[0].id)).arrival, "08:35");
    assert.equal(result.options[0].steps[0].transport, "Metrobus");
    assert.equal(result.options[0].durationMinutes, 45);
    assert.equal(result.options[0].steps.find(step => step.transport === "Wait").durationMinutes, 2);
    assert.equal(Object.hasOwn(result, "bestOption"), false);
    assert.equal(result.options.length, 1);
    assert.equal(result.recommendedOptionId, "1");
    assert.equal(calls.length, 1);
    assert.equal(calls[0].departureTime, "2026-10-20T08:05:00.000+03:00");
    for (const extra of [{ arrivalTime: "09:00" }, { routes: {} }, { startStep: 0 }, { startStep: 99 }]) {
      assert.equal((await post({ ...input, ...extra })).status, 400);
    }
    assert.equal(calls.length, 1);
  });
});

test("single-journey endpoint returns a partial timeline if no departure can be reached", async () => {
  const service = { calculateIettRouteTimes: async () => { throw new Error("No bus should be calculated"); } };
  await withServer(service, async baseUrl => {
    const response = await fetch(`${baseUrl}/api/journeys/calculate`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ departureTime: "2026-10-20T08:15:00+03:00", route: {
        "1": { type: "BUS", route: "19_D_D0", startStation: "START", endStation: "END", departure: "08:05" }
      } })
    });
    const result = await response.json();
    assert.equal(response.status, 200);
    assert.equal(result.options[0].status, "No reachable departure");
    assert.match(result.options[0].notes[0], /departures can be reached/);
    assert.equal(result.options.find(option => option.id === (result.recommendedOptionId ?? result.options[0].id)).arrival, null);
    assert.equal(result.options[0].steps[0].arrival, null);
  });
});

test("single-journey endpoint returns all step options and selects the earliest complete arrival", async () => {
  let calls = 0;
  const service = { calculateIettRouteTimes: async route => {
    calls += 1;
    return { total: { estimatedDurationSeconds: route === "19_D_D0" ? 600 : 1200 } };
  } };
  await withServer(service, async baseUrl => {
    const response = await fetch(`${baseUrl}/api/journeys/calculate`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ departureTime: "2026-10-20T08:00:00+03:00", route: {
        "1": { type: "METRO", duration: 15 },
        "2": { type: "BUS_OPTIONS", options: {
          "19": { type: "BUS", route: "19_D_D0", startStation: "START", endStation: "END", departure: "08:20" },
          "16F": { type: "BUS", route: "16F_D_D0", startStation: "START", endStation: "END", departure: "08:15" },
          empty: {}
        } }
      } })
    });
    const result = await response.json();
    assert.equal(response.status, 200);
    assert.equal(result.recommendedOptionId, "1");
    assert.equal(result.options.find(option => option.id === (result.recommendedOptionId ?? result.options[0].id)).arrival, "08:30");
    assert.equal(result.options.length, 3);
    assert.equal(result.options.find(option => option.id === "2").arrival, "08:35");
    assert.equal(result.options.find(option => option.id === "3").status, "Not evaluated");
    assert.equal(calls, 2);
  });
});

test("returns consistent API errors and no CORS headers", async () => {
  const service = {
    async getIettRouteOptions() {
      throw new AppError(404, "IETT_LINE_NOT_FOUND", "No routes.", { lineCode: "256" });
    },
    async buildIettGoogleMapsRoute() {
      throw new Error("unused");
    },
    async buildIettAppleMapsRoute() {
      throw new Error("unused");
    },
    async buildIettYandexMapsRoute() {
      throw new Error("unused");
    },
    async calculateIettRouteTimes() {
      throw new Error("unused");
    }
  };

  await withServer(service, async baseUrl => {
    const response = await fetch(`${baseUrl}/api/iett/lines/256`, {
      headers: { origin: "https://example.com" }
    });
    const body = await response.json();

    assert.equal(response.status, 404);
    assert.equal(response.headers.get("access-control-allow-origin"), null);
    assert.deepEqual(body, {
      error: {
        code: "IETT_LINE_NOT_FOUND",
        message: "No routes.",
        details: { lineCode: "256" }
      }
    });
  });
});

test("returns a 400 API error for malformed JSON", async () => {
  const service = {
    async getIettRouteOptions() {
      return {};
    },
    async buildIettGoogleMapsRoute() {
      return {};
    },
    async buildIettAppleMapsRoute() {
      return {};
    },
    async buildIettYandexMapsRoute() {
      return {};
    },
    async calculateIettRouteTimes() {
      return {};
    }
  };

  await withServer(service, async baseUrl => {
    const response = await fetch(`${baseUrl}/api/iett/routes/256_G_D0/google-maps`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{broken"
    });
    const body = await response.json();

    assert.equal(response.status, 400);
    assert.equal(body.error.code, "INVALID_JSON");
  });
});
