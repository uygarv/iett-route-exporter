import assert from "node:assert/strict";
import test from "node:test";
import { createApp } from "../src/app.js";
import { AppError } from "../src/shared/errors.js";

async function withServer(service, run) {
  const app = createApp({ service });
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
    }
  };

  await withServer(service, async baseUrl => {
    const health = await fetch(`${baseUrl}/health`).then(response => response.json());
    assert.deepEqual(health, { status: "ok" });

    const options = await fetch(`${baseUrl}/api/iett/lines/256/options`).then(response => {
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
    }
  };

  await withServer(service, async baseUrl => {
    const response = await fetch(`${baseUrl}/api/iett/lines/256/options`, {
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
