import { AppError } from "../shared/errors.js";
import {
  departureLabel, formatTimestamp, localDate, minutesToSeconds,
  normalizeDate, parseTimeInput, timestampOnDate
} from "./time.js";
import { StepType, publicError } from "./types.js";
import { isRecord, normalizeJourneyStep, readRouteStepKeys } from "./steps.js";
import { normalizeScoring } from "./scoring.js";

export const MAX_CANDIDATES = 500;

function checkCount(count) {
  if (count > MAX_CANDIDATES) {
    throw new AppError(400, "TOO_MANY_CANDIDATES", `At most ${MAX_CANDIDATES} journey candidates can be evaluated per request.`);
  }
}

function problem(status, code, message, stepId) {
  return { steps: [], selections: [], issue: { status, stepId, code, message } };
}

function expandStep(raw, stepId, handlers, date) {
  if (!isRecord(raw)) {
    return [problem("error", "INVALID_STEP", "Each journey step must be an object.", stepId)];
  }
  if (Object.keys(raw).length === 0) {
    return [problem("skipped", "EMPTY_OPTION", "The journey option is empty.", stepId)];
  }
  // An explicitly unavailable service is skipped even if other fields are incomplete.
  if (Array.isArray(raw.departures) && !raw.departures.length
    && raw.departure === undefined && raw.departureTime === undefined) {
    return [problem("skipped", "NO_DEPARTURES", "No departures were supplied for this option.", stepId)];
  }

  if (raw.type === StepType.BUS_OPTIONS) {
    if (!isRecord(raw.options)) {
      return [problem("error", "INVALID_BUS_OPTIONS", "BUS_OPTIONS requires an options object.", stepId)];
    }
    if (!Object.keys(raw.options).length) {
      return [problem("skipped", "EMPTY_OPTIONS", "No journey alternatives were supplied.", stepId)];
    }
    const branches = [];
    for (const [optionId, option] of Object.entries(raw.options)) {
      for (const branch of expandStep(option, `${stepId}/${optionId}`, handlers, date)) {
        branches.push({
          ...branch,
          selections: [{ stepId, optionId }, ...branch.selections]
        });
        checkCount(branches.length);
      }
    }
    return branches;
  }

  try {
    const step = normalizeJourneyStep(raw, stepId, handlers, date);
    if (step.departures?.length === 0) {
      return [problem("skipped", "NO_DEPARTURES", "No departures were supplied for this option.", stepId)];
    }
    return [{ steps: [step], selections: [] }];
  } catch (error) {
    return [{ steps: [], selections: [], issue: { status: "error", stepId, ...publicError(error) } }];
  }
}

function expandRoute(raw, handlers, date) {
  let keys;
  try {
    keys = readRouteStepKeys(raw);
  } catch (error) {
    return [problem("error", error.code, error.message)];
  }
  let paths = [{ steps: [], selections: [] }];
  for (const key of keys) {
    if (paths.every(path => path.issue)) break;
    const choices = expandStep(raw[key], key, handlers, date);
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
        checkCount(expanded.length);
      }
    }
    paths = expanded;
  }
  return paths;
}

function candidateId(routeId, path) {
  return [
    encodeURIComponent(routeId),
    ...path.selections.map(choice => `${encodeURIComponent(choice.stepId)}=${encodeURIComponent(choice.optionId)}`),
    ...path.steps.filter(step => step.scheduled && step.departure).map(step => `${encodeURIComponent(step.id)}@${step.departure}`)
  ].join("/");
}

export function normalizeJourneyRequest(input, handlers, now) {
  if (!isRecord(input) || !isRecord(input.routes) || !Object.keys(input.routes).length) {
    throw new AppError(400, "INVALID_ROUTES", "routes must be a non-empty object of named journeys.");
  }
  if (input.arrivalTime === undefined && input.departureTime === undefined) {
    throw new AppError(400, "MISSING_JOURNEY_TIME", "Supply arrivalTime, departureTime, or both.");
  }
  const scoringWeights = normalizeScoring(input.scoring);
  const departure = input.departureTime === undefined ? null : parseTimeInput(input.departureTime, "departureTime");
  const arrival = input.arrivalTime === undefined ? null : parseTimeInput(input.arrivalTime, "arrivalTime");
  const datedTimestamp = departure?.timestamp ?? arrival?.timestamp;
  const date = input.date === undefined
    ? localDate(datedTimestamp ?? now) : normalizeDate(input.date);
  const departureTimestamp = departure === null ? null
    : departure.timestamp ?? timestampOnDate(date, departure.time);
  const targetTimestamp = arrival === null ? null
    : arrival.timestamp ?? timestampOnDate(date, arrival.time);
  if (departureTimestamp !== null && targetTimestamp !== null && departureTimestamp > targetTimestamp) {
    throw new AppError(400, "INVALID_TIME_WINDOW", "departureTime must be at or before arrivalTime. Include dates for overnight journeys.");
  }
  const boardingBufferSeconds = minutesToSeconds(input.boardingBufferMinutes ?? 0, "boardingBufferMinutes");
  const arrivalBufferSeconds = minutesToSeconds(input.arrivalBufferMinutes ?? 0, "arrivalBufferMinutes");
  const plans = [];

  for (const [routeId, route] of Object.entries(input.routes)) {
    for (const path of expandRoute(route, handlers, date)) {
      let combinations = [{ ...path, steps: [] }];
      if (path.issue) {
        combinations = [path];
      } else {
        for (const step of path.steps) {
          const choices = step.scheduled ? step.departures : [null];
          checkCount(plans.length + combinations.length * choices.length);
          combinations = combinations.flatMap(combination => choices.map(scheduledTimestamp => {
            if (scheduledTimestamp === null) return { ...combination, steps: [...combination.steps, step] };
            const { departures, ...scheduledStep } = step;
            return {
              ...combination,
              steps: [...combination.steps, {
                ...scheduledStep,
                departure: departureLabel(scheduledTimestamp, date),
                departureTimestamp: scheduledTimestamp,
                departureTime: formatTimestamp(scheduledTimestamp)
              }]
            };
          }));
        }
      }
      checkCount(plans.length + combinations.length);
      for (const combination of combinations) {
        plans.push({ ...combination, routeId, id: candidateId(routeId, combination) });
      }
    }
  }

  return {
    date,
    scoringWeights,
    mode: targetTimestamp === null ? "depart-after" : "arrive-by",
    arrivalTime: arrival?.time ?? null,
    departureTimestamp,
    targetTimestamp,
    deadlineTimestamp: targetTimestamp === null ? null : targetTimestamp - arrivalBufferSeconds * 1000,
    boardingBufferSeconds,
    arrivalBufferSeconds,
    routeIds: Object.keys(input.routes),
    plans
  };
}
