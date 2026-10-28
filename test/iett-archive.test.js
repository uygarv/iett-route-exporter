import assert from "node:assert/strict";
import test from "node:test";
import { IettArchiveClient, parseArchiveResponse } from "../src/clients/iett-archive-client.js";
import { archiveRecord, archiveXml } from "./fixtures/iett-archive.js";
import { archiveTimestamp, completedRange, dateRange, localDate } from "../src/history/time.js";
import { normalizeArchiveRecord, historyRecord, archiveSourceRecord, IETT_ARCHIVE_FIELD_MAP } from "../src/history/records.js";

test("source mapping remains available while HTTP records keep database names and safe identifier precision", () => {
  const row = normalizeArchiveRecord(archiveRecord({ ID: "00177490596", NGOREVID: "9007199254740993" }), "2026-10-25");
  const response = historyRecord(row);
  assert.equal(response.source_id, 177490596);
  assert.equal(response.task_id, "9007199254740993");
  assert.equal(response.extra_fields.values.ID, "00177490596");
  assert.ok(!Object.hasOwn(response, "ID"));
  assert.ok(!Object.hasOwn(response, "normalized"));
  assert.equal(IETT_ARCHIVE_FIELD_MAP.ID, "source_id");
  assert.equal(IETT_ARCHIVE_FIELD_MAP.DTBASLAMAZAMANI, "started_at");
  assert.deepEqual(archiveSourceRecord(row), archiveRecord({ ID: "00177490596", NGOREVID: "9007199254740993" }));
});

test("compact records preserve new fields, exceptions, value types and missing versus null", () => {
  const normal = normalizeArchiveRecord(archiveRecord(), "2026-10-25");
  assert.deepEqual(normal.extra_fields, {});
  assert.ok(!Object.hasOwn(normal, "raw_payload"));
  const cases = [
    archiveRecord({ NEW_FIELD: { value: [null, 12, "İETT"] } }),
    archiveRecord({ ID: "00177490596", NKAYITGUNU: "20261025", NGOREVID: "9007199254740993" }),
    archiveRecord({ NARSIVGOREVID: "invalid", NGOREVID: false, SGUZERGAHKODU: 42, SKAPINUMARA: { value: "bus" }, SGOREVDURUM: false }),
    archiveRecord({ DTBASLAMAZAMANI: "/Date(0001792946030000+0300)/", DTBITISZAMANI: "invalid", DTPLANLANANBASLANGICZAMANI: false }),
    archiveRecord({ DTBASLAMAZAMANI: "/Date(-1)/", DTBITISZAMANI: null }),
    archiveRecord({ ...JSON.parse('{"__proto__":{"preserved":true},"values":null,"absent":["future"]}') })
  ];
  const missing = archiveRecord();
  delete missing.SKAPINUMARA;
  delete missing.NGOREVID;
  delete missing.DTBITISZAMANI;
  cases.push(missing);
  for (const raw of cases) {
    const row = normalizeArchiveRecord(raw, "2026-10-25");
    assert.deepEqual(archiveSourceRecord(row), raw);
    // Simulate pg's BIGINT/string and timestamp/Date decoding as well as JSONB storage.
    const persisted = JSON.parse(JSON.stringify(row));
    persisted.source_id = String(BigInt(row.source_id));
    if (row.archive_task_id !== null) persisted.archive_task_id = String(BigInt(row.archive_task_id));
    if (row.task_id !== null) persisted.task_id = String(BigInt(row.task_id));
    for (const key of ["started_at", "ended_at", "planned_started_at", "adjusted_started_at"]) {
      if (row[key] !== null) persisted[key] = new Date(row[key]);
    }
    assert.deepEqual(archiveSourceRecord(persisted), raw);
  }
  assert.deepEqual(normalizeArchiveRecord(missing, "2026-10-25").extra_fields.absent,
    ["SKAPINUMARA", "DTBITISZAMANI", "NGOREVID"]);
});

test("SOAP preserves every source field, escaped text, nulls and unknown fields", () => {
  const records = [archiveRecord({ SKAPINUMARA: null, DTBITISZAMANI: null, FUTURE_FIELD: "A&B <C> İETT" })];
  assert.deepEqual(parseArchiveResponse(archiveXml(records)), records);
  assert.deepEqual(parseArchiveResponse(archiveXml([])), []);
  for (const [xml, code] of [
    ["<broken>", "IETT_ARCHIVE_INVALID_XML"],
    ['<soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/"><soap:Body><soap:Fault><faultstring>Failure</faultstring></soap:Fault></soap:Body></soap:Envelope>', "IETT_ARCHIVE_SOAP_FAULT"],
    [archiveXml({ error: "not an array" }), "IETT_ARCHIVE_INVALID_JSON"],
    [archiveXml().replaceAll("GetIettArsivGorev_jsonResult", "UnexpectedResult"), "IETT_ARCHIVE_INVALID_JSON"]
  ]) assert.throws(() => parseArchiveResponse(xml), { code });
});

test("archive calls serialize, wait after completion and use yyyyMMdd SOAP parameters", async () => {
  let now = 0;
  const starts = [], ends = [], sleeps = [];
  const client = new IettArchiveClient({ clock: () => now, sleepImpl: async ms => { sleeps.push(ms); now += ms; },
    fetchImpl: async (url, options) => {
      starts.push(now);
      assert.equal(url, "https://api.ibb.gov.tr/iett/ibb/ibb360.asmx");
      assert.match(options.body, /<Tarih>2026102[345]<\/Tarih>/);
      assert.equal(options.headers.SOAPAction, '"http://tempuri.org/GetIettArsivGorev_json"');
      now += 700;
      ends.push(now);
      return new Response(archiveXml());
    } });
  await Promise.all(["2026-10-23", "2026-10-24", "2026-10-25"].map(date => client.fetchDay(date)));
  assert.deepEqual(starts, [1000, 2700, 4400]);
  assert.ok(starts.slice(1).every((start, i) => start - ends[i] >= 1000));
  assert.deepEqual(sleeps, [1000, 1000, 1000]);
});

test("archive retries transient errors three times with backoff and Retry-After", async () => {
  let now = 0, calls = 0;
  const waits = [];
  const client = new IettArchiveClient({ clock: () => now,
    sleepImpl: async ms => { waits.push(ms); now += ms; },
    fetchImpl: async () => {
      calls++;
      if (calls === 1) return new Response("busy", { status: 429, headers: { "Retry-After": "10" } });
      if (calls === 2) return new Response("unavailable", { status: 503 });
      return new Response(archiveXml());
    } });
  await client.fetchDay("2026-10-25");
  assert.equal(calls, 3);
  assert.deepEqual(waits, [1000, 10000, 4000]);

  calls = 0;
  const failing = new IettArchiveClient({ delayMs: 0, sleepImpl: async () => {}, fetchImpl: async () => {
    calls++; throw new Error("network");
  } });
  await assert.rejects(failing.fetchDay("2026-10-25"), { code: "IETT_ARCHIVE_REQUEST_FAILED" });
  assert.equal(calls, 3);
});

test("timeout covers a stalled response body; malformed payloads are not retried", async () => {
  let calls = 0;
  const client = new IettArchiveClient({ timeoutMs: 5, delayMs: 0, sleepImpl: async () => {},
    fetchImpl: async (url, { signal }) => {
      calls++;
      return { ok: true, text: () => new Promise((resolve, reject) => {
        signal.addEventListener("abort", () => reject(signal.reason), { once: true });
      }) };
    } });
  await assert.rejects(client.fetchDay("2026-10-25"), { code: "IETT_ARCHIVE_TIMEOUT" });
  assert.equal(calls, 3);
  calls = 0;
  const malformed = new IettArchiveClient({ delayMs: 0, fetchImpl: async () => {
    calls++; return new Response(archiveXml(null));
  } });
  await assert.rejects(malformed.fetchDay("2026-10-25"), { code: "IETT_ARCHIVE_INVALID_JSON" });
  assert.equal(calls, 1);
});

test("Istanbul calendar, epoch timestamps and overnight durations do not depend on host timezone", () => {
  assert.equal(localDate(Date.parse("2026-10-25T21:30:00Z")), "2026-10-26");
  assert.deepEqual(dateRange("2024-02-28", "2024-03-01"), ["2024-02-28", "2024-02-29", "2024-03-01"]);
  assert.throws(() => completedRange("2026-10-25", "2026-10-26", Date.parse("2026-10-25T21:30:00Z")));
  assert.equal(archiveTimestamp("/Date(0+0300)/"), "1970-01-01T00:00:00.000Z");
  assert.equal(archiveTimestamp("invalid"), null);
  const raw = archiveRecord({ DTBASLAMAZAMANI: `/Date(${Date.parse("2026-10-25T23:50:00+03:00")})/`,
    DTBITISZAMANI: `/Date(${Date.parse("2026-10-26T00:10:00+03:00")})/` });
  const row = normalizeArchiveRecord(raw, "2026-10-25");
  assert.equal(historyRecord(row).duration_seconds, 1200);
  assert.equal(historyRecord(row).ended_at, "2026-10-26T00:10:00.000+03:00");
  assert.equal(historyRecord({ ...row, ended_at: null }).duration_seconds, null);
  assert.equal(historyRecord({ ...row, ended_at: row.started_at, started_at: row.ended_at }).duration_seconds, null);
  assert.equal(normalizeArchiveRecord(archiveRecord({ DTBITISZAMANI: "unexpected" }), "2026-10-25").ended_at, null);
  assert.throws(() => normalizeArchiveRecord(raw, "2026-10-24"));
  assert.throws(() => normalizeArchiveRecord(archiveRecord({ ID: null }), "2026-10-25"));
});

test("archive diagnostics preserve each network cause, phase and retry timing without logging secrets", async () => {
  let now = 0;
  const entries = [];
  const client = new IettArchiveClient({ delayMs: 0, clock: () => now,
    logger: entry => entries.push(entry), sleepImpl: async ms => { now += ms; },
    fetchImpl: async () => {
      now += 10_000;
      throw new TypeError("fetch failed for https://private-user:private-password@example.com/?secret=token", {
        cause: Object.assign(new Error("private-password"), { code: "UND_ERR_CONNECT_TIMEOUT" })
      });
    } });
  await assert.rejects(client.fetchDay("2026-10-25"), error => {
    assert.equal(error.code, "IETT_ARCHIVE_REQUEST_FAILED");
    assert.equal(error.details.networkCode, "UND_ERR_CONNECT_TIMEOUT");
    assert.equal(error.details.phase, "response_headers");
    assert.equal(error.details.attempts.length, 3);
    return true;
  });
  const failures = entries.filter(entry => entry.event === "history.request.failed");
  assert.deepEqual(failures.map(entry => entry.attempt), [1, 2, 3]);
  assert.deepEqual(failures.map(entry => entry.retryDelayMs), [2000, 4000, null]);
  assert.deepEqual(failures.map(entry => entry.willRetry), [true, true, false]);
  assert.ok(failures.every(entry => entry.durationMs === 10_000));
  assert.doesNotMatch(JSON.stringify(entries), /private-user|private-password|secret=token/);
});

test("download failures retain byte count and response_body phase, while decode failures do not retry", async () => {
  const entries = [];
  const client = new IettArchiveClient({ delayMs: 0, sleepImpl: async () => {}, logger: entry => entries.push(entry),
    fetchImpl: async () => new Response(new ReadableStream({
      pull(controller) {
        if (!this.sent) { this.sent = true; controller.enqueue(new TextEncoder().encode("<partial>")); }
        else controller.error(new TypeError("terminated", { cause: Object.assign(new Error(), { code: "ECONNRESET" }) }));
      }
    })) });
  await assert.rejects(client.fetchDay("2026-10-25"), error => {
    assert.equal(error.details.phase, "response_body");
    assert.equal(error.details.networkCode, "ECONNRESET");
    assert.equal(error.details.bytesReceived, 9);
    return true;
  });
  const malformed = new IettArchiveClient({ delayMs: 0, fetchImpl: async () => new Response("<broken>") });
  await assert.rejects(malformed.fetchDay("2026-10-25"), error => {
    assert.equal(error.details.phase, "decode");
    assert.equal(error.details.attempts.length, 1);
    return true;
  });
});
