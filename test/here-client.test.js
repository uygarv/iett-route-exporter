import test from "node:test";
import assert from "node:assert/strict";
import { HereClient, createHereScheduler, HERE_HTTP_ATTEMPTS } from "../src/clients/here-client.js";
const direct = { execute: (_identity, run) => run() };
const response = (body = { routes: [{}] }, status = 200, headers = {}) => new Response(JSON.stringify(body), {
  status, headers: { "content-type": "application/json", ...headers }
});
const options = { departureTime: "2026-10-21T05:06:00.000Z" };

test("HERE sends import, handle and local routing requests with the required car and span options", async () => {
  const calls = [];
  const client = new HereClient({ apiKey: " key ", scheduler: direct,
    fetchImpl: async (url, init) => { calls.push({ url, init }); return response(); } });
  const trace = [{ lat: 41, lng: 29 }, { lat: 41, lng: 29.01 }], via = [{ index: 1, stopDuration: 15 }];
  await client.importRoute({ ...options, trace, via });
  await client.getRouteByHandle("abc/def", options);
  await client.calculateRoute({ ...options, origin: trace[0], destination: trace[1] });
  assert.equal(calls[0].url.pathname, "/v8/import");
  assert.equal(calls[0].init.method, "POST");
  assert.deepEqual(JSON.parse(calls[0].init.body), { trace, via });
  assert.equal(calls[1].url.pathname, "/v8/routes/abc%2Fdef");
  assert.equal(calls[1].init.method, "GET");
  assert.equal(calls[2].url.searchParams.get("origin"), "41,29");
  assert.ok(calls.every(c => c.url.searchParams.get("transportMode") === "car"));
  assert.ok(calls.every(c => c.url.searchParams.get("spans").includes("segmentRef")));
  assert.equal(calls[0].url.searchParams.get("apiKey"), "key");
  assert.equal(calls[0].url.searchParams.get("departureTime"), options.departureTime);
});

test("HERE configuration, auth, quota and provider errors have safe public messages", async () => {
  let calls = 0;
  const unconfigured = new HereClient({ apiKey: "", fetchImpl: async () => { calls++; } });
  await assert.rejects(unconfigured.importRoute(options), e => e.status === 503 && e.code === "ROUTING_PROVIDER_NOT_CONFIGURED");
  assert.equal(calls, 0);
  for (const [status, code] of [[401, "HERE_AUTH_FAILED"], [403, "HERE_AUTH_FAILED"], [429, "HERE_RATE_LIMITED"], [500, "HERE_BAD_STATUS"]]) {
    const client = new HereClient({ apiKey: "secret-value", scheduler: direct,
      fetchImpl: async () => response({ title: "secret-value", cause: "https://provider?apiKey=secret-value" }, status, { "retry-after": "3" }) });
    await assert.rejects(client.importRoute(options), e => {
      assert.equal(e.code, code);
      assert.ok(!JSON.stringify({ message: e.message, details: e.details }).includes("secret-value"));
      if (status === 429) assert.equal(e.details.retryAfter, "3");
      return true;
    });
  }
});

test("HERE handles malformed data, invalid handles, JSON errors and bounded body timeouts", async () => {
  for (const [fetchImpl, code, handle] of [
    [async () => response({}), "HERE_MALFORMED_RESPONSE"],
    [async () => response({ routes: [] }), "HERE_NO_ROUTE"],
    [async () => response({ routes: [] }), "HERE_ROUTE_HANDLE_INVALID", true],
    [async () => response({}, 400), "HERE_ROUTE_HANDLE_INVALID", true],
    [async () => new Response("gone", { status: 404 }), "HERE_ROUTE_HANDLE_INVALID", true],
    [async () => new Response("not-json"), "HERE_INVALID_JSON"],
    [async () => { throw new Error("https://provider?apiKey=key"); }, "HERE_REQUEST_FAILED"],
    [async (_url, { signal }) => ({ ok: true, status: 200, json: () => new Promise((_resolve, reject) =>
      signal.addEventListener("abort", () => reject(new Error("abort")), { once: true })) }), "HERE_TIMEOUT"]
  ]) {
    const client = new HereClient({ apiKey: "key", scheduler: direct, timeoutMs: 10, fetchImpl });
    await assert.rejects(handle ? client.getRouteByHandle("h", options) : client.importRoute(options), e => e.code === code);
  }
});

test("HERE transport retries are limited to two HTTP attempts and share pending requests", async () => {
  let calls = 0;
  const scheduler = createHereScheduler({ requestsPerSecond: 1000, maxConcurrency: 2, random: () => 0 });
  const client = new HereClient({ apiKey: "key", scheduler, fetchImpl: async () => {
    calls++; if (calls === 1) return new Response("temporary failure", { status: 500 }); return response();
  } });
  const [a, b] = await Promise.all([client.importRoute(options), client.importRoute(options)]);
  assert.equal(calls, 2);
  assert.equal(a, b);
  assert.equal(a[HERE_HTTP_ATTEMPTS], 2);
  const failing = new HereClient({ apiKey: "key", scheduler, fetchImpl: async () => { throw new Error("network"); } });
  await assert.rejects(failing.importRoute(options), e => e.code === "HERE_REQUEST_FAILED" && e[HERE_HTTP_ATTEMPTS] === 2);
});

test("HERE long Retry-After and auth failures do not cause extra HTTP calls", async () => {
  for (const status of [401, 403, 429]) {
    let calls = 0;
    const client = new HereClient({ apiKey: "key", scheduler: createHereScheduler({ maxRetryWaitMs: 5 }),
      fetchImpl: async () => { calls++; return response({}, status, { "retry-after": "60" }); } });
    await assert.rejects(client.importRoute(options));
    assert.equal(calls, 1);
  }
});
