import assert from "node:assert/strict";
import test from "node:test";
import { createProxyHealth } from "../src/clients/proxy-health.js";

const origin = "https://api.ibb.gov.tr";
const urls = ["http://one.example/", "http://two.example/", "http://three.example/"];
const quiet = () => {};

function persisted(url, now, extra = {}) {
  return { proxy_url: new URL(url).origin, last_event_at: new Date(now), last_success_at: new Date(now),
    last_request_success_at: new Date(now), consecutive_failures: 0, last_probe_latency_ms: 20,
    last_download_bps: 120000, ...extra };
}
function store(rows = [], record = async () => {}) {
  return { load: async () => rows, record, prune: async () => {}, close: async () => {} };
}

test("restart reuses a recently successful listed proxy without probing or downloading test data", async t => {
  const now = Date.now();
  const health = createProxyHealth({ repository: store([persisted(urls[1], now - 10_000)]), logger: quiet, clock: () => now });
  t.after(() => health.close());
  const selected = await health.select(urls, origin, undefined, () => assert.fail("fresh persisted success must skip the probe"));
  assert.equal(selected, urls[1]);
});

test("ephemeral proxies absent from the current list are never revived from PostgreSQL", async t => {
  const now = Date.now();
  const health = createProxyHealth({ repository: store([persisted(urls[0], now)]), logger: quiet });
  t.after(() => health.close());
  const tested = [];
  const selected = await health.select([urls[1]], origin, urls[0], async url => { tested.push(url); });
  assert.equal(selected, urls[1]);
  assert.deepEqual(tested, [urls[1]]);
});

test("expired successes are rechecked, while warm successful traffic avoids further probes", async t => {
  let now = Date.now();
  const health = createProxyHealth({ repository: store([persisted(urls[1], now - 121_000)]), logger: quiet, clock: () => now });
  t.after(() => health.close());
  let probes = 0;
  const run = async () => { probes++; };
  const selected = await health.select([urls[1]], origin, undefined, run);
  assert.equal(probes, 1);
  now += 100_000;
  health.success(selected, origin, { durationMs: 500, bytes: 25000 });
  now += 100_000;
  assert.equal(await health.select([urls[1]], origin, selected, run), selected);
  assert.equal(probes, 1);
});

test("cold selection probes at most two candidates, returns on first success and coalesces concurrent probes", async t => {
  const health = createProxyHealth({ logger: quiet, probeTimeoutMs: 80 });
  t.after(() => health.close());
  const calls = [];
  let finish;
  const run = async (url, signal) => {
    calls.push(url);
    if (url === urls[0]) return new Promise((resolve, reject) => signal.addEventListener("abort", () => reject(signal.reason), { once: true }));
    await new Promise(resolve => { finish = resolve; });
  };
  const a = health.select(urls, origin, undefined, run);
  const b = health.select(urls, origin, undefined, run);
  for (let i = 0; i < 10 && !finish; i++) await Promise.resolve();
  finish();
  assert.deepEqual(await Promise.all([a, b]), [urls[1], urls[1]]);
  assert.deepEqual(calls, urls.slice(0, 2));
});

test("failed candidates cool down, alternatives are used, and expiry permits a short recheck", async t => {
  let now = Date.now();
  const health = createProxyHealth({ logger: quiet, clock: () => now, cooldownMs: 100 });
  t.after(() => health.close());
  const run = async () => {};
  await health.select([urls[0]], origin, undefined, run);
  health.failure(urls[0], origin, { durationMs: 10, error: { code: "ECONNRESET" } });
  await assert.rejects(health.select([urls[0]], origin, undefined, run), { details: { proxySourceCode: "PROXY_COOLDOWN", phase: "proxy_probe" } });
  assert.equal(await health.select(urls.slice(0, 2), origin, urls[0], run), urls[1]);
  now += 101;
  let checked = 0;
  assert.equal(await health.select([urls[0]], origin, undefined, async () => { checked++; }), urls[0]);
  assert.equal(checked, 1);
});

test("request completion persists observed bytes/speed asynchronously and strips proxy credentials", async () => {
  const events = [];
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const health = createProxyHealth({ logger: quiet, repository: store([], async event => { events.push(event); await gate; }) });
  const url = "http://private-user:private-password@one.example:8080/";
  await health.select([url], origin, undefined, async () => {});
  health.success(url, origin, { bytes: 10000, durationMs: 100 });
  assert.equal(await health.select([url], origin, url, () => assert.fail("SQL persistence must not block a warm request")), url);
  release();
  await health.close();
  assert.equal(events.length, 2);
  assert.equal(events[1].downloadBps, 100000);
  assert.equal(events[1].bytes, 10000);
  assert.equal(events[1].proxy, "http://one.example:8080");
  assert.doesNotMatch(JSON.stringify(events), /private/);
});

test("a slow health database does not stall selection and persistence failures do not fail requests", async () => {
  let release;
  const rows = new Promise(resolve => { release = resolve; });
  const health = createProxyHealth({ loadWaitMs: 10, logger: quiet,
    repository: { ...store([], async () => { throw new Error("private database failure"); }), load: () => rows } });
  assert.equal(await health.select([urls[0]], origin, undefined, async () => {}), urls[0]);
  release([]);
  await health.close();
});

test("origin-specific health never assumes that IETT route access proves archive access", async t => {
  const health = createProxyHealth({ logger: quiet });
  t.after(() => health.close());
  let probes = 0;
  const run = async () => { probes++; };
  await health.select([urls[0]], "https://iett.istanbul", undefined, run);
  await health.select([urls[0]], origin, urls[0], run);
  assert.equal(probes, 2);
});

test("measured transfer speed ranks stale candidates ahead of provider ordering before the short recheck", async t => {
  const now = Date.now();
  const health = createProxyHealth({ logger: quiet, repository: store([
    persisted(urls[0], now - 121_000, { last_download_bps: 1000 }),
    persisted(urls[1], now - 121_000, { last_download_bps: 300000 }),
    persisted(urls[2], now - 121_000, { last_download_bps: 200000 })
  ]) });
  t.after(() => health.close());
  const tested = [];
  assert.equal(await health.select(urls, origin, undefined, async url => { tested.push(url); }), urls[1]);
  assert.deepEqual(tested, [urls[1], urls[2]]);
});
