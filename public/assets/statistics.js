import { WEEKDAYS, defaultDates, escapeHtml, queryParameters, renderOperation, renderStatistics,
  renderTrend, renderTrendTable, routeOptions, routePageUrl } from "./statistics-view.js";
import { installChartInteractions } from "./statistics-chart-interactions.js";

const byId = id => document.getElementById(id);
const form = byId("statistics-form");
const results = byId("results");
const routeSelect = byId("route-select");
const routeInput = byId("route-code");
const lineInput = byId("line-code");
const status = byId("request-status");
const lineStatus = byId("line-status");
const toggle = byId("manual-toggle");
const inputNames = ["departure_time", "from", "to", "weekday", "departure_basis", "departure_day_offset"];
let manual = false;
let groups = [];
let loadedLine = "";
let data = null;
let routeController;
let statisticsController;
let discoveryVersion = 0;
let requestVersion = 0;
let deviationBasis = "planned";
let trend = "daily";
const chartOptions = { mean: true, range: true };
let pendingQuery = "";

const currentRoute = () => (manual ? routeInput.value : routeSelect.value).trim();
const validCode = value => value.length > 0 && value.length <= 100 && !/[\u0000-\u001f\u007f]/.test(value);
const values = () => Object.fromEntries(inputNames.map(name => [name, form.elements.namedItem(name).value]));
const chartWidth = () => Math.max(280, results.clientWidth - (window.innerWidth <= 650 ? 20 : 56));

function announce(message, kind = "info") {
  status.textContent = message;
  status.dataset.kind = kind;
  status.hidden = !message;
  status.setAttribute("role", kind === "error" ? "alert" : "status");
}

function announceLine(message) {
  lineStatus.textContent = message;
  lineStatus.hidden = !message;
}

function setManual(enabled, { focus = false } = {}) {
  if (enabled && !manual) routeInput.value = routeSelect.value || routeInput.value;
  manual = enabled;
  routeInput.hidden = !enabled;
  routeInput.disabled = !enabled;
  routeSelect.hidden = enabled;
  routeSelect.disabled = enabled;
  byId("route-label").htmlFor = enabled ? "route-code" : "route-select";
  toggle.setAttribute("aria-pressed", String(enabled));
  toggle.textContent = enabled ? "Listeden seç" : "Kodu elle gir";
  if (focus) (enabled ? routeInput : routeSelect).focus();
}

function updateDepartureBasis() {
  const specific = Boolean(byId("departure-time").value);
  byId("departure-basis").disabled = !specific;
  byId("departure-basis").closest(".field").hidden = !specific;
}

function routeDescription(route) {
  for (const group of groups) {
    const variant = group.variants.find(option => option.code === route);
    if (variant) {
      const titleCase = text => (text ?? "").toLocaleLowerCase("tr-TR").replace(/(^|\s)\S/g, letter => letter.toLocaleUpperCase("tr-TR"));
      return variant.start && variant.end ? `${titleCase(variant.start)} → ${titleCase(variant.end)}` : group.label;
    }
  }
  return "";
}

function paint() {
  if (!data) return;
  results.innerHTML = renderStatistics(data, { routeDescription: routeDescription(data.route_code), deviationBasis, trend, chartWidth: chartWidth(), chartOptions });
  byId("coverage-link").hidden = false;
}

async function getJson(url, controller) {
  const timeout = setTimeout(() => controller.abort(new DOMException("Request timed out", "TimeoutError")), 45000);
  try {
    const response = await fetch(url, { signal: controller.signal, headers: { Accept: "application/json" } });
    let body;
    try { body = await response.json(); }
    catch { throw new Error("Sunucu yanıtı okunamadı. Sayfayı yenileyip tekrar deneyin."); }
    if (!response.ok) {
      const code = body.error?.code;
      const message = code === "STATISTICS_QUERY_TIMEOUT" ? "Sorgu uzun sürdü. Daha kısa bir tarih aralığı seçin."
        : response.status === 503 ? "Arşiv veritabanına şu anda ulaşılamıyor."
          : response.status === 400 ? "Filtreleri kontrol edin. Tarihler tamamlanmış günleri kapsamalı."
            : "Veriler alınamadı. Tekrar deneyin.";
      throw new Error(message);
    }
    return body;
  } finally { clearTimeout(timeout); }
}

function handleError(error, controller) {
  if (controller.signal.aborted && controller.signal.reason?.name !== "TimeoutError") return null;
  if (controller.signal.reason?.name === "TimeoutError") return "Yanıt beklenenden uzun sürdü. Tekrar deneyin.";
  return error instanceof TypeError ? "Sunucuya ulaşılamadı. Bağlantınızı kontrol edin." : error.message;
}

async function loadStatistics({ historyMode = "push" } = {}) {
  const route = currentRoute();
  if (!validCode(route)) {
    byId("filter-panel").open = true;
    announce("Bir güzergâh seçin veya geçerli bir güzergâh kodu girin.", "error");
    (manual ? routeInput : routeSelect).focus();
    return;
  }
  const inferredLine = route.split("_")[0];
  if (manual && inferredLine !== lineInput.value.trim() && validCode(inferredLine)) {
    lineInput.value = inferredLine;
    void discoverLine({ selectFirst: false, preserveRoute: route });
  }
  if (!form.checkValidity()) {
    byId("filter-panel").open = true;
    announce("Geçerli bir tarih aralığı seçin.", "error");
    form.reportValidity();
    return;
  }
  const params = queryParameters(values());
  byId("filter-summary").textContent = [route, params.get("departure_time"), params.get("weekday") ? WEEKDAYS[Number(params.get("weekday")) - 1] : ""].filter(Boolean).join(" · ");
  const api = `/api/iett/routes/${encodeURIComponent(route)}/statistics?${params}`;
  if (pendingQuery === api) return;
  pendingQuery = api;
  const page = routePageUrl(route, params);
  statisticsController?.abort();
  const controller = new AbortController();
  statisticsController = controller;
  const version = ++requestVersion;
  results.setAttribute("aria-busy", "true");
  byId("show-statistics").disabled = true;
  announce("İstatistikler yükleniyor…");
  if (historyMode === "replace") window.history.replaceState(null, "", page);
  else if (historyMode === "push" && `${location.pathname}${location.search}` !== page) window.history.pushState(null, "", page);
  byId("api-link").href = api;
  byId("api-link").hidden = false;
  try {
    const result = await getJson(api, controller);
    if (version !== requestVersion) return;
    if (!result?.summary?.service || !result.profiles || !result.trends || !result.coverage) throw new Error("İstatistik yanıtı eksik. Tekrar deneyin.");
    data = result;
    document.title = `${route}${result.filters.departure_time ? ` · ${result.filters.departure_time}` : ""} · Sefer istatistikleri`;
    paint();
    announce("");
  } catch (error) {
    if (version !== requestVersion) return;
    const message = handleError(error, controller);
    if (message) {
      data = null;
      results.innerHTML = '<section class="empty-state"><h2>Veriler gösterilemedi</h2><p>Filtreleri düzenleyip yeniden deneyebilirsiniz.</p><button type="button" class="primary" data-retry>Tekrar dene</button></section>';
      byId("coverage-link").hidden = true;
      announce(message, "error");
    }
  } finally {
    if (version === requestVersion) {
      pendingQuery = "";
      results.setAttribute("aria-busy", "false");
      byId("show-statistics").disabled = false;
    }
  }
}

async function discoverLine({ selectFirst = true, preserveRoute = currentRoute() } = {}) {
  const line = lineInput.value.trim().toUpperCase();
  if (!validCode(line)) {
    announceLine("Geçerli bir hat numarası girin.");
    lineInput.focus();
    return;
  }
  lineInput.value = line;
  routeController?.abort();
  const controller = new AbortController();
  routeController = controller;
  const version = ++discoveryVersion;
  byId("find-line").disabled = true;
  announceLine("Güzergâhlar yükleniyor…");
  try {
    const response = await getJson(`/api/iett/lines/${encodeURIComponent(line)}`, controller);
    if (version !== discoveryVersion) return;
    groups = routeOptions(response);
    loadedLine = line;
    const available = groups.flatMap(group => group.variants);
    routeSelect.innerHTML = '<option value="">Güzergâh seçin</option>' + groups.map(group => `<optgroup label="${escapeHtml(group.label)}">${group.variants.map(variant => `<option value="${escapeHtml(variant.code)}">${escapeHtml(variant.code)}${variant.name ? ` · ${escapeHtml(variant.name)}` : ""}</option>`).join("")}</optgroup>`).join("");
    const selection = selectFirst ? preserveRoute : currentRoute();
    const known = available.some(variant => variant.code === selection);
    if (known) {
      routeSelect.value = selection;
      if (!manual || !selectFirst) setManual(false);
    } else if (selectFirst && available.length && !manual) {
      routeSelect.value = available[0].code;
    }
    if (!available.length) announceLine("Güzergâh bulunamadı. Kodu elle girebilirsiniz.");
    else if (response.warnings?.length) announceLine("Bazı güzergâhlar alınamadı. Eksik kodu elle girebilirsiniz.");
    else announceLine("");
    if (!selectFirst) {
      const description = results.querySelector(".route-description");
      if (data && description) {
        description.textContent = routeDescription(data.route_code);
        description.hidden = !description.textContent;
      }
    } else if (!manual && routeSelect.value) await loadStatistics();
  } catch (error) {
    if (version !== discoveryVersion) return;
    const message = handleError(error, controller);
    if (message) {
      groups = [];
      loadedLine = "";
      routeSelect.innerHTML = '<option value="">Güzergâhlar alınamadı</option>';
      announceLine("Güzergâh listesi alınamadı. Kodu elle girerek arşivi sorgulayabilirsiniz.");
      if (!manual) setManual(true);
    }
  } finally {
    if (version === discoveryVersion) byId("find-line").disabled = false;
  }
}

function restoreLocation() {
  statisticsController?.abort();
  routeController?.abort();
  requestVersion++;
  pendingQuery = "";
  discoveryVersion++;
  byId("find-line").disabled = false;
  byId("show-statistics").disabled = false;
  results.setAttribute("aria-busy", "false");
  const params = new URLSearchParams(location.search);
  const defaults = defaultDates(Date.now(), params.get("to"));
  let route = params.get("route_code") ?? "";
  try { route = decodeURIComponent(/^\/routes\/([^/]+)\/statistics\/?$/.exec(location.pathname)?.[1] ?? route); }
  catch { route = ""; }
  const defaultsByName = { from: defaults.from, to: defaults.to, departure_time: "", departure_basis: "planned", weekday: "", departure_day_offset: "" };
  for (const name of inputNames) form.elements.namedItem(name).value = params.get(name) ?? defaultsByName[name];
  byId("date-from").max = defaults.max;
  byId("date-to").max = defaults.max;
  lineInput.value = params.get("line") ?? route.split("_")[0];
  setManual(Boolean(route));
  routeInput.value = route;
  byId("filter-panel").open = !route || !window.matchMedia("(max-width: 650px)").matches;
  updateDepartureBasis();
  deviationBasis = "planned";
  trend = "daily";
  announce("");
  if (route) {
    void loadStatistics({ historyMode: "replace" });
    if (validCode(lineInput.value.trim())) void discoverLine({ selectFirst: false, preserveRoute: route });
  } else {
    groups = [];
    loadedLine = "";
    routeSelect.innerHTML = '<option value="">Önce hat numarası girin</option>';
    announceLine("");
    data = null;
    results.innerHTML = '<section class="initial-state"><h2>Bir güzergâh seçin</h2><p>Hat numarasıyla arayın veya güzergâh kodunu girin.</p></section>';
    byId("coverage-link").hidden = true;
    byId("api-link").hidden = true;
    if (lineInput.value.trim()) void discoverLine();
  }
}

form.addEventListener("submit", event => {
  event.preventDefault();
  if (!currentRoute() && lineInput.value.trim() && !manual) void discoverLine();
  else void loadStatistics();
});
byId("find-line").addEventListener("click", () => {
  if (lineInput.value.trim().toUpperCase() !== loadedLine) setManual(false);
  void discoverLine({ preserveRoute: "" });
});
lineInput.addEventListener("keydown", event => {
  if (event.key === "Enter") {
    event.preventDefault();
    if (lineInput.value.trim().toUpperCase() !== loadedLine) setManual(false);
    void discoverLine({ preserveRoute: "" });
  }
});
toggle.addEventListener("click", () => {
  setManual(!manual, { focus: true });
  if (!manual && routeSelect.value) void loadStatistics();
});
routeSelect.addEventListener("change", () => { if (routeSelect.value) void loadStatistics(); });
routeInput.addEventListener("change", () => { if (manual && routeInput.value.trim()) void loadStatistics(); });
byId("departure-time").addEventListener("input", updateDepartureBasis);
results.addEventListener("click", event => {
  const button = event.target.closest("button");
  if (!button) return;
  if (button.hasAttribute("data-weekday")) {
    byId("weekday").value = byId("weekday").value === button.dataset.weekday ? "" : button.dataset.weekday;
    void loadStatistics();
  } else if (button.hasAttribute("data-clear-time")) {
    byId("departure-time").value = "";
    byId("day-offset").value = "";
    updateDepartureBasis();
    void loadStatistics();
  } else if (button.hasAttribute("data-departure")) {
    byId("departure-time").value = button.dataset.departure;
    byId("departure-basis").value = "planned";
    byId("day-offset").value = button.dataset.dayOffset;
    updateDepartureBasis();
    void loadStatistics();
  } else if (button.hasAttribute("data-retry")) void loadStatistics();
  else if (button.dataset.deviation && data) {
    deviationBasis = button.dataset.deviation;
    document.querySelectorAll("[data-deviation]").forEach(item => item.setAttribute("aria-pressed", String(item.dataset.deviation === deviationBasis)));
    byId("operation-metrics").innerHTML = renderOperation(data, deviationBasis);
  } else if (button.dataset.trend && data) {
    trend = button.dataset.trend;
    document.querySelectorAll("[data-trend]").forEach(item => item.setAttribute("aria-pressed", String(item.dataset.trend === trend)));
    byId("trend-plot").innerHTML = renderTrend(data, trend, chartWidth(), chartOptions);
    if (byId("trend-details").open) byId("trend-table").innerHTML = renderTrendTable(data, trend);
  }
});
results.addEventListener("toggle", event => {
  const detail = event.target;
  if (!(detail instanceof HTMLDetailsElement)) return;
  if (detail.id === "trend-details") {
    byId("trend-table").innerHTML = detail.open && data ? renderTrendTable(data, trend) : "";
    return;
  }
  const template = detail.querySelector(":scope > template");
  const content = detail.querySelector(":scope > [data-detail-content]");
  if (template && content) content.replaceChildren(...(detail.open ? [template.content.cloneNode(true)] : []));
}, true);
window.addEventListener("popstate", restoreLocation);
window.matchMedia("(max-width: 650px)").addEventListener("change", event => {
  if (!event.matches) byId("filter-panel").open = true;
});
let resizeFrame;
window.addEventListener("resize", () => {
  cancelAnimationFrame(resizeFrame);
  resizeFrame = requestAnimationFrame(() => {
    if (data && byId("trend-plot")) byId("trend-plot").innerHTML = renderTrend(data, trend, chartWidth(), chartOptions);
  });
});
installChartInteractions(results, { onSeriesChange: (name, enabled) => { chartOptions[name] = enabled; } });
restoreLocation();
