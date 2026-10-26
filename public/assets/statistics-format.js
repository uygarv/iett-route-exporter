export const WEEKDAYS = ["Pazartesi", "Salı", "Çarşamba", "Perşembe", "Cuma", "Cumartesi", "Pazar"];
const dateFormatter = new Intl.DateTimeFormat("tr-TR", { day: "numeric", month: "short", timeZone: "UTC" });
const fullDateFormatter = new Intl.DateTimeFormat("tr-TR", { day: "numeric", month: "long", year: "numeric", timeZone: "UTC" });
const numberFormatter = new Intl.NumberFormat("tr-TR", { maximumFractionDigits: 1 });

export const escapeHtml = value => String(value ?? "").replace(/[&<>"']/g, char => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]);
export const number = value => Number.isFinite(value) ? numberFormatter.format(value) : "—";
export const percent = value => Number.isFinite(value) ? `%${number(value * 100)}` : "—";

export function duration(value, seconds = false) {
  if (!Number.isFinite(value)) return "—";
  const absolute = Math.round(Math.abs(value));
  const parts = [];
  if (absolute >= 3600) parts.push(`${Math.floor(absolute / 3600)} sa`);
  if (absolute >= 60) parts.push(`${Math.floor(absolute % 3600 / 60)} dk`);
  if (seconds && absolute % 60 || absolute < 60) parts.push(`${absolute % 60} sn`);
  return `${value < 0 ? "−" : ""}${parts.join(" ")}`;
}

export function deviation(value) {
  return value == null ? "—" : `${value > 0 ? "+" : ""}${duration(value, true)}`;
}

export function clockLabel(value, seconds = false) {
  if (!value?.time) return "—";
  const offset = value.day_offset ? ` (${value.day_offset > 0 ? "+" : ""}${value.day_offset} gün)` : "";
  return `${seconds ? value.time : value.time.slice(0, 5)}${offset}`;
}

export function dateLabel(value, full = false) {
  const date = new Date(`${value}T12:00:00Z`);
  return Number.isFinite(date.getTime()) ? (full ? fullDateFormatter : dateFormatter).format(date) : "—";
}

