import { AppError } from "../shared/errors.js";
import { localDate, formatTimestamp, TIME_ZONE } from "../journeys/time.js";

export { localDate, TIME_ZONE };

export function dateOnly(value, field = "date") {
  const timestamp = typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value)
    ? Date.parse(`${value}T00:00:00Z`) : NaN;
  if (!Number.isFinite(timestamp) || value.slice(0, 4) === "0000"
    || new Date(timestamp).toISOString().slice(0, 10) !== value) {
    throw new AppError(400, "INVALID_HISTORY_DATE", `${field} must be a valid YYYY-MM-DD date.`);
  }
  return value;
}

export function shiftDate(date, days) {
  return new Date(Date.parse(`${date}T00:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);
}

export function dateRange(from, to) {
  const dates = [];
  for (let date = from; date <= to; date = shiftDate(date, 1)) dates.push(date);
  return dates;
}

export function completedRange(from, to, now = Date.now()) {
  dateOnly(from, "from");
  dateOnly(to, "to");
  if (from > to || to >= localDate(now)) {
    throw new AppError(400, "INVALID_HISTORY_RANGE", "The range must be ordered and end before today in Europe/Istanbul.");
  }
  return { from, to };
}

export function importRange({ from, to, days = 30 } = {}, now = Date.now()) {
  if (!Number.isInteger(days) || days < 1 || days > 36500) throw new RangeError("days must be an integer between 1 and 36500.");
  to ??= shiftDate(localDate(now), -1);
  from ??= shiftDate(to, 1 - days);
  return completedRange(from, to, now);
}

export function archiveTimestamp(value) {
  if (typeof value !== "string") return null;
  const match = /^\/Date\((-?\d+)(?:[+-]\d{4})?\)\/$/.exec(value);
  if (!match) return null;
  const millis = Number(match[1]);
  return Number.isSafeInteger(millis) && Number.isFinite(new Date(millis).getTime())
    ? new Date(millis).toISOString() : null;
}

export function istanbulTimestamp(value) {
  return value == null ? null : formatTimestamp(new Date(value).getTime());
}
