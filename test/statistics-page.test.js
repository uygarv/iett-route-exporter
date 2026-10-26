import assert from "node:assert/strict";
import test from "node:test";
import { createApp } from "../src/app.js";
import { statisticsQuery } from "../src/history/statistics-query.js";
import { statisticsResponse } from "../src/history/statistics-response.js";
import { clockLabel, defaultDates, deviation, duration, escapeHtml, queryParameters,
  renderStatistics, renderTrend, routeOptions, routePageUrl } from "../public/assets/statistics-view.js";

const now = Date.parse("2026-10-26T12:00:00Z");

function fixture({ specific = true, recorded = 3 } = {}) {
  const options = statisticsQuery("256_D_D0", { from: "2026-10-19", to: "2026-10-20", ...(specific ? { departure_time: "07:35" } : {}) }, now);
  const metric = value => ({ sample_count: recorded, day_count: recorded ? 2 : 0,
    mean: value, min: value, max: value, stddev: 0, percentiles: [value, value, value, value, value, value] });
  const row = { service: { recorded_trips: recorded, day_count: recorded ? 2 : 0,
    observed_departures: recorded, observed_arrivals: recorded, eligible_durations: recorded,
    active_vehicles: recorded ? 2 : 0, recorded_duration_seconds: recorded * 2700 },
  duration_seconds: metric(recorded ? 2700 : null), arrival_time: metric(recorded ? 30000 : null),
  headway_seconds: metric(null), planned_deviation_seconds: { ...metric(30), early_count: 0, on_time_count: recorded, late_count: 0 },
  adjusted_deviation_seconds: { ...metric(0), early_count: 0, on_time_count: recorded, late_count: 0 },
  plan_revision_seconds: { ...metric(0), changed_count: 0, earlier_count: 0, later_count: 0 },
  quality: { missing_start: 0, missing_end: 0, missing_both: 0, zero_duration: 0,
    negative_duration: 0, duration_over_24_hours: 0, excluded_duration: 0 } };
  const groups = recorded ? [
    { ...row, kind: "summary", dimensions: {} },
    { ...row, kind: "weekday", dimensions: { weekday: 1 } },
    { ...row, kind: "daily", dimensions: { record_date: "2026-10-19" } },
    { ...row, kind: "weekly", dimensions: { week_start: "2026-10-19" } },
    { ...row, kind: "vehicle", dimensions: { vehicle_door_number: "M2012" } },
    ...(!specific ? [{ ...row, kind: "departure", dimensions: { day_offset: 0, departure_time: "07:35" } }] : [])
  ] : [];
  const days = ["2026-10-19", "2026-10-20"].map(date => ({ date, status: "success",
    last_success_at: "2026-10-26T15:20:00Z", matching_records: recorded, missing_arrivals: 0 }));
  return statisticsResponse(options, { groups, days, statuses: recorded ? [{ task_status: "T", count: recorded }] : [] }, now);
}

test("human-readable formatting preserves zero, missing observations and overnight times", () => {
  assert.equal(duration(6384, true), "1 sa 46 dk 24 sn");
  assert.equal(duration(null), "—");
  assert.equal(duration(0), "0 sn");
  assert.equal(deviation(-4), "−4 sn");
  assert.equal(deviation(1500), "+25 dk");
  assert.equal(clockLabel({ time: "00:05:30", day_offset: 1 }, true), "00:05:30 (+1 gün)");
  assert.equal(clockLabel(null), "—");
  assert.equal(escapeHtml('<img src="x">&'), "&lt;img src=&quot;x&quot;&gt;&amp;");
});

test("page dates follow Istanbul midnight and general queries always use planned departures", () => {
  assert.deepEqual(defaultDates(Date.parse("2026-10-25T21:01:00Z")), { from: "2026-09-26", to: "2026-10-25", max: "2026-10-25" });
  assert.equal(defaultDates(now, "2026-10-01").from, "2026-09-02");
  const params = queryParameters({ departure_time: "07:35", weekday: "1", bucket_minutes: "60", departure_basis: "planned" });
  assert.equal(params.has("bucket_minutes"), false);
  assert.equal(params.get("departure_time"), "07:35");
  const url = routePageUrl("THSS_G_DGR_Ümraniye(2)", params);
  assert.equal(decodeURIComponent(new URL(url, "http://localhost").pathname), "/routes/THSS_G_DGR_Ümraniye(2)/statistics");
  const general = queryParameters({ departure_time: "", bucket_minutes: "30", departure_basis: "actual" });
  assert.equal(general.has("bucket_minutes"), false);
  assert.equal(general.has("departure_basis"), false);
  assert.equal(queryParameters({ departure_time: "07:35", departure_basis: "actual" }).get("departure_basis"), "actual");
});

test("line options retain both directions, variants and Unicode without inventing routes", () => {
  const result = routeOptions({ directions: [
    { label: "Gidiş", variants: [{ code: "256_G_D0", name: "Normal" }, { code: "256_G_D0(2)", name: "Ek" }] },
    { label: "Dönüş", variants: [{ code: "256_D_D0" }, { code: "THSS_G_DGR_Ümraniye" }] }
  ] });
  assert.deepEqual(result.flatMap(group => group.variants.map(variant => variant.code)),
    ["256_G_D0", "256_G_D0(2)", "256_D_D0", "THSS_G_DGR_Ümraniye"]);
  assert.deepEqual(routeOptions({ warnings: ["unavailable"] }), []);
});

test("rendered statistics distinguish departure, general, empty and incomplete observations", () => {
  const specific = fixture();
  const html = renderStatistics(specific);
  assert.match(html, /Medyan varış/);
  assert.match(html, /Günlere göre varış/);
  assert.match(html, /data-clear-time>Tüm seferler/);
  assert.match(html, /Gözlem yok/);
  assert.match(html, /Örnek sayısı sınırlı/);
  assert.doesNotMatch(html, /NaN|undefined|Invalid Date/);
  const general = renderStatistics(fixture({ specific: false }));
  assert.match(general, /Planlanan seferler/);
  assert.match(general, /data-departure="07:35" data-day-offset="0"/);
  assert.doesNotMatch(general, /Kalkış saatlerine göre|07:00–08:00|NaN|undefined/);
  const empty = renderStatistics(fixture({ recorded: 0 }));
  assert.match(empty, /Eşleşen sefer yok/);
  assert.match(empty, /Tüm seferleri göster/);
  assert.match(empty, /Veri kapsamı/);
  specific.route_code = '<img src=x onerror="alert(1)">';
  const escaped = renderStatistics(specific, { routeDescription: "<script>attack</script>" });
  assert.doesNotMatch(escaped, /<img|<script>/);
  assert.match(escaped, /&lt;img/);
  const partial = fixture();
  partial.summary.arrival_time = { ...partial.summary.arrival_time, sample_count: 0, p50: null };
  const missing = renderStatistics(partial);
  assert.match(missing, /başlangıç\/bitiş gözlemi yok/);
});

test("trend charts leave missing dates as gaps instead of drawing fictitious observations", () => {
  const data = fixture();
  const first = data.trends.daily[0];
  const missing = data.trends.daily[1];
  data.trends.daily = [first, { ...missing, record_date: "2026-10-20" }, { ...first, record_date: "2026-10-21" }];
  const html = renderTrend(data);
  assert.equal((html.match(/class="plot-dot"/g) ?? []).length, 2);
  assert.equal((html.match(/<polyline/g) ?? []).length, 0);
});

test("departure rows preserve overnight selection and explain records with no usable plan", () => {
  const data = fixture({ specific: false });
  data.departures[0].departure_time = "00:30";
  data.departures[0].day_offset = 1;
  data.departures[0].arrival_time.p50 = null;
  data.quality.missing_reference_departure = 2;
  data.quality.reference_day_offset_anomaly = 1;
  const html = renderStatistics(data);
  assert.match(html, /data-departure="00:30" data-day-offset="1"/);
  assert.match(html, /Ertesi gün/);
  assert.match(html, /3 kayıt, planlanan kalkış saati eksik/);
  assert.doesNotMatch(html, /NaN|undefined/);
});

test("normal statistics pages and local assets are served without a database or upstream request", async t => {
  let calls = 0;
  const server = createApp({ service: { getIettRouteOptions: () => { calls++; } }, journeyService: {},
    statisticsService: { getStatistics: () => { calls++; } } }).listen(0, "127.0.0.1");
  await new Promise(resolve => server.once("listening", resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const base = `http://127.0.0.1:${server.address().port}`;
  for (const path of ["/statistics", "/routes/256_D_D0/statistics", `/routes/${encodeURIComponent("THSS_G_DGR_Ümraniye(2)")}/statistics`]) {
    const response = await fetch(base + path);
    assert.equal(response.status, 200);
    assert.match(response.headers.get("content-type"), /text\/html/);
    assert.match(await response.text(), /<html lang="tr">/);
  }
  for (const path of ["/assets/statistics.js", "/assets/statistics-view.js", "/assets/statistics-charts.js", "/assets/statistics-format.js", "/assets/statistics-chart-interactions.js", "/assets/statistics.css", "/assets/fonts/schibsted-grotesk.ttf"]) {
    assert.equal((await fetch(base + path)).status, 200);
  }
  assert.equal((await fetch(base + "/", { redirect: "manual" })).headers.get("location"), "/statistics");
  assert.equal((await fetch(base + "/assets/.env")).status, 404);
  assert.equal(calls, 0);
});
