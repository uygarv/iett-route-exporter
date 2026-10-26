import assert from "node:assert/strict";
import test from "node:test";
import { createApp } from "../src/app.js";
import { statisticsQuery } from "../src/history/statistics-query.js";
import { clockStatistic } from "../src/history/statistics-response.js";
import { StatisticsRepository } from "../src/history/statistics-repository.js";
import { createIettStatisticsService } from "../src/services/iett-statistics-service.js";

const clock = () => Date.parse("2026-10-26T12:00:00Z");
const empty = { groups: [], days: [], statuses: [] };

test("statistics defaults use completed Istanbul dates and preserve exact route codes", () => {
  assert.deepEqual(statisticsQuery(" THSS_G_DGR_Ümraniye(2) ", {}, clock()), {
    route_code: "THSS_G_DGR_Ümraniye(2)", from: "2026-09-26", to: "2026-10-25", mode: "general",
    departure_time: null, departure_basis: "planned", weekday: null, departure_day_offset: null
  });
  assert.equal(statisticsQuery("256_D_D0", {}, Date.parse("2026-10-25T21:01:00Z")).to, "2026-10-25");
  assert.equal(statisticsQuery("256_D_D0", { to: "2026-10-01" }, clock()).from, "2026-09-02");
  assert.equal(statisticsQuery("256_D_D0", { from: "2026-01-01" }, clock()).to, "2026-10-25");
  const specific = statisticsQuery("256_D_D0", { departure_time: "07:55", weekday: "1" }, clock());
  assert.equal(specific.mode, "departure");
  assert.equal(specific.departure_day_offset, 0);
  assert.ok(!Object.hasOwn(specific, "bucket_minutes"));
  assert.equal(specific.weekday, 1);
  assert.equal(statisticsQuery("R", { departure_time: "00:00", departure_basis: "adjusted", departure_day_offset: "1" }, clock()).departure_day_offset, 1);
});

test("malformed statistics parameters fail before a database is accessed", async () => {
  let accessed = false;
  const service = createIettStatisticsService({ clock, logger: () => {}, repository: {
    read: async () => { accessed = true; return empty; }
  } });
  for (const query of [
    { from: "2026-02-30" }, { to: "2026-10-26" }, { from: "2026-10-25", to: "2026-10-24" },
    { departure_time: "7:55" }, { departure_time: "24:00" }, { departure_time: "07:55:00" },
    { departure_time: ["07:55", "08:55"] }, { departure_basis: "first" }, { weekday: "0" },
    { weekday: "8" }, { weekday: "1.5" }, { weekday: ["1", "2"] }, { departure_day_offset: "2" },
    { departure_day_offset: "-1" }, { bucket_minutes: "20" }, { bucket_minutes: "060" }, { bucket_minutes: "60" },
    { departure_basis: "actual" }, { departure_basis: "adjusted" },
    { departure_time: "07:55", bucket_minutes: "60" }, { from: ["2026-10-25"] },
    { typo: "true" }, { departure_time: "" }
  ]) await assert.rejects(service.getStatistics("R", query), error => error.status === 400);
  for (const route of ["", "R\u0000X", "x".repeat(101), ["R"]]) {
    await assert.rejects(service.getStatistics(route), error => error.status === 400);
  }
  assert.equal(accessed, false);
});

test("arrival clock statistics retain next-day and negative-day offsets", () => {
  assert.deepEqual(clockStatistic(87000), { time: "00:10:00", day_offset: 1, seconds_from_service_midnight: 87000 });
  assert.deepEqual(clockStatistic(86400), { time: "00:00:00", day_offset: 1, seconds_from_service_midnight: 86400 });
  assert.deepEqual(clockStatistic(-60), { time: "23:59:00", day_offset: -1, seconds_from_service_midnight: -60 });
  assert.equal(clockStatistic(null), null);
});

test("statistics HTTP endpoint supports Unicode routes and empty precise-departure responses", async t => {
  const calls = [];
  const statisticsService = createIettStatisticsService({ clock, logger: () => {}, repository: {
    read: async options => { calls.push(options); return empty; }
  } });
  const server = createApp({ service: {}, journeyService: {}, statisticsService }).listen(0, "127.0.0.1");
  await new Promise(resolve => server.once("listening", resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const base = `http://127.0.0.1:${server.address().port}`;
  const response = await fetch(`${base}/api/iett/routes/${encodeURIComponent("THSS_G_DGR_Ümraniye(2)")}/statistics?departure_time=07:55`);
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(calls[0].route_code, "THSS_G_DGR_Ümraniye(2)");
  assert.equal(body.summary.service.recorded_trips, 0);
  assert.equal(body.summary.arrival_time.p50, null);
  assert.equal(body.profiles.by_weekday.length, 7);
  assert.ok(!Object.hasOwn(body, "departures"));
  assert.ok(!Object.hasOwn(body.profiles, "by_weekday_departure"));
  assert.equal(body.filters.departure_basis, "planned");
  assert.equal(body.timezone, "Europe/Istanbul");
  const bad = await fetch(`${base}/api/iett/routes/R/statistics?departure_time=07:55&bucket_minutes=60`);
  assert.equal(bad.status, 400);
  const general = await fetch(`${base}/api/iett/routes/R/statistics`).then(r => r.json());
  assert.ok(!Object.hasOwn(general.summary, "arrival_time"));
  assert.deepEqual(general.departures, []);
  assert.deepEqual(general.profiles.by_weekday_departure, []);
  assert.ok(!Object.hasOwn(general.filters, "bucket_minutes"));
});

test("storage and timeout failures return 503 without leaking connection details", async t => {
  let code = "ECONNREFUSED";
  const statisticsService = createIettStatisticsService({ clock, logger: () => {}, repository: {
    read: async () => { throw Object.assign(new Error("postgresql://user:secret@private-host/db"), { code }); }
  } });
  const server = createApp({ service: {}, journeyService: {}, statisticsService }).listen(0, "127.0.0.1");
  await new Promise(resolve => server.once("listening", resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const url = `http://127.0.0.1:${server.address().port}/api/iett/routes/R/statistics`;
  for (const expected of ["STATISTICS_DATABASE_UNAVAILABLE", "STATISTICS_QUERY_TIMEOUT"]) {
    const response = await fetch(url);
    assert.equal(response.status, 503);
    const text = await response.text();
    assert.match(text, new RegExp(expected));
    assert.doesNotMatch(text, /secret|private-host/);
    code = "57014";
  }
});

test("repository uses one read-only repeatable-read snapshot with timeout, and releases failures", async () => {
  const commands = [];
  let released = 0;
  let fail = false;
  const client = {
    query: async sql => {
      commands.push(sql);
      if (sql.startsWith("WITH") && fail) throw Object.assign(new Error("cancelled"), { code: "57014" });
      return { rows: [] };
    },
    release: () => { released++; }
  };
  const repository = new StatisticsRepository({ connect: async () => client });
  await repository.read(statisticsQuery("R", {}, clock()));
  assert.equal(commands[0], "BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
  assert.equal(commands[1], "SET LOCAL statement_timeout = '15s'");
  assert.equal(commands.at(-1), "COMMIT");
  assert.equal(released, 1);
  fail = true;
  await assert.rejects(repository.read(statisticsQuery("R", {}, clock())), { code: "57014" });
  assert.equal(commands.at(-1), "ROLLBACK");
  assert.equal(released, 2);
});
