import assert from "node:assert/strict";
import test from "node:test";
import { chartScale, renderChartTooltip, renderTrendChart, renderWeekdayChart } from "../public/assets/statistics-charts.js";

const metric = (count = 2) => ({ sample_count: count, day_count: 1, low_sample: true,
  min: 2400, p10: 2700, p25: 3000, p50: 3300, mean: 3420, p75: 3600, p90: 3900, max: 4200 });
function data() {
  const row = { service: { recorded_trips: 9 }, duration_seconds: metric(), archive_available: true };
  return { mode: "general", filters: { weekday: null }, profiles: { by_weekday: [{ ...row, weekday: 1 }] },
    trends: { daily: [{ ...row, record_date: "2026-10-19" }, { ...row, record_date: "2026-10-20" }],
      weekly: [{ ...row, week_start: "2026-10-19", week_end: "2026-10-25", partial_week: true }] } };
}

test("chart scales cover midnight and constant observations without wrapping or negative durations", () => {
  const overnight = chartScale([86340, 86700], true);
  assert.ok(overnight.min <= 86340 && overnight.max >= 86700);
  assert.ok(overnight.ticks.includes(86400));
  const constantArrival = chartScale([86700, 86700], true);
  assert.ok(constantArrival.ticks[1] - constantArrival.ticks[0] >= 60);
  for (const values of [[0], [3300, 3300], []]) {
    const scale = chartScale(values);
    assert.ok(scale.min >= 0 && scale.max > scale.min);
    assert.ok(scale.ticks.every(Number.isFinite));
  }
});

test("trend bands, means and observation counts use eligible samples rather than recorded trips", () => {
  const html = renderTrendChart(data(), "daily", 1000, { mean: false, range: true });
  assert.match(html, /chart-band outer/);
  assert.match(html, /chart-band inner/);
  assert.match(html, /chart-mean/);
  assert.match(html, /data-show-mean="false" data-show-range="true"/);
  assert.match(html, /en çok 2<\/text>/);
  assert.match(html, /2 sefer · 1 gün/);
  assert.doesNotMatch(html, /9 sefer · 1 gün|NaN|undefined/);
});

test("missing days break every line and distribution band and remain inspectable", () => {
  const d = data(), row = d.trends.daily[0];
  d.trends.daily = [row, { ...row, record_date: "2026-10-20", archive_available: false,
    duration_seconds: { sample_count: 0 } }, { ...row, record_date: "2026-10-21" }];
  const html = renderTrendChart(d);
  assert.doesNotMatch(html, /<polyline|<polygon/);
  assert.equal((html.match(/class="plot-dot"/g) ?? []).length, 2);
  assert.equal((html.match(/data-chart-index=/g) ?? []).length, 3);
  assert.match(html, /Arşiv eksik/);
  assert.match(html, /chart-missing/);
});

test("weekday charts expose percentiles, average, low samples and the real weekday filter", () => {
  const html = renderWeekdayChart(data());
  assert.match(html, /range-whisker/);
  assert.match(html, /range-median/);
  assert.match(html, /range-mean/);
  assert.match(html, /data-weekday="1"/);
  assert.match(html, /%25 – %75/);
  assert.match(html, /Örnek sayısı sınırlı/);
  assert.doesNotMatch(html, /NaN|undefined/);
});

test("overnight arrival labels retain service-day offsets and weekly tips mark partial weeks", () => {
  const d = data();
  const clock = seconds => ({ time: `00:${String(Math.floor((seconds - 86400) / 60)).padStart(2, "0")}:00`, day_offset: 1, seconds_from_service_midnight: seconds });
  const arrival = { sample_count: 2, day_count: 1, low_sample: true,
    ...Object.fromEntries(["min", "p10", "p25", "p50", "mean", "p75", "p90", "max"].map(key => [key, clock(86700)])) };
  d.mode = "departure";
  d.trends.weekly[0].arrival_time = arrival;
  const html = renderTrendChart(d, "weekly", 330);
  assert.match(html, /00:05:00 \(\+1 gün\)/);
  assert.match(html, /Kısmi hafta/);
  assert.match(html, /İstanbul saati/);
  const tip = renderChartTooltip({ title: '<img src=x onerror="alert(1)">', rows: [["Medyan", "<script>bad</script>"]], note: "" });
  assert.doesNotMatch(tip, /<img|<script>/);
  assert.match(tip, /&lt;img/);
});
