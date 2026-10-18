import assert from "node:assert/strict";
import test from "node:test";
import { TomTomClient } from "../src/clients/tomtom-client.js";

test("posts Orbis requests with the API key in a header", async () => {
  let received;
  const client = new TomTomClient({
    apiKey: "secret-key",
    fetchImpl: async (url, options) => {
      received = { url, options };

      return new Response(JSON.stringify({ routes: [] }), {
        status: 200,
        headers: { "content-type": "application/json" }
      });
    }
  });
  const payload = { traffic: "live" };

  await client.calculateRoute(payload);

  assert.equal(received.options.method, "POST");
  assert.equal(received.options.headers["tomtom-api-key"], "secret-key");
  assert.equal(received.options.headers.attributes, "routes(summary,legs(summary,path))");
  assert.deepEqual(JSON.parse(received.options.body), payload);
  assert.equal(received.url.searchParams.get("apiVersion"), "3");
  assert.equal(received.url.toString().includes("secret-key"), false);
});

test("requires configuration and maps TomTom quota and reconstruction errors", async () => {
  const unconfigured = new TomTomClient({ apiKey: "" });

  await assert.rejects(
    unconfigured.calculateRoute({}),
    error => error.status === 503 && error.code === "ROUTING_PROVIDER_NOT_CONFIGURED"
  );

  const limited = new TomTomClient({
    apiKey: "key",
    fetchImpl: async () => new Response("not-json", {
      status: 429,
      headers: {
        "content-type": "application/json",
        "retry-after": "30"
      }
    })
  });

  await assert.rejects(
    limited.calculateRoute({}),
    error => {
      return error.status === 429
        && error.code === "TOMTOM_RATE_LIMITED"
        && error.details.retryAfter === "30";
    }
  );

  const reconstructionFailure = new TomTomClient({
    apiKey: "key",
    fetchImpl: async () => new Response(JSON.stringify({
      detailedError: {
        code: "CANNOT_RESTORE_BASEROUTE",
        message: "CANNOT_RESTORE_BASEROUTE"
      }
    }), {
      status: 400,
      headers: { "content-type": "application/json" }
    })
  });

  await assert.rejects(
    reconstructionFailure.calculateRoute({}),
    error => error.status === 502 && error.code === "IETT_ROUTE_RECONSTRUCTION_FAILED"
  );
});

test("maps invalid JSON and request failures to upstream errors", async () => {
  const invalidJson = new TomTomClient({
    apiKey: "key",
    fetchImpl: async () => new Response("not-json", { status: 200 })
  });

  await assert.rejects(
    invalidJson.calculateRoute({}),
    error => error.status === 502 && error.code === "TOMTOM_INVALID_JSON"
  );

  const failedRequest = new TomTomClient({
    apiKey: "key",
    fetchImpl: async () => {
      throw new Error("network down");
    }
  });

  await assert.rejects(
    failedRequest.calculateRoute({}),
    error => error.status === 502 && error.code === "TOMTOM_REQUEST_FAILED"
  );

  const timedOut = new TomTomClient({
    apiKey: "key",
    fetchImpl: async () => {
      const error = new Error("aborted");
      error.name = "AbortError";
      throw error;
    }
  });

  await assert.rejects(
    timedOut.calculateRoute({}),
    error => error.status === 502 && error.code === "TOMTOM_TIMEOUT"
  );

  const unauthorized = new TomTomClient({
    apiKey: "bad-key",
    fetchImpl: async () => new Response("{}", {
      status: 403,
      headers: { "content-type": "application/json" }
    })
  });

  await assert.rejects(
    unauthorized.calculateRoute({}),
    error => error.status === 503 && error.code === "TOMTOM_AUTH_FAILED"
  );
});
