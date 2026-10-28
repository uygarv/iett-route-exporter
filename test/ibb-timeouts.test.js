import assert from "node:assert/strict";
import test from "node:test";
import { fetchIbbHeaders, readIbbTimeouts } from "../src/clients/ibb-timeouts.js";

test("IBB timeout defaults and overrides reject unbounded or invalid timers", () => {
  assert.deepEqual(readIbbTimeouts({ env: {} }), { connectTimeoutMs: 5000, headersTimeoutMs: 15000 });
  assert.deepEqual(readIbbTimeouts({ env: { IBB_CONNECT_TIMEOUT_MS: " 2500 ", IBB_HEADERS_TIMEOUT_MS: "8000" } }),
    { connectTimeoutMs: 2500, headersTimeoutMs: 8000 });
  assert.deepEqual(readIbbTimeouts({ connectTimeoutMs: 20, headersTimeoutMs: 50, env: { IBB_CONNECT_TIMEOUT_MS: "bad" } }),
    { connectTimeoutMs: 20, headersTimeoutMs: 50 });
  for (const value of [0, -1, 0.5, NaN, Infinity, 2_147_483_648]) {
    for (const key of ["connectTimeoutMs", "headersTimeoutMs"]) {
      assert.throws(() => readIbbTimeouts({ [key]: value, env: {} }), { code: "IBB_TIMEOUT_CONFIGURATION_ERROR" });
    }
  }
});

test("header deadline expires independently from the caller's longer body deadline", async () => {
  const parent = new AbortController();
  await assert.rejects(fetchIbbHeaders(async (url, { signal }) => new Promise((resolve, reject) => {
    signal.addEventListener("abort", () => reject(signal.reason), { once: true });
  }), "https://api.ibb.gov.tr/", { signal: parent.signal }, 20), error => {
    assert.equal(error.name, "TimeoutError");
    assert.equal(error.details.networkCode, "UND_ERR_HEADERS_TIMEOUT");
    assert.equal(error.details.headersTimeoutMs, 20);
    return true;
  });
  assert.equal(parent.signal.aborted, false);
});

test("headers stop the short timer while the caller can still cancel the streaming body", async () => {
  const parent = new AbortController();
  let requestSignal;
  const response = await fetchIbbHeaders(async (url, { signal }) => {
    requestSignal = signal;
    return new Response(new ReadableStream({ start(controller) {
      controller.enqueue(new TextEncoder().encode("first"));
      signal.addEventListener("abort", () => controller.error(signal.reason), { once: true });
    } }));
  }, "https://api.ibb.gov.tr/", { signal: parent.signal }, 20);
  const rejected = assert.rejects(response.text(), { name: "AbortError" });
  await new Promise(resolve => setTimeout(resolve, 60));
  assert.equal(requestSignal.aborted, false, "the short header deadline must not abort a body download");
  parent.abort();
  await rejected;
});

test("caller cancellation takes precedence over the header deadline", async () => {
  const parent = new AbortController();
  const reason = new Error("cancelled by caller");
  const pending = fetchIbbHeaders(async (url, { signal }) => new Promise((resolve, reject) => {
    signal.addEventListener("abort", () => reject(signal.reason), { once: true });
  }), "https://api.ibb.gov.tr/", { signal: parent.signal }, 1000);
  parent.abort(reason);
  await assert.rejects(pending, error => error === reason);
});
