import { AppError } from "../shared/errors.js";
import { requireCode } from "../shared/validation.js";
import { isRecord, normalizeJourneyStep, normalizeStepKey, readRouteStepKeys } from "./steps.js";
import { localDate, minutesToSeconds, normalizeDate, parseTimeInput, timestampOnDate } from "./time.js";
import { StepType, publicError } from "./types.js";

const MAX_CALCULATION_OPTIONS = 500;

function checkOptionCount(count) {
  if (count > MAX_CALCULATION_OPTIONS) {
    throw new AppError(400, "TOO_MANY_OPTIONS", `At most ${MAX_CALCULATION_OPTIONS} option combinations can be calculated per request.`);
  }
}

function optionIssue(status, code, message, stepId) {
  return { steps: [], selections: [], issue: { status, code, message, stepId } };
}

function expandStep(raw, stepId, handlers, date, insideOption = false) {
  if (insideOption && isRecord(raw)) {
    if (Object.keys(raw).length === 0) {
      return [optionIssue("skipped", "EMPTY_OPTION", "The journey option is empty.", stepId)];
    }
    if (Array.isArray(raw.departures) && raw.departures.length === 0
      && raw.departure === undefined && raw.departureTime === undefined) {
      return [optionIssue("skipped", "NO_DEPARTURES", "No departures were supplied for this option.", stepId)];
    }
  }
  if (isRecord(raw) && raw.type === StepType.BUS_OPTIONS) {
    if (!isRecord(raw.options)) {
      const error = new AppError(400, "INVALID_BUS_OPTIONS", "BUS_OPTIONS requires an options object.", { stepId });
      if (!insideOption) throw error;
      return [{ steps: [], selections: [], issue: { status: "error", stepId, ...publicError(error) } }];
    }
    if (!Object.keys(raw.options).length) {
      return [optionIssue("skipped", "EMPTY_OPTIONS", "No journey alternatives were supplied.", stepId)];
    }
    const branches = [];
    for (const [optionId, option] of Object.entries(raw.options)) {
      for (const branch of expandStep(option, `${stepId}/${optionId}`, handlers, date, true)) {
        branches.push({ ...branch, selections: [{ stepId, optionId }, ...branch.selections] });
        checkOptionCount(branches.length);
      }
    }
    return branches;
  }
  try {
    const step = normalizeJourneyStep(raw, stepId, handlers, date, { allowUnscheduled: true });
    return [{ steps: [step], selections: [] }];
  } catch (error) {
    if (!insideOption) throw error;
    return [{ steps: [], selections: [], issue: { status: "error", stepId, ...publicError(error) } }];
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
  let hasOptions = false;
  let paths = [{ steps: [], selections: [] }];
  for (const key of keys.slice(startIndex)) {
    if (paths.every(path => path.issue)) break;
    const raw = input.route[key];
    hasOptions ||= isRecord(raw) && raw.type === StepType.BUS_OPTIONS;
    const choices = expandStep(raw, key, handlers, date);
    const expanded = [];
    for (const path of paths) {
      if (path.issue) {
        expanded.push(path);
        continue;
      }
      for (const choice of choices) {
        expanded.push({
          steps: [...path.steps, ...choice.steps],
          selections: [...path.selections, ...choice.selections],
          ...(choice.issue ? { issue: choice.issue } : {})
        });
        checkOptionCount(expanded.length);
      }
    }
    paths = expanded;
  }
  return {
    routeId: input.routeId === undefined ? null : requireCode(input.routeId, "routeId"),
    date, departureTimestamp, boardingBufferSeconds, startStep,
    skippedStepIds: keys.slice(0, startIndex), hasOptions,
    paths: paths.map(path => ({ ...path, id: optionId(path) }))
  };
}
