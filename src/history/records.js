import { AppError } from "../shared/errors.js";
import { isDeepStrictEqual } from "node:util";
import { archiveTimestamp, istanbulTimestamp } from "./time.js";

// Retained for lossless source reconstruction and any future IETT-format export.
// HTTP history responses use database field names instead.
export const IETT_ARCHIVE_FIELD_MAP = Object.freeze({
  ID: "source_id",
  NARSIVGOREVID: "archive_task_id",
  NKAYITGUNU: "record_date",
  SHATKODU: "line_code",
  SGUZERGAHKODU: "route_code",
  SKAPINUMARA: "vehicle_door_number",
  DTBASLAMAZAMANI: "started_at",
  DTBITISZAMANI: "ended_at",
  SGOREVDURUM: "task_status",
  NGOREVID: "task_id",
  DTPLANLANANBASLANGICZAMANI: "planned_started_at",
  DTDUZENLENENBASLANGICZAMANI: "adjusted_started_at"
});

const ID_COLUMNS = new Set(["source_id", "archive_task_id", "task_id"]);
const TIME_COLUMNS = new Set(["started_at", "ended_at", "planned_started_at", "adjusted_started_at"]);

function identifier(value, required = false) {
  if (value == null && !required) return null;
  if ((typeof value === "number" && !Number.isSafeInteger(value))
    || !["string", "number"].includes(typeof value) || !/^\d+$/.test(String(value))
    || BigInt(value) > 9_223_372_036_854_775_807n) {
    if (!required) return null;
    throw new AppError(502, "IETT_ARCHIVE_INVALID_RECORD", "An archive record contains a missing or invalid identifier.");
  }
  return String(value);
}

function text(value) { return typeof value === "string" ? value : null; }

function sourceTimestamp(value) {
  return value == null ? null : `/Date(${new Date(value).getTime()})/`;
}

function recordDate(value) {
  if (typeof value === "string") return value;
  // node-postgres DATE values are constructed at midnight in the host timezone.
  return `${value.getFullYear()}-${String(value.getMonth() + 1).padStart(2, "0")}-${String(value.getDate()).padStart(2, "0")}`;
}

function canonicalSourceRecord(row) {
  return Object.fromEntries(Object.entries(IETT_ARCHIVE_FIELD_MAP).map(([source, column]) => {
    let value = row[column];
    if (ID_COLUMNS.has(column)) value = value == null ? null : Number(value);
    else if (TIME_COLUMNS.has(column)) value = sourceTimestamp(value);
    else if (column === "record_date") value = Number(recordDate(value).replaceAll("-", ""));
    return [source, value];
  }));
}

function extraFields(raw, canonical) {
  const values = Object.fromEntries(Object.entries(raw)
    .filter(([key, value]) => !Object.hasOwn(canonical, key) || !isDeepStrictEqual(value, canonical[key])));
  const absent = Object.keys(canonical).filter(key => !Object.hasOwn(raw, key));
  // An envelope prevents new source fields named "values" or "absent" from
  // colliding with presence metadata. The ordinary case occupies only {}.
  return { ...(Object.keys(values).length ? { values } : {}), ...(absent.length ? { absent } : {}) };
}

export function archiveSourceRecord(row) {
  const source = canonicalSourceRecord(row);
  for (const key of row.extra_fields?.absent ?? []) delete source[key];
  return { ...source, ...row.extra_fields?.values };
}

function responseIdentifier(value) {
  if (value == null) return null;
  const numeric = Number(value);
  return Number.isSafeInteger(numeric) ? numeric : String(value);
}

export function normalizeArchiveRecord(raw, date) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)
    || String(raw.NKAYITGUNU) !== date.replaceAll("-", "")
    || typeof raw.SHATKODU !== "string" || !raw.SHATKODU.trim()) {
    throw new AppError(502, "IETT_ARCHIVE_INVALID_RECORD", "An archive record has an invalid line or does not belong to the requested day.");
  }
  const row = {
    record_date: date,
    source_id: identifier(raw.ID, true),
    archive_task_id: identifier(raw.NARSIVGOREVID),
    task_id: identifier(raw.NGOREVID),
    line_code: raw.SHATKODU,
    route_code: text(raw.SGUZERGAHKODU),
    vehicle_door_number: text(raw.SKAPINUMARA),
    task_status: text(raw.SGOREVDURUM),
    started_at: archiveTimestamp(raw.DTBASLAMAZAMANI),
    ended_at: archiveTimestamp(raw.DTBITISZAMANI),
    planned_started_at: archiveTimestamp(raw.DTPLANLANANBASLANGICZAMANI),
    adjusted_started_at: archiveTimestamp(raw.DTDUZENLENENBASLANGICZAMANI)
  };
  row.extra_fields = extraFields(raw, canonicalSourceRecord(row));
  return row;
}

export function historyRecord(row) {
  const start = row.started_at == null ? NaN : new Date(row.started_at).getTime();
  const end = row.ended_at == null ? NaN : new Date(row.ended_at).getTime();
  return {
    source_id: responseIdentifier(row.source_id),
    archive_task_id: responseIdentifier(row.archive_task_id),
    task_id: responseIdentifier(row.task_id),
    record_date: recordDate(row.record_date),
    line_code: row.line_code,
    route_code: row.route_code,
    vehicle_door_number: row.vehicle_door_number,
    task_status: row.task_status,
    started_at: istanbulTimestamp(row.started_at),
    ended_at: istanbulTimestamp(row.ended_at),
    planned_started_at: istanbulTimestamp(row.planned_started_at),
    adjusted_started_at: istanbulTimestamp(row.adjusted_started_at),
    extra_fields: row.extra_fields ?? {},
    created_at: istanbulTimestamp(row.created_at),
    fetched_at: istanbulTimestamp(row.fetched_at),
    duration_seconds: Number.isFinite(start) && Number.isFinite(end) && end >= start ? (end - start) / 1000 : null
  };
}
