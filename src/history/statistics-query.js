import { AppError } from "../shared/errors.js";
import { requireCode } from "../shared/validation.js";
import { completedRange, localDate, shiftDate } from "./time.js";

const PARAMETERS = new Set(["from", "to", "departure_time", "departure_basis", "weekday", "departure_day_offset"]);

function invalid(message) {
  throw new AppError(400, "INVALID_STATISTICS_QUERY", message);
}

export function statisticsQuery(routeCode, query = {}, now = Date.now()) {
  const route_code = requireCode(routeCode, "routeCode");
  for (const [key, value] of Object.entries(query)) {
    if (!PARAMETERS.has(key)) invalid(`Unknown statistics parameter: ${key}.`);
    if (typeof value !== "string") invalid(`${key} must be a single string value.`);
  }
  const to = query.to ?? shiftDate(localDate(now), -1);
  const from = query.from ?? shiftDate(completedRange(to, to, now).to, -29);
  completedRange(from, to, now);
  const departure_time = query.departure_time ?? null;
  if (departure_time !== null && !/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(departure_time)) {
    invalid("departure_time must be HH:mm between 00:00 and 23:59.");
  }
  const departure_basis = query.departure_basis ?? "planned";
  if (!["planned", "adjusted", "actual"].includes(departure_basis)) invalid("departure_basis must be planned, adjusted or actual.");
  if (departure_time === null && departure_basis !== "planned") {
    invalid("departure_basis can only differ from planned when departure_time is provided. All departures are grouped by their original planned time.");
  }
  if (query.weekday !== undefined && !/^[1-7]$/.test(query.weekday)) invalid("weekday must be an ISO weekday from 1 to 7.");
  if (query.departure_day_offset !== undefined && !/^[01]$/.test(query.departure_day_offset)) invalid("departure_day_offset must be 0 or 1.");
  return {
    route_code, from, to, mode: departure_time === null ? "general" : "departure",
    departure_time, departure_basis,
    weekday: query.weekday === undefined ? null : Number(query.weekday),
    departure_day_offset: query.departure_day_offset === undefined ? (departure_time === null ? null : 0) : Number(query.departure_day_offset)
  };
}
