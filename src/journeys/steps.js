import { AppError } from "../shared/errors.js";
import { requireCode } from "../shared/validation.js";
import { resolveTimeInput } from "./time.js";
import { StepType } from "./types.js";

export const isRecord = value => value !== null && typeof value === "object" && !Array.isArray(value);

export function readRouteStepKeys(route) {
  if (!isRecord(route) || !Object.keys(route).length) {
    throw new AppError(400, "INVALID_ROUTE", "Each route must contain numbered journey steps.");
  }
  const keys = Object.keys(route);
  if (keys.some(key => !/^[1-9]\d*$/.test(key) || !Number.isSafeInteger(Number(key)))) {
    throw new AppError(400, "INVALID_STEP_ORDER", "Journey step keys must be positive integer strings.");
  }
  return keys.sort((first, second) => Number(first) - Number(second));
}

export function normalizeStepKey(value, field = "startStep") {
  const key = typeof value === "number" ? String(value)
    : typeof value === "string" ? value.trim() : "";
  if (!/^[1-9]\d*$/.test(key) || !Number.isSafeInteger(Number(key))) {
    throw new AppError(400, "INVALID_START_STEP", `${field} must be a positive integer step key.`);
  }
  return key;
}

function departuresFor(step, date) {
  if (step.departures !== undefined && !Array.isArray(step.departures)) {
    throw new AppError(400, "INVALID_DEPARTURES", "departures must be an array of times.");
  }
  const values = [...(step.departures ?? [])];
  if (step.departure !== undefined) values.push(step.departure);
  if (step.departureTime !== undefined) values.push(step.departureTime);
  if (step.departures === undefined && step.departure === undefined && step.departureTime === undefined) {
    throw new AppError(400, "MISSING_DEPARTURES", "A scheduled step requires departure, departureTime or departures.");
  }
  return [...new Set(values.map(value => resolveTimeInput(value, date)))].sort((a, b) => a - b);
}

export function normalizeJourneyStep(raw, stepId, handlers, date, { allowUnscheduled = false } = {}) {
  if (!isRecord(raw) || !Object.keys(raw).length) {
    throw new AppError(400, "INVALID_STEP", "Each journey step must be a non-empty object.", { stepId });
  }
  const handler = handlers.get(raw.type);
  if (!handler) {
    throw new AppError(400, "INVALID_STEP_TYPE", "A supported type is required for every non-empty step.", {
      type: raw.type ?? null, supportedTypes: [...handlers.keys(), StepType.BUS_OPTIONS]
    });
  }
  const hasDepartures = raw.departures !== undefined || raw.departure !== undefined || raw.departureTime !== undefined;
  const departures = handler.scheduled
    ? allowUnscheduled && !hasDepartures ? null : departuresFor(raw, date)
    : undefined;
  return {
    ...handler.normalize(raw),
    id: stepId,
    type: raw.type,
    ...(raw.line === undefined ? {} : { line: requireCode(raw.line, "line") }),
    scheduled: Boolean(handler.scheduled),
    vehicle: Boolean(handler.vehicle),
    ...(handler.scheduled ? { departures } : {})
  };
}

export function publicStepInfo(step) {
  const { scheduled, vehicle, durationSeconds, fallbackDurationSeconds,
    departureTimestamp, departures, departure, ...info } = step;
  return info;
}
