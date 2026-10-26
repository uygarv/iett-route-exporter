import { WEEKDAYS, clockLabel, dateLabel, duration, escapeHtml, number } from "./statistics-format.js";

const metricFor = (data, row) => data.mode === "departure" ? row.arrival_time : row.duration_seconds;
const valueFor = (data, metric, key) => data.mode === "departure" ? metric?.[key]?.seconds_from_service_midnight : metric?.[key];
const formatFor = (data, metric, key, seconds = false) => data.mode === "departure"
  ? clockLabel(metric?.[key], seconds) : duration(metric?.[key], seconds);
const position = value => Number(value.toFixed(3));

// Round ticks in seconds, retaining service-day offsets when the clock crosses midnight.
export function chartScale(values, arrival = false) {
  const finite = values.filter(Number.isFinite);
  if (!finite.length) return { min: 0, max: 3600, ticks: [0, 900, 1800, 2700, 3600] };
  const low = Math.min(...finite), high = Math.max(...finite);
  const padding = Math.max((high - low) * .12, 60);
  const lower = arrival ? low - padding : Math.max(0, low - padding);
  const upper = high + padding;
  const desired = (upper - lower) / 4;
  const step = [30, 60, 120, 300, 600, 900, 1800, 3600, 7200, 14400, 21600, 43200, 86400]
    .find(step => step >= desired && (!arrival || step >= 60)) ?? Math.ceil(desired / 86400) * 86400;
  const min = Math.floor(lower / step) * step, max = Math.ceil(upper / step) * step;
  return { min, max, ticks: Array.from({ length: Math.round((max - min) / step) + 1 }, (_, i) => min + i * step) };
}

function axisLabel(value, arrival) {
  if (!arrival) return `${number(value / 60)} dk`;
  const day = Math.floor(value / 86400), local = value - day * 86400;
  const time = [Math.floor(local / 3600), Math.floor(local % 3600 / 60)].map(v => String(v).padStart(2, "0")).join(":");
  return `${time}${day ? ` (${day > 0 ? "+" : ""}${day})` : ""}`;
}

function tipFor(data, row, title) {
  const metric = metricFor(data, row);
  const observed = metric?.sample_count > 0;
  return {
    title,
    rows: observed ? [
      ["Medyan", formatFor(data, metric, "p50", true)],
      ["Ortalama", formatFor(data, metric, "mean", true)],
      ["%25 – %75", `${formatFor(data, metric, "p25")} – ${formatFor(data, metric, "p75")}`],
      ["%10 – %90", `${formatFor(data, metric, "p10")} – ${formatFor(data, metric, "p90")}`],
      [data.mode === "departure" ? "En erken / en geç" : "En kısa / en uzun", `${formatFor(data, metric, "min")} – ${formatFor(data, metric, "max")}`],
      ["Std. sapma", duration(data.mode === "departure" ? metric.stddev_seconds : metric.stddev, true)],
      ["Gözlem", `${number(metric.sample_count)} sefer · ${number(metric.day_count)} gün`]
    ] : [["Durum", row.archive_available === false ? "Arşiv eksik" : row.service.recorded_trips ? "Uygun varış / süre gözlemi yok" : "Eşleşen sefer yok"]],
    note: observed && metric.low_sample ? "Örnek sayısı sınırlı." : ""
  };
}

function tipAttributes(tip, index, extra = "") {
  const label = [tip.title, ...tip.rows.map(([label, value]) => `${label}: ${value}`), tip.note].filter(Boolean).join(". ");
  return `data-chart-tip="${escapeHtml(JSON.stringify(tip))}" data-chart-index="${index}" tabindex="${index ? -1 : 0}" aria-label="${escapeHtml(label)}" ${extra}`;
}

function segments(rows, valid) {
  const groups = [];
  let current = [];
  rows.forEach((row, index) => {
    if (valid(row)) current.push({ row, index });
    else if (current.length) { groups.push(current); current = []; }
  });
  if (current.length) groups.push(current);
  return groups;
}

export function renderTrendChart(data, granularity = "daily", width = 1000, { mean = true, range = true } = {}) {
  const rows = data.trends[granularity];
  const arrival = data.mode === "departure";
  const observed = row => metricFor(data, row)?.sample_count > 0 && Number.isFinite(valueFor(data, metricFor(data, row), "p50"));
  if (!rows.some(observed)) return '<p class="empty-chart">Bu aralıkta grafiğe uygun gözlem yok.</p>';
  const w = Math.max(280, Math.min(1600, Number(width) || 1000)), h = w < 480 ? 360 : 400;
  const scale = chartScale(rows.filter(observed).flatMap(row => ["p10", "p90", "mean", "p50"].map(key => valueFor(data, metricFor(data, row), key))), arrival);
  const left = Math.ceil(Math.max(arrival ? 76 : 64, ...scale.ticks.map(tick => axisLabel(tick, arrival).length * 7.5 + 16)));
  const right = 18, top = 32, bottom = h - 144;
  const plotWidth = w - left - right, slot = plotWidth / rows.length;
  const x = i => position(left + slot * (i + .5));
  const y = value => position(top + (scale.max - value) / (scale.max - scale.min) * (bottom - top));
  const coord = (row, i, key) => `${x(i)},${y(valueFor(data, metricFor(data, row), key))}`;
  const bands = [["p10", "p90", "outer"], ["p25", "p75", "inner"]].map(([lo, hi, name]) =>
    segments(rows, row => observed(row) && [lo, hi].every(key => Number.isFinite(valueFor(data, metricFor(data, row), key)))).map(group => {
      if (group.length === 1) {
        const { row, index } = group[0], metric = metricFor(data, row);
        return `<rect class="chart-band ${name}" x="${x(index) - Math.min(slot * .3, 9)}" y="${y(valueFor(data, metric, hi))}" width="${Math.min(slot * .6, 18)}" height="${Math.max(1, y(valueFor(data, metric, lo)) - y(valueFor(data, metric, hi)))}"/>`;
      }
      const points = group.map(({ row, index }) => coord(row, index, hi)).concat([...group].reverse().map(({ row, index }) => coord(row, index, lo)));
      return `<polygon class="chart-band ${name}" points="${points.join(" ")}"/>`;
    }).join("")
  ).join("");
  const lines = [["p50", "plot-line"], ["mean", "chart-mean"]].map(([key, name]) =>
    segments(rows, row => observed(row) && Number.isFinite(valueFor(data, metricFor(data, row), key)))
      .filter(group => group.length > 1).map(group => `<polyline class="${name}" points="${group.map(({ row, index }) => coord(row, index, key)).join(" ")}"/>`).join("")
  ).join("");
  const countTop = h - 96, countHeight = 32, countBottom = countTop + countHeight;
  const maxCount = Math.max(...rows.map(row => metricFor(data, row)?.sample_count ?? 0), 1);
  const counts = rows.map((row, i) => {
    const count = metricFor(data, row)?.sample_count ?? 0;
    if (!count) return "";
    const height = Math.max(2, count / maxCount * countHeight);
    return `<rect class="chart-count" x="${position(x(i) - Math.min(slot * .3, 12))}" y="${position(countBottom - height)}" width="${position(Math.min(slot * .6, 24))}" height="${position(height)}"/>`;
  }).join("");
  const grid = scale.ticks.map(tick => `<line class="chart-grid" x1="${left}" x2="${w - right}" y1="${y(tick)}" y2="${y(tick)}"/><text class="chart-axis-label" x="${left - 12}" y="${y(tick) + 5}" text-anchor="end">${escapeHtml(axisLabel(tick, arrival))}</text>`).join("");
  const tickCount = w < 480 ? 3 : w < 800 ? 5 : 7;
  const indexes = [...new Set(Array.from({ length: Math.min(tickCount, rows.length) }, (_, i) => Math.round(i * (rows.length - 1) / Math.max(1, Math.min(tickCount, rows.length) - 1))))];
  const dates = indexes.map(i => `<text class="chart-axis-label" x="${x(i)}" y="${h - 35}" text-anchor="${i === 0 ? "start" : i === rows.length - 1 ? "end" : "middle"}">${escapeHtml(dateLabel(rows[i].record_date ?? rows[i].week_start))}</text>`).join("");
  const dots = rows.map((row, i) => observed(row) ? `<circle class="plot-dot" cx="${x(i)}" cy="${y(valueFor(data, metricFor(data, row), "p50"))}" r="4"/>` : "").join("");
  const hits = rows.map((row, i) => {
    const date = row.record_date ? dateLabel(row.record_date, true) : `${dateLabel(row.week_start)} – ${dateLabel(row.week_end, true)}`;
    const tip = tipFor(data, row, date);
    if (row.partial_week) tip.note = [tip.note, "Kısmi hafta."].filter(Boolean).join(" ");
    const pointY = observed(row) ? y(valueFor(data, metricFor(data, row), "p50")) : "";
    return `<g class="chart-hit" role="img" ${tipAttributes(tip, i, `data-point-x="${x(i)}" data-point-y="${pointY}"`)}><rect x="${position(left + i * slot)}" y="${top}" width="${position(slot)}" height="${countBottom - top}" fill="transparent"/><title>${escapeHtml(date)}</title></g>`;
  }).join("");
  const missing = rows.map((row, i) => !observed(row) ? `<rect class="chart-missing" x="${position(left + i * slot)}" y="${top}" width="${position(slot)}" height="${bottom - top}"/>` : "").join("");
  return `<div class="chart-surface" data-chart data-show-mean="${mean}" data-show-range="${range}" data-ui>
    <div class="chart-toolbar"><div class="chart-key"><span><i class="median"></i>Medyan</span><button type="button" data-chart-series="mean" aria-pressed="${mean}"><i class="mean"></i>Ortalama</button><button type="button" data-chart-series="range" aria-pressed="${range}"><i class="band"></i>%10–90 / %25–75</button></div><span class="chart-unit">${arrival ? "İstanbul saati" : "Süre · dakika"}</span></div>
    <svg viewBox="0 0 ${w} ${h}" role="group" aria-labelledby="trend-chart-title trend-chart-desc"><title id="trend-chart-title">${arrival ? "Medyan varış saatlerinin" : "Medyan sefer sürelerinin"} ${granularity === "daily" ? "günlük" : "haftalık"} değişimi</title><desc id="trend-chart-desc">Medyan, ortalama ve geçmiş gözlemlerin yüzdelik aralıkları. Alt çubuklar uygun gözlem sayılarını gösterir. Tarihleri ok tuşlarıyla inceleyin. Gözlem olmayan günler boş bırakılır.</desc>
      ${missing}${grid}${bands}${lines}${dots}
      <text class="chart-axis-label" x="${left}" y="${countTop - 12}">Gözlem</text><text class="chart-axis-label" x="${w - right}" y="${countTop - 12}" text-anchor="end">en çok ${number(maxCount)}</text>${counts}${dates}
      <g data-chart-crosshair hidden aria-hidden="true"><line class="chart-crosshair" y1="${top}" y2="${countBottom}"/><circle class="chart-active-dot" r="6"/></g>${hits}
    </svg><div class="chart-tooltip" role="tooltip" hidden></div>
    <p class="chart-footnote">Bantlar geçmiş dağılımı gösterir. Gözlemsiz tarihler boş bırakılır.</p>
  </div>`;
}

export function renderWeekdayChart(data) {
  const rows = data.profiles.by_weekday, arrival = data.mode === "departure";
  const scale = chartScale(rows.filter(row => metricFor(data, row)?.sample_count).flatMap(row => ["p10", "p90", "mean", "p50"].map(key => valueFor(data, metricFor(data, row), key))), arrival);
  const at = value => position(Math.max(0, Math.min(100, (value - scale.min) / (scale.max - scale.min) * 100)));
  const grids = scale.ticks.map(value => `<span class="range-grid" style="left:${at(value)}%"></span>`).join("");
  return `<section class="section weekday-layout" aria-labelledby="weekday-heading"><div class="section-heading"><div><h2 id="weekday-heading">Günlere göre ${arrival ? "varış" : "süre"}</h2><p>Her günün dağılımı. Gün adına basarak filtreleyin.</p></div>
    <div class="chart-key"><span><i class="band"></i>%25–75</span><span><i class="whisker"></i>%10–90</span><span><i class="median"></i>Medyan</span><span><i class="mean"></i>Ortalama</span></div></div>
    <div class="weekday-rows" data-chart data-ui><div class="weekday-columns" aria-hidden="true"><span>Gün</span><span>Dağılım</span><span>Medyan / %90</span><span>Gözlem</span></div>
    ${rows.map((row, i) => {
      const metric = metricFor(data, row), valid = metric?.sample_count > 0;
      const val = key => at(valueFor(data, metric, key));
      const track = valid ? `<span class="range-whisker" style="left:${val("p10")}%;width:${val("p90") - val("p10")}%"></span><span class="range-band" style="left:${val("p25")}%;width:${Math.max(val("p75") - val("p25"), .3)}%"></span><span class="range-median" style="left:${val("p50")}%"></span><span class="range-mean" style="left:${val("mean")}%"></span>` : "";
      return `<div class="weekday-row${valid ? "" : " no-observation"}"><button type="button" data-weekday="${row.weekday}" aria-pressed="${data.filters.weekday === row.weekday}">${WEEKDAYS[row.weekday - 1]}</button><div class="range-track" role="img" ${tipAttributes(tipFor(data, row, WEEKDAYS[row.weekday - 1]), i)}>${grids}${track}</div>
        <div class="weekday-number">${escapeHtml(formatFor(data, metric, "p50"))}<span>${valid ? `%90 ${escapeHtml(formatFor(data, metric, "p90"))}` : "Gözlem yok"}</span></div><span class="weekday-count">${number(metric.sample_count)}${valid && metric.low_sample ? "*" : ""}</span></div>`;
    }).join("")}
    <div class="weekday-axis" aria-hidden="true">${scale.ticks.map(tick => `<span style="left:${at(tick)}%">${escapeHtml(axisLabel(tick, arrival))}</span>`).join("")}</div>
    ${rows.some(row => metricFor(data, row)?.sample_count && metricFor(data, row).low_sample) ? '<p class="field-note">* Gün bazında örnek sayısı sınırlı.</p>' : ""}
    <div class="chart-tooltip" role="tooltip" hidden></div></div></section>`;
}

export function renderChartTooltip(tip) {
  return `<strong>${escapeHtml(tip.title)}</strong><dl>${tip.rows.map(([label, value]) => `<div><dt>${escapeHtml(label)}</dt><dd>${escapeHtml(value)}</dd></div>`).join("")}</dl>${tip.note ? `<p>${escapeHtml(tip.note)}</p>` : ""}`;
}
