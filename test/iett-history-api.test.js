import assert from "node:assert/strict";
import test from "node:test";
import { createApp } from "../src/app.js";
import { createIettHistoryService } from "../src/services/iett-history-service.js";
import { normalizeArchiveRecord } from "../src/history/records.js";
import { createDatabase } from "../src/db/database.js";
import { archiveRecord } from "./fixtures/iett-archive.js";

const clock = () => Date.parse("2026-10-26T12:00:00Z");

test("database construction is lazy and RDS refuses unverified TLS configuration", async () => {
  const lazy = createDatabase({ connectionString: "not a database URL" });
  await lazy.end(); // No URL parsing, file access or connection on construction/close.
  const rds = createDatabase({ connectionString: "postgresql://user:password@db.test.rds.amazonaws.com/history", caFile: "" });
  assert.throws(() => rds.connect(), /require DATABASE_SSL_CA_FILE/);
  await rds.end();
  const conflict = createDatabase({ connectionString: "postgresql://localhost/history?sslmode=require", caFile: "/unused.pem" });
  assert.throws(() => conflict.connect(), /without SSL parameters/);
  await conflict.end();
});

test("history HTTP endpoint returns database fields without IETT reconstruction", async t => {
  const calls = [];
  const rows = [2, 1].map(ID => normalizeArchiveRecord(archiveRecord({ ID, EXTRA: "kept" }), "2026-10-25"));
  const historyService = createIettHistoryService({ clock, repository: {
    bounds: async () => ({ first_date: "2026-10-25" }),
    readHistory: async options => { calls.push(options); return options.cursor ? [rows[1]] : rows; },
    coverage: async () => [{ date: "2026-10-25", status: "success", last_success_at: "2026-10-26T01:00:00Z" }]
  } });
  const server = createApp({ service: {}, journeyService: {}, historyService }).listen(0, "127.0.0.1");
  await new Promise(resolve => server.once("listening", resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const base = `http://127.0.0.1:${server.address().port}`;
  const response = await fetch(`${base}/api/iett/history/19?limit=1`);
  assert.equal(response.status, 200);
  const first = await response.json();
  assert.deepEqual(first.data[0].extra_fields, { values: { EXTRA: "kept" } });
  assert.equal(first.data[0].source_id, 2);
  assert.equal(first.data[0].record_date, "2026-10-25");
  assert.equal(first.data[0].line_code, "19");
  assert.equal(first.data[0].started_at, "2026-10-25T19:33:50.000+03:00");
  assert.equal(first.data[0].duration_seconds, 2361);
  for (const field of [...Object.keys(archiveRecord()), "normalized", "EXTRA"]) {
    assert.ok(!Object.hasOwn(first.data[0], field), `${field} must not be reconstructed in HTTP responses`);
  }
  assert.equal(first.coverage.complete, true);
  assert.equal(first.timezone, "Europe/Istanbul");
  const second = await fetch(`${base}/api/iett/history/19?cursor=${first.pagination.nextCursor}&limit=1`).then(r => r.json());
  assert.equal(second.data[0].source_id, 1);
  assert.equal(second.pagination.nextCursor, null);
  assert.equal(calls[1].cursor.id, "2");
  assert.deepEqual(await fetch(`${base}/health`).then(r => r.json()), { status: "ok" });
});

test("invalid history query parameters fail before storage access", async () => {
  const service = createIettHistoryService({ clock, repository: { bounds: () => { throw new Error("Unexpected storage call"); } } });
  for (const query of [
    { from: "2026-02-30" }, { from: "2026-10-25", to: "2026-10-24" }, { to: "2026-10-26" },
    { from: ["2026-10-24", "2026-10-25"] }, { limit: "0" }, { limit: "1001" },
    { limit: "1.5" }, { limit: ["1", "2"] }, { routeCode: ["19_G_D0"] }, { cursor: "invalid!" },
    { cursor: Buffer.from(JSON.stringify({ v: 1 })).toString("base64url") }
  ]) await assert.rejects(service.getHistory("19", query), error => error.status === 400);
});

test("database failures return 503 without leaking connection details", async t => {
  const historyService = createIettHistoryService({ clock, repository: {
    bounds: async () => { throw new Error("postgresql://user:secret@private-host/db"); }
  } });
  const server = createApp({ service: {}, journeyService: {}, historyService }).listen(0, "127.0.0.1");
  await new Promise(resolve => server.once("listening", resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const response = await fetch(`http://127.0.0.1:${server.address().port}/api/iett/history/19`);
  assert.equal(response.status, 503);
  const text = await response.text();
  assert.match(text, /HISTORY_DATABASE_UNAVAILABLE/);
  assert.doesNotMatch(text, /secret|private-host/);
});
