import { AppError } from "../shared/errors.js";

export const TIME_ZONE = "Europe/Istanbul";

const formatter = new Intl.DateTimeFormat("en-CA", {
  timeZone: TIME_ZONE,
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
  hourCycle: "h23"
});

function parts(timestamp) {
  return Object.fromEntries(formatter.formatToParts(timestamp)
    .filter(part => part.type !== "literal")
    .map(part => [part.type, part.value]));
}

export function localDate(timestamp) {
  const { year, month, day } = parts(timestamp);
  return `${year}-${month}-${day}`;
}

export function normalizeDate(value) {
  const match = typeof value === "string" && value.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  const timestamp = match ? Date.parse(`${value}T12:00:00Z`) : NaN;

  if (!Number.isFinite(timestamp) || new Date(timestamp).toISOString().slice(0, 10) !== value) {
    throw new AppError(400, "INVALID_DATE", "date must be a valid YYYY-MM-DD date.");
  }

  return value;
}

export function normalizeTime(value, field = "departure") {
  const match = typeof value === "string" && value.trim().match(/^(\d{1,2})[.:](\d{2})$/);

  if (!match || Number(match[1]) > 23 || Number(match[2]) > 59) {
    throw new AppError(400, "INVALID_TIME", `${field} must be a time such as 08:15 or 8.15.`);
  }

  return `${match[1].padStart(2, "0")}:${match[2]}`;
}

export function parseTimeInput(value, field = "departure") {
  const trimmed = typeof value === "string" ? value.trim() : "";
  if (!trimmed.includes("T") && !trimmed.includes("t")) {
    return { time: normalizeTime(value, field), timestamp: null };
  }
  const match = trimmed.match(
    /^(\d{4}-\d{2}-\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,9}))?)?(Z|[+-]\d{2}:\d{2})?$/i
  );
  if (!match) {
    throw new AppError(400, "INVALID_TIME", `${field} must be a clock time or an ISO date-time.`);
  }
  const [, date, hour, minute, second = "00", fraction = "", offset] = match;
  normalizeDate(date);
  const time = normalizeTime(`${hour}:${minute}`, field);
  if (Number(second) > 59 || (offset && offset.toUpperCase() !== "Z"
    && (Number(offset.slice(1, 3)) > 23 || Number(offset.slice(4)) > 59))) {
    throw new AppError(400, "INVALID_TIME", `${field} contains an invalid second or time zone offset.`);
  }
  const milliseconds = Number(fraction.padEnd(3, "0").slice(0, 3));
  const timestamp = offset
    ? Date.parse(`${date}T${time}:${second}.${String(milliseconds).padStart(3, "0")}${offset.toUpperCase()}`)
    : timestampOnDate(date, time) + Number(second) * 1000 + milliseconds;
  if (!Number.isFinite(timestamp)) {
    throw new AppError(400, "INVALID_TIME", `${field} must be a valid ISO date-time.`);
  }
  return { time: departureLabel(timestamp, localDate(timestamp)), timestamp };
}

export function resolveTimeInput(value, date, field = "departure") {
  const parsed = parseTimeInput(value, field);
  return parsed.timestamp ?? timestampOnDate(date, parsed.time);
}

export function departureLabel(timestamp, date) {
  const formatted = formatTimestamp(timestamp);
  const time = formatted.slice(17, 23) === "00.000"
    ? formatted.slice(11, 16) : formatted.slice(11, 23);
  return localDate(timestamp) === date ? time : `${localDate(timestamp)}T${time}`;
}

export function timestampOnDate(date, time) {
  const wallTime = Date.parse(`${date}T${time}:00Z`);
  let timestamp = wallTime;

  // Resolve the local wall clock through IANA data instead of the host time zone.
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const p = parts(timestamp);
    const represented = Date.parse(`${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}:${p.second}Z`);
    const difference = wallTime - represented;
    if (difference === 0) return timestamp;
    timestamp += difference;
  }

  throw new AppError(400, "INVALID_LOCAL_TIME", "The requested time does not exist in Europe/Istanbul.");
}

export function formatTimestamp(timestamp) {
  const p = parts(timestamp);
  const wallTime = Date.parse(`${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}:${p.second}Z`);
  const offsetMinutes = Math.round((wallTime - Math.floor(timestamp / 1000) * 1000) / 60_000);
  const absoluteOffset = Math.abs(offsetMinutes);
  const offset = `${offsetMinutes < 0 ? "-" : "+"}${String(Math.floor(absoluteOffset / 60)).padStart(2, "0")}:${String(absoluteOffset % 60).padStart(2, "0")}`;
  const milliseconds = String(((timestamp % 1000) + 1000) % 1000).padStart(3, "0");
  return `${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}:${p.second}.${milliseconds}${offset}`;
}

export function minutesToSeconds(value, field) {
  const numeric = typeof value === "number"
    || (typeof value === "string" && /^\d+(?:\.\d+)?$/.test(value.trim()));
  const seconds = numeric ? Math.round(Number(value) * 60) : NaN;

  if (!Number.isSafeInteger(seconds) || seconds < 0 || seconds > 31_536_000) {
    throw new AppError(400, "INVALID_DURATION", `${field} must be non-negative minutes, at most one year.`);
  }

  return seconds;
}
