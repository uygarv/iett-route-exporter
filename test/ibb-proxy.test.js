import assert from "node:assert/strict";
import test from "node:test";
import http from "node:http";
import net from "node:net";
import { once } from "node:events";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createIbbFetch, closeIbbProxyConnections } from "../src/clients/ibb-fetch.js";
import { readIbbProxySource, parseProxySource, createIbbProxySource } from "../src/clients/ibb-proxy-source.js";
import { IettClient } from "../src/clients/iett-client.js";
import { IettArchiveClient } from "../src/clients/iett-archive-client.js";
import { archiveXml, archiveRecord } from "./fixtures/iett-archive.js";
import { createProxyHealth } from "../src/clients/proxy-health.js";

async function listen(server, t) {
  const sockets = new Set();
  server.on("connection", socket => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(async () => {
    for (const socket of sockets) socket.destroy();
    await new Promise(resolve => server.close(resolve));
  });
  return `http://127.0.0.1:${server.address().port}/`;
}

async function proxy(t, { reject = false, status = 502 } = {}) {
  const connections = [];
  const server = http.createServer();
  server.on("connect", (request, downstream, head) => {
    connections.push({ destination: request.url, auth: request.headers["proxy-authorization"] });
    if (reject) {
      downstream.end(`HTTP/1.1 ${status} Proxy Rejected\r\nContent-Length: 0\r\n\r\n`);
      return;
    }
    const destination = new URL(`http://${request.url}`);
    const upstream = net.connect(Number(destination.port), destination.hostname);
    upstream.on("connect", () => {
      downstream.write("HTTP/1.1 200 Connection Established\r\n\r\n");
      if (head.length) upstream.write(head);
      downstream.pipe(upstream).pipe(downstream);
    });
    upstream.on("error", () => downstream.destroy());
    downstream.on("error", () => upstream.destroy());
    downstream.on("close", () => upstream.destroy());
  });
  const url = new URL(await listen(server, t));
  url.username = "proxy-user";
  url.password = "secret:password";
  return { url: url.href, connections };
}

function memorySource(urls) {
  return { get: async () => urls, close: async () => {} };
}

function sourceRecord(url, extra = {}) {
  return { proxy: url, alive: true, ssl: true, ip_data: { countryCode: "TR" }, ...extra };
}

async function withProxySettings(settings, run) {
  const keys = ["IBB_PROXY_SOURCE_URL", "IETT_CLIENT_USE_PROXY", "IETT_ARCHIVE_USE_PROXY"];
  const previous = Object.fromEntries(keys.map(key => [key, process.env[key]]));
  await closeIbbProxyConnections();
  try {
    for (const key of keys) {
      if (settings[key] === undefined) delete process.env[key];
      else process.env[key] = settings[key];
    }
    return await run();
  } finally {
    await closeIbbProxyConnections();
    for (const key of keys) {
      if (previous[key] === undefined) delete process.env[key];
      else process.env[key] = previous[key];
    }
  }
}

test("proxy source URL is optional and invalid configuration never exposes credentials", () => {
  assert.equal(readIbbProxySource(""), null);
  assert.equal(readIbbProxySource("https://api.example/list?country=tr"), "https://api.example/list?country=tr");
  for (const value of ["invalid", "socks5://proxy.example/", "https://private-user:private-password@proxy.example/"]) {
    assert.throws(() => readIbbProxySource(value), error => {
      assert.equal(error.message, "IBB_PROXY_SOURCE_URL must be an HTTP/HTTPS URL without credentials.");
      assert.doesNotMatch(error.stack, /private-user|private-password/);
      return true;
    });
  }
});

test("ProxyScrape parsing selects live Turkish HTTPS-capable HTTP proxies, ranks and deduplicates them", () => {
  const records = [
    sourceRecord("http://slow.example:8080", { uptime: 50, average_timeout: 400 }),
    sourceRecord("http://best.example:8080", { uptime: 90, average_timeout: 200 }),
    sourceRecord("https://second.example:8443", { uptime: 90, average_timeout: 300 }),
    sourceRecord("http://best.example:8080", { uptime: 90, average_timeout: 200 }),
    sourceRecord("socks4://socks.example:1080"), sourceRecord("socks5://socks.example:1080"),
    sourceRecord("http://dead.example", { alive: false }), sourceRecord("http://no-ssl.example", { ssl: false }),
    sourceRecord("http://foreign.example", { ip_data: { countryCode: "US" } }),
    sourceRecord("http://invalid.example", { ip_data: { countryCode: 123 } }),
    sourceRecord("http://private-user:private-password@proxy.example"), sourceRecord("not a url"), null
  ];
  assert.deepEqual(parseProxySource({ proxies: records }),
    ["http://best.example:8080/", "https://second.example:8443/", "http://slow.example:8080/"]);
  assert.throws(() => parseProxySource({ proxies: [] }), { details: { proxySourceCode: "PROXY_SOURCE_EMPTY" } });
  assert.throws(() => parseProxySource({}), { details: { proxySourceCode: "PROXY_SOURCE_INVALID_RESPONSE" } });
});

test("empty list uses direct fetch and configured lists never fall back to direct access", async () => {
  let directCalls = 0;
  const directFetch = async () => { directCalls++; return new Response("direct"); };
  const direct = createIbbFetch({ source: memorySource([]), directFetch });
  assert.equal(await (await direct("https://api.ibb.gov.tr/")).text(), "direct");
  const selected = [];
  const request = createIbbFetch({ source: memorySource(["http://one.example/", "http://two.example/"]),
    directFetch, agentFactory: url => ({ url, close: async () => {} }),
    fetchImpl: async (url, options) => {
      selected.push(options.dispatcher.url);
      throw Object.assign(new Error("secret proxy error"), { cause: { code: "ECONNREFUSED" } });
    } });
  for (let i = 0; i < 3; i++) {
    await assert.rejects(request("https://api.ibb.gov.tr/"), error => {
      assert.equal(error.code, "IBB_PROXY_REQUEST_FAILED");
      assert.equal(error.details.networkCode, "ECONNREFUSED");
      assert.equal(error.cause, undefined);
      assert.doesNotMatch(error.stack, /secret proxy error/);
      return true;
    });
  }
  assert.deepEqual(selected, ["http://one.example/", "http://two.example/", "http://one.example/"]);
  assert.equal(directCalls, 1);
  await request.close();
});

test("aborted proxy requests preserve cancellation without advancing the list", async () => {
  const controller = new AbortController();
  const selected = [];
  const reason = new Error("cancelled");
  const request = createIbbFetch({ source: memorySource(["http://one.example/", "http://two.example/"]),
    agentFactory: url => ({ url, close: async () => {} }), fetchImpl: async (url, options) => {
      selected.push(options.dispatcher.url);
      if (selected.length === 1) { controller.abort(reason); throw reason; }
      return new Response("ok");
    } });
  await assert.rejects(request("https://api.ibb.gov.tr/", { signal: controller.signal }), reason);
  assert.equal(await (await request("https://api.ibb.gov.tr/")).text(), "ok");
  assert.deepEqual(selected, ["http://one.example/", "http://one.example/"]);
  await request.close();
});

test("request deadlines advance a stalled proxy before the archive retry", async t => {
  const selected = [];
  const entries = [];
  const request = createIbbFetch({ source: memorySource(["http://stalled.example/", "http://working.example/"]),
    agentFactory: url => ({ url, close: async () => {} }), fetchImpl: async (url, options) => {
      selected.push(options.dispatcher.url);
      if (options.dispatcher.url.includes("stalled")) {
        await new Promise((resolve, reject) => options.signal.addEventListener("abort", () => reject(options.signal.reason), { once: true }));
      }
      return new Response(archiveXml());
    } });
  t.after(() => request.close());
  const archive = new IettArchiveClient({ fetchImpl: request, timeoutMs: 30, delayMs: 0, sleepImpl: async () => {}, logger: entry => entries.push(entry) });
  assert.deepEqual(await archive.fetchDay("2026-10-25"), [archiveRecord()]);
  assert.deepEqual(selected, ["http://stalled.example/", "http://working.example/"]);
  const failure = entries.find(entry => entry.event === "history.request.failed");
  assert.equal(failure.proxy, "http://stalled.example");
  assert.equal(failure.transport, "proxy");
  assert.equal(failure.proxyCount, 2);
  assert.equal(failure.phase, "response_headers");
  assert.equal(failure.code, "IETT_ARCHIVE_TIMEOUT");
});

test("archive body timeout and interrupted downloads advance to the next proxy", async t => {
  for (const failure of ["timeout", "interrupted"]) {
    const selected = [];
    const entries = [];
    const request = createIbbFetch({ source: memorySource(["http://broken.example/", "http://working.example/"]),
      agentFactory: url => ({ url, close: async () => {} }), fetchImpl: async (url, options) => {
        selected.push(options.dispatcher.url);
        if (options.dispatcher.url.includes("working")) return new Response(archiveXml());
        return new Response(new ReadableStream({ start(controller) {
          controller.enqueue(new TextEncoder().encode("<partial>"));
          if (failure === "interrupted") controller.error(new TypeError("terminated"));
          else options.signal.addEventListener("abort", () => controller.error(options.signal.reason), { once: true });
        } }));
      } });
    t.after(() => request.close());
    const archive = new IettArchiveClient({ fetchImpl: request, timeoutMs: 40, delayMs: 0, sleepImpl: async () => {}, logger: entry => entries.push(entry) });
    assert.deepEqual(await archive.fetchDay("2026-10-25"), [archiveRecord()]);
    assert.deepEqual(selected, ["http://broken.example/", "http://working.example/"]);
    const diagnostic = entries.find(entry => entry.event === "history.request.failed");
    assert.equal(diagnostic.proxy, "http://broken.example");
    assert.equal(diagnostic.phase, "response_body");
  }
});

test("retryable HTTP responses rotate proxies and retain Retry-After and archive pacing", async t => {
  const selected = [];
  let now = 0;
  const waits = [];
  const request = createIbbFetch({ source: memorySource(["http://busy.example/", "http://broken.example/", "http://working.example/"]),
    agentFactory: url => ({ url, close: async () => {} }), fetchImpl: async (url, options) => {
      const selectedUrl = options.dispatcher.url;
      selected.push(selectedUrl);
      if (selectedUrl.includes("busy")) return new Response("busy", { status: 429, headers: { "Retry-After": "10" } });
      if (selectedUrl.includes("broken")) return new Response("unavailable", { status: 503 });
      return new Response(archiveXml());
    } });
  t.after(() => request.close());
  const archive = new IettArchiveClient({ fetchImpl: request, clock: () => now,
    sleepImpl: async ms => { waits.push(ms); now += ms; } });
  assert.deepEqual(await archive.fetchDay("2026-10-25"), [archiveRecord()]);
  assert.deepEqual(selected, ["http://busy.example/", "http://broken.example/", "http://working.example/"]);
  assert.deepEqual(waits, [1000, 10000, 4000]);
});

test("shutdown releases a real proxy stalled during CONNECT and lets the process exit", { timeout: 4000 }, async () => {
  const script = `
    import assert from 'node:assert/strict';
    import http from 'node:http';
    import { once } from 'node:events';
    import { createIbbFetch } from './src/clients/ibb-fetch.js';
    const server = http.createServer();
    server.on('connect', (request, socket) => socket.on('end', () => socket.destroy()));
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const source = { get: async () => ['http://127.0.0.1:' + server.address().port + '/'], close: async () => {} };
    const request = createIbbFetch({ source, closeTimeoutMs: 40 });
    const controller = new AbortController();
    const connected = once(server, 'connect');
    const rejected = assert.rejects(request('http://127.0.0.1:9000/', { signal: controller.signal }), { name: 'AbortError' });
    await connected;
    controller.abort();
    await rejected;
    await request.close();
    await new Promise(resolve => server.close(resolve));
    console.log('closed');
  `;
  const { stdout } = await promisify(execFile)(process.execPath, ["--input-type=module", "-e", script], { timeout: 2500 });
  assert.match(stdout, /closed/);
});

test("cancelled body reads preserve proxy selection and non-retryable status does not rotate", async t => {
  const selected = [];
  let signal;
  let ready;
  const bodyStarted = new Promise(resolve => { ready = resolve; });
  const request = createIbbFetch({ source: memorySource(["http://one.example/", "http://two.example/"]),
    agentFactory: url => ({ url, close: async () => {} }), fetchImpl: async (url, options) => {
      selected.push(options.dispatcher.url);
      if (selected.length === 2) return new Response("missing", { status: 404 });
      if (selected.length > 2) return new Response(archiveXml());
      signal = options.signal;
      return { ok: true, status: 200, text: async () => {
        ready();
        return new Promise((resolve, reject) => signal.addEventListener("abort", () => reject(signal.reason), { once: true }));
      } };
    } });
  t.after(() => request.close());
  const archive = new IettArchiveClient({ fetchImpl: request, delayMs: 0 });
  const controller = new AbortController();
  const pending = archive.fetchDay("2026-10-25", { signal: controller.signal });
  await bodyStarted;
  controller.abort();
  await assert.rejects(pending, { name: "AbortError" });
  await assert.rejects(archive.fetchDay("2026-10-25"), { code: "IETT_ARCHIVE_BAD_STATUS" });
  assert.deepEqual(await archive.fetchDay("2026-10-25"), [archiveRecord()]);
  assert.deepEqual(selected, ["http://one.example/", "http://one.example/", "http://one.example/"]);
});

test("route response-body timeout is enforced and the next request uses a healthy proxy", async t => {
  const selected = [];
  const request = createIbbFetch({ source: memorySource(["http://stalled.example/", "http://working.example/"]),
    agentFactory: url => ({ url, close: async () => {} }), fetchImpl: async (url, options) => {
      selected.push(options.dispatcher.url);
      if (options.dispatcher.url.includes("working")) return Response.json([{ route: "19_D_D0" }]);
      return new Response(new ReadableStream({ start(controller) {
        controller.enqueue(new TextEncoder().encode("["));
        options.signal.addEventListener("abort", () => controller.error(options.signal.reason), { once: true });
      } }));
    } });
  t.after(() => request.close());
  const routes = new IettClient({ fetchImpl: request, timeoutMs: 30 });
  await assert.rejects(routes.getAllRoutes("19"), { code: "IETT_TIMEOUT" });
  assert.deepEqual(await routes.getAllRoutes("19"), [{ route: "19_D_D0" }]);
  assert.deepEqual(selected, ["http://stalled.example/", "http://working.example/"]);
});

test("shutdown also bounds already-retired connections and is idempotent", async () => {
  let urls = ["http://old.example/"];
  const destroyed = [];
  const request = createIbbFetch({ source: { get: async () => urls, close: async () => {} }, closeTimeoutMs: 20,
    agentFactory: url => ({ url,
      close: () => url.includes("old") ? new Promise(() => {}) : Promise.resolve(),
      destroy: async () => { destroyed.push(url); }
    }), fetchImpl: async () => new Response("ok") });
  await (await request("https://api.ibb.gov.tr/")).text();
  urls = ["http://new.example/"];
  await (await request("https://api.ibb.gov.tr/")).text();
  const closing = request.close();
  assert.equal(request.close(), closing);
  await closing;
  assert.deepEqual(destroyed, ["http://old.example/"]);
});

test("real CONNECT failover preserves SOAP body, proxy authentication and archive retry delays", async t => {
  const bodies = [];
  const origin = await listen(http.createServer(async (request, response) => {
    let body = "";
    for await (const chunk of request) body += chunk;
    bodies.push({ body, method: request.method, auth: request.headers["proxy-authorization"],
      action: request.headers.soapaction });
    response.end(archiveXml());
  }), t);
  const first = await proxy(t, { reject: true });
  const second = await proxy(t);
  const request = createIbbFetch({ source: memorySource([first.url, second.url]) });
  t.after(() => request.close());
  let now = 0;
  const waits = [];
  const client = new IettArchiveClient({ fetchImpl: request, baseUrl: origin,
    clock: () => now, sleepImpl: async ms => { waits.push(ms); now += ms; } });
  assert.deepEqual(await client.fetchDay("2026-10-25"), [archiveRecord()]);
  assert.deepEqual(waits, [1000, 2000]);
  assert.equal(first.connections.length, 1);
  assert.ok(second.connections.length >= 1);
  assert.equal(second.connections[0].auth,
    `Basic ${Buffer.from("proxy-user:secret:password").toString("base64")}`);
  assert.match(bodies[0].body, /<Tarih>20261025<\/Tarih>/);
  assert.equal(bodies[0].method, "POST");
  assert.equal(bodies[0].action, '"http://tempuri.org/GetIettArsivGorev_json"');
  assert.equal(bodies[0].auth, undefined);
  await client.fetchDay("2026-10-25");
  assert.equal(first.connections.length, 1, "a healthy fallback remains selected");
});

test("default route and archive clients discover the same proxy source lazily after construction", async t => {
  const paths = [];
  const probes = [];
  const origin = await listen(http.createServer((request, response) => {
    if (request.method === "HEAD") probes.push(request.url);
    else paths.push(request.url);
    assert.equal(request.headers["proxy-authorization"], undefined);
    response.end(request.method === "POST" ? archiveXml() : JSON.stringify([{ route: "19_D_D0" }]));
  }), t);
  const tunnel = await proxy(t);
  const source = await listen(http.createServer((request, response) => {
    response.setHeader("Content-Type", "application/json");
    const publicUrl = new URL(tunnel.url);
    publicUrl.username = "";
    publicUrl.password = "";
    response.end(JSON.stringify({ proxies: [sourceRecord(publicUrl.href)] }));
  }), t);
  await withProxySettings({}, async () => {
    const routes = new IettClient({ baseUrl: origin });
    const archive = new IettArchiveClient({ baseUrl: origin, delayMs: 0 });
    process.env.IBB_PROXY_SOURCE_URL = source;
    assert.deepEqual(await routes.getAllRoutes("19"), [{ route: "19_D_D0" }]);
    assert.deepEqual(await routes.getRoutePin("19_D_D0"), [{ route: "19_D_D0" }]);
    assert.deepEqual(await archive.fetchDay("2026-10-25"), [archiveRecord()]);
    assert.ok(tunnel.connections.length >= 1);
    assert.deepEqual(paths, ["/GetAllRoute?rcode=19", "/GetRoutePinV2?q=19_D_D0", "/"]);
    assert.deepEqual(probes, ["/GetAllRoute?rcode=19"], "the warm proxy is shared for the same origin without repeat probes");
    const connections = tunnel.connections.length;
    await (await fetch(`${origin}direct-control`)).text();
    assert.equal(tunnel.connections.length, connections, "global fetch and other providers stay direct");
  });
});

test("real client requests respect every independent .env proxy combination and constructor override", async t => {
  for (const configuration of [
    { client: false, archive: false }, { client: false, archive: true },
    { client: true, archive: false }, { client: true, archive: true },
    { client: true, archive: true, override: false },
    { client: false, archive: false, override: true }
  ]) {
    const routesOrigin = await listen(http.createServer((request, response) => response.end(JSON.stringify([{ route: "19_D_D0" }]))), t);
    const archiveOrigin = await listen(http.createServer((request, response) => response.end(archiveXml())), t);
    const tunnel = await proxy(t);
    const proxyUrl = new URL(tunnel.url);
    proxyUrl.username = "";
    proxyUrl.password = "";
    let discoveries = 0;
    const sourceUrl = await listen(http.createServer((request, response) => {
      discoveries++;
      response.end(JSON.stringify({ proxies: [sourceRecord(proxyUrl.href)] }));
    }), t);
    await withProxySettings({ IBB_PROXY_SOURCE_URL: sourceUrl,
      IETT_CLIENT_USE_PROXY: String(configuration.client), IETT_ARCHIVE_USE_PROXY: String(configuration.archive) }, async () => {
      const routes = new IettClient({ baseUrl: routesOrigin, useProxy: configuration.override });
      const archive = new IettArchiveClient({ baseUrl: archiveOrigin, useProxy: configuration.override, delayMs: 0 });
      assert.deepEqual(await routes.getAllRoutes("19"), [{ route: "19_D_D0" }]);
      assert.deepEqual(await routes.getRoutePin("19_D_D0"), [{ route: "19_D_D0" }]);
      assert.deepEqual(await archive.fetchDay("2026-10-25"), [archiveRecord()]);
      const clientEnabled = configuration.override ?? configuration.client;
      const archiveEnabled = configuration.override ?? configuration.archive;
      const destinations = new Set(tunnel.connections.map(connection => connection.destination));
      assert.equal(destinations.has(new URL(routesOrigin).host), clientEnabled);
      assert.equal(destinations.has(new URL(archiveOrigin).host), archiveEnabled);
      assert.equal(discoveries, clientEnabled || archiveEnabled ? 1 : 0, "enabled clients share discovery; direct clients never discover");
      const tunnels = tunnel.connections.length;
      await (await fetch(routesOrigin)).text();
      assert.equal(tunnel.connections.length, tunnels, "unrelated global fetch stays direct");
    });
  }
});

test("disabled clients bypass invalid proxy configuration, and injected fetch implementations own transport", async t => {
  const routesOrigin = await listen(http.createServer((request, response) => response.end("[]")), t);
  const archiveOrigin = await listen(http.createServer((request, response) => response.end(archiveXml())), t);
  await withProxySettings({ IBB_PROXY_SOURCE_URL: "invalid proxy source", IETT_CLIENT_USE_PROXY: "false", IETT_ARCHIVE_USE_PROXY: "false" }, async () => {
    assert.deepEqual(await new IettClient({ baseUrl: routesOrigin }).getAllRoutes("19"), []);
    assert.deepEqual(await new IettArchiveClient({ baseUrl: archiveOrigin, delayMs: 0 }).fetchDay("2026-10-25"), [archiveRecord()]);
  });
  await withProxySettings({ IETT_CLIENT_USE_PROXY: "invalid", IETT_ARCHIVE_USE_PROXY: "invalid" }, async () => {
    let calls = 0;
    const fetchImpl = async (url, options) => { calls++; return new Response(options.method === "POST" ? archiveXml() : "[]"); };
    assert.deepEqual(await new IettClient({ fetchImpl }).getAllRoutes("19"), []);
    assert.deepEqual(await new IettArchiveClient({ fetchImpl, delayMs: 0 }).fetchDay("2026-10-25"), [archiveRecord()]);
    assert.equal(calls, 2);
  });
});

test("explicit proxy enablement without a source fails closed before any upstream request", async t => {
  let calls = 0;
  const origin = await listen(http.createServer((request, response) => { calls++; response.end("[]"); }), t);
  await withProxySettings({ IETT_CLIENT_USE_PROXY: "true", IETT_ARCHIVE_USE_PROXY: "true" }, async () => {
    const routes = new IettClient({ baseUrl: origin });
    const archive = new IettArchiveClient({ baseUrl: origin, delayMs: 0 });
    await assert.rejects(routes.getAllRoutes("19"), { status: 503, code: "IBB_PROXY_CONFIGURATION_ERROR" });
    await assert.rejects(archive.fetchDay("2026-10-25"), { status: 503, code: "IBB_PROXY_CONFIGURATION_ERROR" });
  });
  assert.equal(calls, 0);
});

test("archive authentication failure can advance to another configured proxy within the retry budget", async t => {
  const origin = await listen(http.createServer((request, response) => response.end(archiveXml())), t);
  const rejected = await proxy(t, { reject: true, status: 407 });
  const working = await proxy(t);
  const request = createIbbFetch({ source: memorySource([rejected.url, working.url]) });
  t.after(() => request.close());
  let now = 0;
  const waits = [];
  const archive = new IettArchiveClient({ baseUrl: origin, fetchImpl: request,
    clock: () => now, sleepImpl: async ms => { waits.push(ms); now += ms; } });
  assert.deepEqual(await archive.fetchDay("2026-10-25"), [archiveRecord()]);
  assert.deepEqual(waits, [1000, 2000]);
  assert.equal(rejected.connections.length, 1);
  assert.equal(working.connections.length, 1);
});

test("CONNECT 407 gives safe route/archive diagnostics without retrying invalid credentials", async t => {
  const tunnel = await proxy(t, { reject: true, status: 407 });
  const request = createIbbFetch({ source: memorySource([tunnel.url]) });
  t.after(() => request.close());
  const archive = new IettArchiveClient({ fetchImpl: request, delayMs: 0 });
  await assert.rejects(archive.fetchDay("2026-10-25"), error => {
    assert.equal(error.code, "IETT_ARCHIVE_PROXY_AUTH_FAILED");
    assert.equal(error.details.proxyStatus, 407);
    assert.equal(error.details.proxyIndex, 1);
    assert.equal(error.details.proxy, new URL(tunnel.url).origin);
    assert.equal(error.details.proxyCount, 1);
    assert.equal(error.details.phase, "response_headers");
    assert.doesNotMatch(JSON.stringify(error), /secret|password|proxy-user/);
    return true;
  });
  assert.equal(tunnel.connections.length, 1);
  const routes = new IettClient({ fetchImpl: request });
  await assert.rejects(routes.getAllRoutes("19"), { code: "IETT_PROXY_AUTH_FAILED" });
  assert.equal(tunnel.connections.length, 2);
});

test("discovery coalesces concurrent requests, caches for two minutes and refreshes on expiry", async t => {
  let now = 0;
  let calls = 0;
  let finish;
  const source = createIbbProxySource({ sourceUrl: "https://source.example/list", clock: () => now,
    fetchImpl: async (url, options) => {
      calls++;
      assert.equal(url, "https://source.example/list");
      assert.equal(options.dispatcher, undefined);
      if (calls === 1) await new Promise(resolve => { finish = resolve; });
      return Response.json({ proxies: [sourceRecord(`http://proxy${calls}.example`)] });
    } });
  t.after(() => source.close());
  const pending = [source.get(), source.get(), source.get()];
  assert.equal(calls, 1);
  finish();
  assert.deepEqual(await Promise.all(pending), Array(3).fill(["http://proxy1.example/"]));
  now = 119_999;
  assert.deepEqual(await source.get(), ["http://proxy1.example/"]);
  assert.equal(calls, 1);
  now = 120_000;
  assert.deepEqual(await source.get(), ["http://proxy2.example/"]);
  assert.equal(calls, 2);
});

test("failed/empty refresh retains previous proxies and backs off for a minute", async t => {
  let now = 0;
  let calls = 0;
  const source = createIbbProxySource({ sourceUrl: "https://source.example/", clock: () => now,
    fetchImpl: async () => {
      calls++;
      if (calls === 2) throw new Error("untrusted provider error");
      return Response.json({ proxies: calls === 3 ? [] : [sourceRecord("http://working.example")] });
    } });
  t.after(() => source.close());
  const expected = ["http://working.example/"];
  assert.deepEqual(await source.get(), expected);
  now = 600_000;
  assert.deepEqual(await source.get(), expected);
  now += 59_999;
  assert.deepEqual(await source.get(), expected);
  assert.equal(calls, 2);
  now++;
  assert.deepEqual(await source.get(), expected);
  assert.equal(calls, 3);
});

test("unavailable or malformed initial source fails closed with safe diagnostics and no IBB request", async t => {
  for (const [response, expected] of [
    [() => new Response("rate limited", { status: 429 }), "PROXY_SOURCE_BAD_STATUS"],
    [() => new Response("invalid json"), "PROXY_SOURCE_FETCH_FAILED"],
    [() => Response.json({}), "PROXY_SOURCE_INVALID_RESPONSE"],
    [() => Response.json({ proxies: [] }), "PROXY_SOURCE_EMPTY"],
    [() => { throw new Error("secret=private-password"); }, "PROXY_SOURCE_FETCH_FAILED"]
  ]) {
    let now = 0;
    let calls = 0;
    const source = createIbbProxySource({ sourceUrl: "https://source.example/", clock: () => now,
      fetchImpl: async () => { calls++; return response(); } });
    const unexpected = () => { assert.fail("IBB must not be called without a usable proxy list"); };
    const request = createIbbFetch({ source, directFetch: unexpected, fetchImpl: unexpected });
    t.after(() => request.close());
    const verify = error => {
      assert.equal(error.code, "IBB_PROXY_REQUEST_FAILED");
      assert.equal(error.details.proxySourceCode, expected);
      assert.doesNotMatch(error.stack, /private-password/);
      return true;
    };
    await assert.rejects(request("https://api.ibb.gov.tr/"), verify);
    await assert.rejects(request("https://api.ibb.gov.tr/"), verify);
    assert.equal(calls, 1);
    now = 60_000;
    await assert.rejects(request("https://api.ibb.gov.tr/"), verify);
    assert.equal(calls, 2);
  }
});

test("discovery timeout covers reading the response body", async t => {
  const endpoint = await listen(http.createServer((request, response) => {
    response.writeHead(200, { "Content-Type": "application/json" });
    response.write('{"proxies":[');
  }), t);
  const source = createIbbProxySource({ sourceUrl: endpoint, timeoutMs: 40 });
  t.after(() => source.close());
  await assert.rejects(source.get(), error => {
    assert.equal(error.details.proxySourceCode, "PROXY_SOURCE_TIMEOUT");
    assert.equal(error.details.phase, "proxy_discovery");
    assert.equal(error.details.timeoutMs, 40);
    return true;
  });
});

test("list refresh keeps the working proxy and retires agents removed by the provider", async t => {
  let now = 0;
  let list = ["http://one.example/", "http://two.example/"];
  const selected = [];
  const closed = [];
  const source = createIbbProxySource({ sourceUrl: "https://source.example/", clock: () => now,
    fetchImpl: async () => Response.json({ proxies: list.map(url => sourceRecord(url)) }) });
  const request = createIbbFetch({ source,
    agentFactory: url => ({ url, close: async () => { closed.push(url); } }),
    fetchImpl: async (url, options) => {
      const proxyUrl = options.dispatcher.url;
      selected.push(proxyUrl);
      if (proxyUrl.includes("one")) throw new Error("failed");
      return new Response("ok");
    } });
  t.after(() => request.close());
  await assert.rejects(request("https://api.ibb.gov.tr/"));
  await (await request("https://api.ibb.gov.tr/")).text();
  list = ["http://three.example/", "http://two.example/"];
  now = 600_000;
  await (await request("https://api.ibb.gov.tr/")).text();
  assert.deepEqual(selected, ["http://one.example/", "http://two.example/", "http://two.example/"]);
  assert.ok(closed.includes("http://one.example/"));
  list = ["http://three.example/"];
  now += 600_000;
  await (await request("https://api.ibb.gov.tr/")).text();
  assert.equal(selected.at(-1), "http://three.example/");
  await request.close();
  assert.deepEqual(closed.sort(), ["http://one.example/", "http://three.example/", "http://two.example/"].sort());
});

test("cancelling a request waiting on discovery does not cancel discovery for other callers", async t => {
  let finish;
  const source = createIbbProxySource({ sourceUrl: "https://source.example/",
    fetchImpl: async () => {
      await new Promise(resolve => { finish = resolve; });
      return Response.json({ proxies: [sourceRecord("http://working.example/")] });
    } });
  const request = createIbbFetch({ source,
    agentFactory: url => ({ close: async () => {} }), fetchImpl: async () => new Response("ok") });
  t.after(() => request.close());
  const controller = new AbortController();
  const pending = request("https://api.ibb.gov.tr/", { signal: controller.signal });
  const other = request("https://api.ibb.gov.tr/");
  controller.abort();
  await assert.rejects(pending, { name: "AbortError" });
  finish();
  assert.equal(await (await other).text(), "ok");
});

test("a stalled CONNECT hits the short headers deadline, rotates, and preserves the archive retry budget", async t => {
  const stalled = http.createServer();
  stalled.on("connect", () => {});
  const stalledUrl = await listen(stalled, t);
  const origin = await listen(http.createServer((req, res) => res.end(archiveXml())), t);
  const working = await proxy(t);
  const entries = [];
  const request = createIbbFetch({ source: memorySource([stalledUrl, working.url]),
    headersTimeoutMs: 80, connectTimeoutMs: 50, closeTimeoutMs: 40 });
  t.after(() => request.close());
  const archive = new IettArchiveClient({ baseUrl: origin, fetchImpl: request,
    timeoutMs: 2000, delayMs: 0, sleepImpl: async () => {}, logger: entry => entries.push(entry) });
  assert.deepEqual(await archive.fetchDay("2026-10-25"), [archiveRecord()]);
  const failure = entries.find(entry => entry.event === "history.request.failed");
  assert.equal(failure.networkCode, "UND_ERR_HEADERS_TIMEOUT");
  assert.equal(failure.proxy, new URL(stalledUrl).origin);
  assert.equal(failure.headersTimeoutMs, 80);
  assert.equal(failure.willRetry, true);
  assert.equal(working.connections.length, 1);
});

test("real proxy and direct downloads outlive the short header timer", async t => {
  const xml = archiveXml();
  const origin = await listen(http.createServer((req, res) => {
    res.writeHead(200, { "content-type": "text/xml" });
    res.write(xml.slice(0, 40));
    setTimeout(() => res.end(xml.slice(40)), 400);
  }), t);
  const tunnel = await proxy(t);
  for (const urls of [[], [tunnel.url]]) {
    const request = createIbbFetch({ source: memorySource(urls), headersTimeoutMs: 200 });
    t.after(() => request.close());
    const archive = new IettArchiveClient({ baseUrl: origin, fetchImpl: request, timeoutMs: 2000, delayMs: 0 });
    assert.deepEqual(await archive.fetchDay("2026-10-25"), [archiveRecord()]);
  }
});

test("TCP/TLS connection limits reach both proxy connectors and the direct connector", async t => {
  const idle = await listen(net.createServer(() => {}), t);
  const tunnel = await proxy(t);
  const target = idle.replace("http:", "https:");
  for (const urls of [[], [tunnel.url], [target]]) {
    const request = createIbbFetch({ source: memorySource(urls), connectTimeoutMs: 40, headersTimeoutMs: 3000 });
    t.after(() => request.close());
    await assert.rejects(request(target), error => {
      assert.equal(error.details.networkCode, "UND_ERR_CONNECT_TIMEOUT");
      assert.equal(error.details.connectTimeoutMs, 40);
      return true;
    });
  }
});

test("health probes use HEAD before SOAP, reuse warm selection, and persist only actual transfer throughput", async t => {
  const methods = [];
  const xml = archiveXml(Array.from({ length: 20 }, (_, ID) => archiveRecord({ ID })));
  const origin = await listen(http.createServer((req, res) => {
    methods.push(req.method);
    if (req.method === "HEAD") { res.end(); return; }
    res.end(xml);
  }), t);
  const bad = await proxy(t, { reject: true });
  const good = await proxy(t);
  const events = [];
  const health = createProxyHealth({ logger: () => {}, repository: {
    load: async () => [], prune: async () => {}, close: async () => {}, record: async event => { events.push(event); }
  } });
  const request = createIbbFetch({ source: memorySource([bad.url, good.url]), health });
  t.after(() => request.close());
  const archive = new IettArchiveClient({ baseUrl: origin, fetchImpl: request, delayMs: 0 });
  assert.equal((await archive.fetchDay("2026-10-25")).length, 20);
  assert.equal((await archive.fetchDay("2026-10-25")).length, 20);
  await request.close();
  assert.deepEqual(methods, ["HEAD", "POST", "POST"]);
  const completed = events.filter(event => event.kind === "request" && event.outcome === "success");
  assert.equal(completed.length, 2);
  assert.ok(completed.every(event => event.bytes === Buffer.byteLength(xml) && event.downloadBps > 0));
  assert.ok(events.some(event => event.kind === "probe" && event.outcome === "failure"));
  assert.doesNotMatch(JSON.stringify(events), /proxy-user|secret:password/);
});

test("HEAD fallback requests one byte and cancels at headers, never measuring speed through a large test download", async t => {
  const methods = [];
  const origin = await listen(http.createServer((req, res) => {
    methods.push({ method: req.method, range: req.headers.range });
    if (req.method === "HEAD") { res.writeHead(405); res.end(); return; }
    if (req.method === "GET") {
      res.writeHead(200);
      res.write("first");
      return;
    }
    res.end(archiveXml());
  }), t);
  const good = await proxy(t);
  const health = createProxyHealth({ logger: () => {}, probeTimeoutMs: 200 });
  const request = createIbbFetch({ source: memorySource([good.url]), health });
  t.after(() => request.close());
  const archive = new IettArchiveClient({ baseUrl: origin, fetchImpl: request, delayMs: 0 });
  assert.deepEqual(await archive.fetchDay("2026-10-25"), [archiveRecord()]);
  assert.deepEqual(methods.map(entry => entry.method), ["HEAD", "GET", "POST"]);
  assert.equal(methods[1].range, "bytes=0-0");
});

test("the real ASMX probe contract uses a tiny WSDL GET because HEAD is unsupported", async t => {
  let cancelled = false;
  let probed = 0;
  const health = createProxyHealth({ logger: () => {} });
  const request = createIbbFetch({ source: memorySource(["http://proxy.example/"]), health,
    agentFactory: () => ({ close: async () => {} }), fetchImpl: async (input, options) => {
      if (options.method === "POST") return new Response(archiveXml());
      probed++;
      assert.equal(String(input), "https://api.ibb.gov.tr/iett/ibb/ibb360.asmx?wsdl");
      assert.equal(options.method, "GET");
      assert.equal(options.headers.range, "bytes=0-0");
      return new Response(new ReadableStream({ cancel() { cancelled = true; } }));
    } });
  t.after(() => request.close());
  const archive = new IettArchiveClient({ fetchImpl: request, delayMs: 0 });
  assert.deepEqual(await archive.fetchDay("2026-10-25"), [archiveRecord()]);
  assert.equal(probed, 1);
  assert.equal(cancelled, true);
});

test("HTTP 200 followed by an interrupted archive records a failed partial transfer, not a successful proxy request", async t => {
  const events = [];
  const health = createProxyHealth({ logger: () => {}, repository: {
    load: async () => [], prune: async () => {}, close: async () => {}, record: async event => { events.push(event); }
  } });
  const request = createIbbFetch({ source: memorySource(["http://proxy.example/"]), health,
    agentFactory: () => ({ close: async () => {} }), fetchImpl: async (input, options) => {
      if (options.method === "HEAD") return new Response(null);
      return new Response(new ReadableStream({ pull(controller) {
        if (!this.sent) { this.sent = true; controller.enqueue(new TextEncoder().encode("<partial>")); }
        else controller.error(new TypeError("terminated", { cause: Object.assign(new Error(), { code: "ECONNRESET" }) }));
      } }));
    } });
  t.after(() => request.close());
  const archive = new IettArchiveClient({ baseUrl: "https://test.example/", fetchImpl: request, delayMs: 0, sleepImpl: async () => {} });
  await assert.rejects(archive.fetchDay("2026-10-25"));
  await request.close();
  const transfers = events.filter(event => event.kind === "request");
  assert.equal(transfers.length, 1);
  assert.equal(transfers[0].outcome, "failure");
  assert.equal(transfers[0].bytes, 9);
  assert.equal(transfers[0].code, "ECONNRESET");
  assert.equal(transfers[0].downloadBps, undefined);
});

test("route clients expose temporary proxy unavailability with its retry delay", async () => {
  const client = new IettClient({ fetchImpl: async () => {
    throw Object.assign(new Error(), { code: "IBB_PROXY_UNAVAILABLE",
      details: { phase: "proxy_probe", proxySourceCode: "PROXY_COOLDOWN", retryAfterMs: 30000, requestSent: false } });
  } });
  await assert.rejects(client.getAllRoutes("19"), error => {
    assert.equal(error.status, 503);
    assert.equal(error.code, "IETT_PROXY_UNAVAILABLE");
    assert.equal(error.details.retryAfterMs, 30000);
    return true;
  });
});
