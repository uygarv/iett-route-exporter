import { renderChartTooltip } from "./statistics-charts.js";

export function installChartInteractions(root, { onSeriesChange = () => {} } = {}) {
  let active;
  let tooltipId = 0;

  function hide(chart) {
    if (!chart) return;
    chart.querySelector(".chart-tooltip").hidden = true;
    chart.querySelector("[data-chart-crosshair]")?.setAttribute("hidden", "");
    active?.removeAttribute("aria-describedby");
    active = null;
  }

  function show(point) {
    const chart = point.closest("[data-chart]");
    if (active === point) return;
    if (active) hide(active.closest("[data-chart]"));
    active = point;
    const tip = chart.querySelector(".chart-tooltip");
    tip.id ||= `chart-tooltip-${++tooltipId}`;
    tip.innerHTML = renderChartTooltip(JSON.parse(point.dataset.chartTip));
    tip.hidden = false;
    point.setAttribute("aria-describedby", tip.id);
    const chartRect = chart.getBoundingClientRect(), pointRect = point.getBoundingClientRect();
    const x = pointRect.left - chartRect.left + pointRect.width / 2;
    const y = pointRect.top - chartRect.top;
    const maxLeft = Math.max(8, chartRect.width - tip.offsetWidth - 8);
    tip.style.left = `${Math.min(maxLeft, Math.max(8, x + 18 > maxLeft ? x - tip.offsetWidth - 18 : x + 18))}px`;
    tip.style.top = `${Math.max(8, Math.min(chartRect.height - tip.offsetHeight - 8, y + 24))}px`;
    const crosshair = chart.querySelector("[data-chart-crosshair]");
    if (crosshair) {
      crosshair.removeAttribute("hidden");
      const guide = crosshair.querySelector("line"), dot = crosshair.querySelector("circle");
      guide.setAttribute("x1", point.dataset.pointX);
      guide.setAttribute("x2", point.dataset.pointX);
      dot.setAttribute("cx", point.dataset.pointX);
      dot.setAttribute("cy", point.dataset.pointY || "0");
      dot.style.display = point.dataset.pointY ? "" : "none";
    }
  }

  root.addEventListener("pointermove", event => {
    const point = event.target.closest("[data-chart-tip]");
    if (point) show(point);
    else if (active && document.activeElement !== active) hide(active.closest("[data-chart]"));
  });
  root.addEventListener("pointerdown", event => {
    const point = event.target.closest("[data-chart-tip]");
    if (point) show(point);
    else if (active) hide(active.closest("[data-chart]"));
  });
  root.addEventListener("pointerleave", event => {
    if (event.pointerType !== "touch" && active && document.activeElement !== active) hide(active.closest("[data-chart]"));
  });
  root.addEventListener("pointercancel", () => { if (active) hide(active.closest("[data-chart]")); });
  root.addEventListener("focusin", event => {
    const point = event.target.closest("[data-chart-tip]");
    if (point) show(point);
  });
  root.addEventListener("focusout", event => {
    if (event.target.matches("[data-chart-tip]")) hide(event.target.closest("[data-chart]"));
  });
  root.addEventListener("keydown", event => {
    const point = event.target.closest("[data-chart-tip]");
    if (!point) return;
    const chart = point.closest("[data-chart]");
    if (event.key === "Escape") { hide(chart); event.preventDefault(); return; }
    if (!["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "Home", "End"].includes(event.key)) return;
    event.preventDefault();
    const points = [...chart.querySelectorAll("[data-chart-tip]")], index = points.indexOf(point);
    const next = event.key === "Home" ? 0 : event.key === "End" ? points.length - 1
      : Math.max(0, Math.min(points.length - 1, index + (["ArrowRight", "ArrowDown"].includes(event.key) ? 1 : -1)));
    points.forEach((item, i) => { item.tabIndex = i === next ? 0 : -1; });
    points[next].focus({ preventScroll: true });
  });
  root.addEventListener("click", event => {
    const button = event.target.closest("[data-chart-series]");
    if (!button) return;
    const name = button.dataset.chartSeries, chart = button.closest("[data-chart]");
    const enabled = button.getAttribute("aria-pressed") !== "true";
    button.setAttribute("aria-pressed", String(enabled));
    chart.dataset[name === "mean" ? "showMean" : "showRange"] = String(enabled);
    onSeriesChange(name, enabled);
  });
}
