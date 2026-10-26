import { WEEKDAYS, clockLabel, dateLabel, deviation, duration, escapeHtml, number, percent } from "./statistics-format.js";
import { renderTrendChart, renderWeekdayChart } from "./statistics-charts.js";
export { WEEKDAYS, clockLabel, dateLabel, deviation, duration, escapeHtml, number, percent } from "./statistics-format.js";
const DAY_TYPES = { weekday: "Hafta içi", saturday: "Cumartesi", sunday: "Pazar" };

export function defaultDates(now = Date.now(), end) {
  const today = new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Istanbul", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(now));
  const shift = (date, days) => new Date(Date.parse(`${date}T12:00:00Z`) + days * 86400000).toISOString().slice(0, 10);
  const yesterday = shift(today, -1);
  const to = end && /^\d{4}-\d{2}-\d{2}$/.test(end) && Number.isFinite(Date.parse(end)) ? end : yesterday;
  return { from: shift(to, -29), to, max: yesterday };
}

export function routeOptions(response) {
  const seen = new Set();
  return (response.directions ?? []).map(direction => ({
    label: direction.label || `${direction.start ?? ""} → ${direction.end ?? ""}`,
    variants: (direction.variants ?? []).filter(variant => {
      if (!variant.code || seen.has(variant.code)) return false;
      seen.add(variant.code);
      return true;
    }).map(variant => ({ code: variant.code, name: variant.name || "", start: variant.start, end: variant.end }))
  })).filter(direction => direction.variants.length);
}

export function queryParameters(values) {
  const params = new URLSearchParams();
  for (const name of ["from", "to", "departure_time", "departure_basis", "weekday", "departure_day_offset"]) {
    if (name === "departure_basis" && !values.departure_time) continue;
    if (values[name] !== "" && values[name] != null) params.set(name, values[name]);
  }
  return params;
}

export function routePageUrl(route, params) {
  return `/routes/${encodeURIComponent(route)}/statistics${params.size ? `?${params}` : ""}`;
}

const smallSample = metric => metric?.sample_count > 0 && metric.low_sample ? `${metric.sample_count} gözlem. Örnek sayısı sınırlı.` : "";
const countDescription = data => `${number(data.summary.service.recorded_trips)} sefer · ${number(data.summary.service.day_count)} gün · ${number(data.summary.service.active_vehicles)} araç`;
const receiptRow = (label, value) => `<div><dt>${escapeHtml(label)}</dt><dd>${escapeHtml(value)}</dd></div>`;

function overview(data) {
  const arrival = data.mode === "departure";
  const metric = arrival ? data.summary.arrival_time : data.summary.duration_seconds;
  let main = "—";
  if (arrival && metric.p50?.time) {
    main = `${escapeHtml(metric.p50.time.slice(0, 5))}<span class="seconds">:${escapeHtml(metric.p50.time.slice(6))}</span>`;
    if (metric.p50.day_offset) main += `<span class="unit offset-unit">${escapeHtml(metric.p50.day_offset > 0 ? "+" : "")}${number(metric.p50.day_offset)} gün</span>`;
  } else if (!arrival && metric.p50 != null) main = `${number(metric.p50 / 60)}<span class="unit">dk</span>`;
  const format = arrival ? value => clockLabel(value, true) : value => duration(value, true);
  const rows = [receiptRow("Ortalama", format(metric.mean)), receiptRow("%90 eşiği", format(metric.p90)),
    receiptRow(arrival ? "En erken" : "En kısa", format(metric.min)), receiptRow(arrival ? "En geç" : "En uzun", format(metric.max))];
  return `<section class="overview" aria-label="Genel sonuç">
    <dl class="main-metric"><dt>${arrival ? "Medyan varış" : "Medyan sefer süresi"}</dt><dd>${main}</dd></dl>
    <dl class="receipt">${rows.join("")}</dl>
  </section>`;
}

function weekdays(data) { return renderWeekdayChart(data); }

function trendTable(data, granularity) {
  const arrival = data.mode === "departure";
  return `<table><thead><tr><th>Tarih</th><th>Sefer</th>${arrival ? "<th>Medyan varış</th>" : ""}<th>Medyan süre</th><th class="wide-column">Kalkış sapması</th></tr></thead><tbody>${data.trends[granularity].map(row => {
    const date = row.record_date ? dateLabel(row.record_date) : `${dateLabel(row.week_start)}–${dateLabel(row.week_end)}`;
    const note = row.record_date ? (!row.archive_available ? "Arşiv eksik" : !row.service.recorded_trips ? "Eşleşme yok" : "") : row.partial_week ? "Kısmi hafta" : !row.coverage.complete ? "Arşiv eksik" : "";
    return `<tr><td>${escapeHtml(date)}${note ? `<span class="sub">${note}</span>` : ""}</td><td>${number(row.service.recorded_trips)}</td>${arrival ? `<td>${escapeHtml(clockLabel(row.arrival_time.p50, true))}</td>` : ""}<td>${escapeHtml(duration(row.duration_seconds.p50, true))}</td><td class="wide-column">${escapeHtml(deviation(row.departure_deviation_seconds.planned.p50))}</td></tr>`;
  }).join("")}</tbody></table>`;
}

export function renderTrend(data, granularity = "daily", width = 1000, options = {}) {
  return renderTrendChart(data, granularity, width, options);
}

function trends(data, granularity, width, options) {
  return `<section class="section" aria-labelledby="trend-heading"><div class="section-heading"><div><h2 id="trend-heading">Zaman içindeki değişim</h2><p>${data.mode === "departure" ? "Gözlenen varış saatleri." : "Gözlenen yolculuk süreleri."}</p></div>
    <div class="segmented" role="group" aria-label="Zaman grubu"><button type="button" data-trend="daily" aria-pressed="${granularity === "daily"}">Günlük</button><button type="button" data-trend="weekly" aria-pressed="${granularity === "weekly"}">Haftalık</button></div></div>
    <div class="plot-wrap" id="trend-plot">${renderTrend(data, granularity, width, options)}</div>
    <details class="data-details" id="trend-details"><summary>Tarihleri göster</summary><div class="table-wrap" id="trend-table"></div></details></section>`;
}

export function renderOperation(data, basis = "planned") {
  const metric = data.summary.departure_deviation_seconds[basis];
  const revisions = data.summary.plan_revision_seconds;
  const total = metric.sample_count;
  const bar = total ? `<div class="departure-bar" role="img" aria-label="${metric.on_time_count} zamanında, ${metric.late_count} geç, ${metric.early_count} erken kalkış"><span class="on-time" style="width:${metric.on_time_rate * 100}%"></span><span class="late" style="width:${metric.late_rate * 100}%"></span><span class="early" style="width:${metric.early_rate * 100}%"></span></div>` : '<p class="notice">Kalkış sapması için yeterli zaman kaydı yok.</p>';
  return `${bar}<dl class="operation-counts"><div><dt>Zamanında</dt><dd>${percent(metric.on_time_rate)}</dd></div><div><dt>Geç</dt><dd>${number(metric.late_count)} sefer</dd></div><div><dt>Erken</dt><dd>${number(metric.early_count)} sefer</dd></div></dl>
    <dl class="operation-details">${receiptRow("Medyan sapma", deviation(metric.p50))}${receiptRow("Ortalama sapma", deviation(metric.mean))}${receiptRow("Planı değişen", `${number(revisions.changed_count)} sefer`)}${receiptRow("Önceki seferle aralık", duration(data.summary.headway_seconds.p50, true))}</dl>
    <p class="field-note">±${data.rules.on_time_tolerance_seconds} saniye zamanında kabul edilir. ${number(total)} gözlem.</p>`;
}

function operations(data, basis) {
  return `<section class="section" aria-labelledby="operation-heading"><div class="section-heading"><div><h2 id="operation-heading">Kalkış düzeni</h2><p>Planlanan saate göre gerçekleşen kalkış.</p></div></div>
    <div class="segmented" role="group" aria-label="Sapma referansı"><button type="button" data-deviation="planned" aria-pressed="${basis === "planned"}">İlk plan</button><button type="button" data-deviation="adjusted" aria-pressed="${basis === "adjusted"}">Güncel plan</button></div>
    <div id="operation-metrics">${renderOperation(data, basis)}</div></section>`;
}

function coverage(data) {
  const c = data.coverage;
  const daily = data.trends.daily;
  const sync = c.last_successful_sync_at ? new Intl.DateTimeFormat("tr-TR", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit", timeZone: "Europe/Istanbul" }).format(new Date(c.last_successful_sync_at)) : "—";
  const cells = daily.map(row => {
    const kind = !row.archive_available ? "missing" : row.service.recorded_trips ? "has-trip" : "";
    const status = !row.archive_available ? "Arşiv eksik" : row.service.recorded_trips ? `${row.service.recorded_trips} eşleşen sefer` : "Eşleşen sefer yok";
    const label = `${dateLabel(row.record_date, true)}: ${status}`;
    return `<span class="coverage-day ${kind}" tabindex="0" title="${escapeHtml(label)}" aria-label="${escapeHtml(label)}">${Number(row.record_date.slice(-2))}</span>`;
  }).join("");
  return `<section class="section" id="coverage" aria-labelledby="coverage-heading"><div class="section-heading"><div><h2 id="coverage-heading">Veri kapsamı</h2><p>Başarıyla alınan arşiv günleri.</p></div></div>
    <p class="coverage-ratio">${number(c.successful_day_count)}<span> / ${number(c.requested_day_count)}</span></p>
    <div class="coverage-days" aria-label="Günlerin arşiv durumu">${cells}</div>
    <div class="coverage-legend"><span><i class="has-trip" aria-hidden="true"></i>Sefer var</span><span><i aria-hidden="true"></i>Eşleşme yok</span><span><i class="missing" aria-hidden="true"></i>Arşiv eksik</span></div>
    <p class="coverage-notes">${number(data.summary.service.eligible_durations)} kullanılabilir süre · ${number(data.quality.excluded_duration)} dışlanan kayıt<br>Son aktarım ${escapeHtml(sync)}</p>
    ${c.failed_dates.length || c.empty_dates.length ? `<p class="notice">${number(c.failed_dates.length)} hatalı, ${number(c.empty_dates.length)} boş arşiv yanıtı.</p>` : ""}
  </section>`;
}

function departures(data) {
  if (data.mode === "departure") return "";
  const rows = data.departures ?? [];
  const unassigned = (data.quality.missing_reference_departure ?? 0) + (data.quality.reference_day_offset_anomaly ?? 0);
  return `<section class="departure-list" aria-labelledby="departures-heading"><div class="section-heading"><div><h2 id="departures-heading">Planlanan seferler</h2><p>Her kalkış saati ayrı hesaplanır. Ayrıntılar için saati seçin.</p></div></div>
    ${rows.length ? `<table><thead><tr><th>Kalkış</th><th>Gözlem</th><th>Medyan varış</th><th>Medyan süre</th></tr></thead><tbody>${rows.map(row => `<tr><td><button type="button" class="departure-link" data-departure="${escapeHtml(row.departure_time)}" data-day-offset="${row.day_offset}">${escapeHtml(row.departure_time)}${row.day_offset ? '<span class="sub">Ertesi gün</span>' : ""}</button></td><td>${number(row.service.recorded_trips)}${row.service.low_sample ? "*" : ""}</td><td>${escapeHtml(clockLabel(row.arrival_time.p50))}</td><td>${escapeHtml(duration(row.duration_seconds.p50))}</td></tr>`).join("")}</tbody></table>` : '<p>Planlanan kalkış saatiyle eşleştirilebilen sefer yok.</p>'}
    ${rows.some(row => row.service.low_sample) ? '<p class="field-note">* Örnek sayısı sınırlı.</p>' : ""}
    ${unassigned ? `<p class="notice">${number(unassigned)} kayıt, planlanan kalkış saati eksik veya hizmet günüyle uyumsuz olduğu için listelenemedi.</p>` : ""}
  </section>`;
}

function vehicles(data) {
  const rows = [...data.vehicles].sort((a, b) => b.service.recorded_trips - a.service.recorded_trips);
  return `<details class="data-details"><summary>Araçlar · ${number(rows.length)}</summary><template><table><thead><tr><th>Kapı numarası</th><th>Sefer</th><th>Medyan süre</th><th class="wide-column">Toplam kayıtlı süre</th></tr></thead><tbody>${rows.map(row => `<tr><td>${escapeHtml(row.vehicle_door_number)}</td><td>${number(row.service.recorded_trips)}</td><td>${escapeHtml(duration(row.duration_seconds.p50, true))}</td><td class="wide-column">${escapeHtml(duration(row.service.recorded_duration_seconds))}</td></tr>`).join("")}</tbody></table></template><div data-detail-content></div></details>`;
}

function distributionTable(data) {
  const arrival = data.mode === "departure";
  const rows = [["Örnek sayısı", "sample_count"], ["Gün sayısı", "day_count"], ["Ortalama", "mean"], ["En küçük", "min"], ["%10", "p10"], ["%25", "p25"], ["Medyan", "p50"], ["%75", "p75"], ["%90", "p90"], ["%95", "p95"], ["En büyük", "max"], ["Standart sapma", "stddev"], ["Çeyrekler arası fark", "iqr"]];
  return `<table><thead><tr><th>Ölçü</th><th>Sefer süresi</th>${arrival ? "<th>Varış saati</th>" : ""}<th class="wide-column">Sefer aralığı</th></tr></thead><tbody>${rows.map(([label, key]) => {
    const count = key.endsWith("count");
    const format = value => count ? number(value) : duration(value, true);
    const arrivalKey = key === "stddev" || key === "iqr" ? `${key}_seconds` : key;
    const arrivalValue = data.summary.arrival_time?.[arrivalKey];
    return `<tr><td>${label}</td><td>${escapeHtml(format(data.summary.duration_seconds[key]))}</td>${arrival ? `<td>${escapeHtml(count ? number(arrivalValue) : key === "stddev" || key === "iqr" ? duration(arrivalValue, true) : clockLabel(arrivalValue, true))}</td>` : ""}<td class="wide-column">${escapeHtml(format(data.summary.headway_seconds[key]))}</td></tr>`;
  }).join("")}</tbody></table>`;
}

function details(data) {
  const reasons = [["Eksik başlangıç", "missing_start"], ["Eksik bitiş", "missing_end"], ["Başlangıç ve bitiş eksik", "missing_both"], ["Sıfır süre", "zero_duration"], ["Negatif süre", "negative_duration"], ["24 saatten uzun süre", "duration_over_24_hours"]];
  const before = data.quality.reference_departure_before_time_filter;
  return `<details class="data-details"><summary>Diğer istatistikler</summary><template>
    <p class="field-note">Medyan ortadaki değerdir. %90 eşiği geçmiş dağılımı gösterir. ${data.rules.low_sample_below.sample_count} gözlem veya ${data.rules.low_sample_below.day_count} günden azsa örnek sınırlıdır.</p>
    <div class="table-wrap">${distributionTable(data)}</div>
    <div class="detail-grid"><div><h3>Gün türleri</h3><table><thead><tr><th>Gün</th><th>Sefer</th><th>Medyan süre</th></tr></thead><tbody>${data.profiles.by_day_type.map(row => `<tr><td>${DAY_TYPES[row.day_type] ?? escapeHtml(row.day_type)}</td><td>${number(row.service.recorded_trips)}</td><td>${escapeHtml(duration(row.duration_seconds.p50))}</td></tr>`).join("")}</tbody></table></div>
    <div><h3>Kayıt kalitesi</h3><dl class="operation-details">${reasons.map(([label, key]) => receiptRow(label, number(data.quality[key]))).join("")}</dl></div></div>
    <div class="detail-grid"><div><h3>Plan değişiklikleri</h3><dl class="operation-details">${receiptRow("Değişen sefer", number(data.summary.plan_revision_seconds.changed_count))}${receiptRow("İleri alınan", number(data.summary.plan_revision_seconds.later_count))}${receiptRow("Geri alınan", number(data.summary.plan_revision_seconds.earlier_count))}${receiptRow("En büyük ileri değişim", duration(data.summary.plan_revision_seconds.max, true))}</dl></div>
    <div><h3>Kaynak durumları</h3><dl class="operation-details">${data.summary.task_status_counts.map(row => receiptRow(row.task_status ?? "Boş kod", `${number(row.count)} sefer`)).join("")}</dl></div></div>
    <p class="notice">Saat filtresinden önce ${number(before.recorded_trips)} kayıt. ${number(before.missing_count)} eksik kalkış, ${number(before.day_offset_anomaly_count)} beklenmeyen kalkış günü.</p>
  </template><div data-detail-content></div></details>`;
}

export function renderStatistics(data, { routeDescription = "", trend = "daily", deviationBasis = "planned", chartWidth = 1000, chartOptions = {} } = {}) {
  const specific = data.mode === "departure";
  const metric = specific ? data.summary.arrival_time : data.summary.duration_seconds;
  const reference = { planned: "planı", adjusted: "güncel planı", actual: "gerçek kalkışı" }[data.filters.departure_basis];
  const selection = [specific ? `${data.filters.departure_time} ${reference}` : "",
    data.filters.weekday ? WEEKDAYS[data.filters.weekday - 1] : "",
    data.filters.departure_day_offset === 1 ? "Ertesi gün kalkışı" : ""].filter(Boolean).join(" · ");
  const heading = `<div class="result-heading"><div><h2 class="route-title">${escapeHtml(data.route_code)}</h2>
    <p class="route-description"${routeDescription ? "" : " hidden"}>${escapeHtml(routeDescription)}</p>
    <p class="result-meta">${escapeHtml(dateLabel(data.from))} – ${escapeHtml(dateLabel(data.to, true))}${selection ? ` · ${escapeHtml(selection)}` : ""}<br>${escapeHtml(countDescription(data))}</p>${specific && data.summary.service.recorded_trips ? '<button type="button" class="text-button departure-back" data-clear-time>Tüm seferler</button>' : ""}</div>
    ${smallSample(metric) ? `<p class="sample-note">${escapeHtml(smallSample(metric))}</p>` : ""}</div>`;
  if (!data.summary.service.recorded_trips) {
    return `${heading}<section class="empty-state"><h2>Eşleşen sefer yok</h2><p>${specific ? `${escapeHtml(data.filters.departure_time)} için bu aralıkta kayıt bulunamadı. Kalkış saatini veya tarihleri değiştirebilirsiniz.` : "Bu güzergâh ve tarih aralığında kayıt bulunamadı."}</p>${specific ? '<button type="button" class="primary" data-clear-time>Tüm seferleri göster</button>' : ""}</section>${coverage(data)}`;
  }
  return `${heading}${specific ? overview(data) : departures(data)}${!metric.sample_count ? '<p class="notice">Eşleşen kayıtlar var; süre ve varış hesabına uygun başlangıç/bitiş gözlemi yok.</p>' : ""}
    ${weekdays(data)}${trends(data, trend, chartWidth, chartOptions)}
    <div class="support-grid">${operations(data, deviationBasis)}${coverage(data)}</div>
    ${vehicles(data)}${details(data)}`;
}

export function renderTrendTable(data, granularity) { return trendTable(data, granularity); }
