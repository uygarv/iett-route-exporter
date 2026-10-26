import { AppError } from "../shared/errors.js";
import { requireCode } from "../shared/validation.js";
import { isRecord, normalizeStepKey, readRouteStepKeys } from "./steps.js";
import { localDate, minutesToSeconds, normalizeDate, parseTimeInput, timestampOnDate } from "./time.js";
import { expandJourneyPaths, MAX_JOURNEY_OPTIONS } from "./options.js";

const MAX_CALCULATION_OPTIONS = MAX_JOURNEY_OPTIONS;

function checkOptionCount(count) {
  if (count > MAX_CALCULATION_OPTIONS) {
    throw new AppError(400, "TOO_MANY_OPTIONS", `At most ${MAX_CALCULATION_OPTIONS} option combinations can be calculated per request.`);
  }
}

function optionId(path) {
  return path.selections.map(selection => `${encodeURIComponent(selection.stepId)}=${encodeURIComponent(selection.optionId)}`)
    .join("/") || "default";
}

export function normalizeSingleJourneyRequest(input, handlers, now) {
  if (!isRecord(input)) {
    throw new AppError(400, "INVALID_INPUT", "The journey calculation request must be an object.");
  }
  const unsupported = ["routes", "arrivalTime", "arrivalBufferMinutes", "startSteps", "optionSelections"]
    .filter(field => Object.hasOwn(input, field));
  if (unsupported.length) {
    throw new AppError(400, "UNSUPPORTED_CALCULATION_FIELDS",
      "Use one route without arrival bounds or manual option selections; step alternatives are calculated automatically.", { fields: unsupported });
  }
  const keys = readRouteStepKeys(input.route);
  const startStep = input.startStep === undefined ? keys[0] : normalizeStepKey(input.startStep);
  const startIndex = keys.indexOf(startStep);
  if (startIndex === -1) {
    throw new AppError(400, "START_STEP_NOT_FOUND", "The selected starting step does not exist in this journey.", {
      startStep, availableStepIds: keys
    });
  }
  const departure = input.departureTime === undefined || input.departureTime === "now"
    ? { timestamp: now } : parseTimeInput(input.departureTime, "departureTime");
  const date = input.date === undefined ? localDate(departure.timestamp ?? now) : normalizeDate(input.date);
  const departureTimestamp = departure.timestamp ?? timestampOnDate(date, departure.time);
  const boardingBufferSeconds = minutesToSeconds(input.boardingBufferMinutes ?? 0, "boardingBufferMinutes");
  const { paths, hasOptions } = expandJourneyPaths(input.route, keys.slice(startIndex), handlers, date, {
    mode: "calculate", checkCount: checkOptionCount
  });
  return {
    routeId: input.routeId === undefined ? null : requireCode(input.routeId, "routeId"),
    date, departureTimestamp, boardingBufferSeconds, startStep,
    skippedStepIds: keys.slice(0, startIndex), hasOptions,
    paths: paths.map(path => ({ ...path, id: optionId(path) }))
  };
}
