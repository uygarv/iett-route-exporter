import { AppError } from "../shared/errors.js";
import { isRecord, normalizeJourneyStep } from "./steps.js";
import { StepType, publicError } from "./types.js";

export const MAX_JOURNEY_OPTIONS = 500;

export function optionIssue(status, code, message, stepId) {
  return { steps: [], selections: [], issue: { status, code, message, stepId } };
}

// Evaluation isolates invalid routes; calculation rejects invalid root steps
// and permits dynamic steps without a timetable. Alternatives share expansion.
export function expandJourneyPaths(route, keys, handlers, date, { mode = "evaluate", checkCount }) {
  const calculating = mode === "calculate";

  function expandStep(raw, stepId, insideOption = false) {
    if (!calculating && !isRecord(raw)) {
      return [optionIssue("error", "INVALID_STEP", "Each journey step must be an object.", stepId)];
    }
    if ((!calculating || insideOption) && isRecord(raw)) {
      if (!Object.keys(raw).length) {
        return [optionIssue("skipped", "EMPTY_OPTION", "The journey option is empty.", stepId)];
      }
      if (Array.isArray(raw.departures) && !raw.departures.length
        && raw.departure === undefined && raw.departureTime === undefined) {
        return [optionIssue("skipped", "NO_DEPARTURES", "No departures were supplied for this option.", stepId)];
      }
    }
    if (isRecord(raw) && raw.type === StepType.BUS_OPTIONS) {
      if (!isRecord(raw.options)) {
        if (!calculating) {
          return [optionIssue("error", "INVALID_BUS_OPTIONS", "BUS_OPTIONS requires an options object.", stepId)];
        }
        const error = new AppError(400, "INVALID_BUS_OPTIONS", "BUS_OPTIONS requires an options object.", { stepId });
        if (!insideOption) throw error;
        return [{ steps: [], selections: [], issue: { status: "error", stepId, ...publicError(error) } }];
      }
      if (!Object.keys(raw.options).length) {
        return [optionIssue("skipped", "EMPTY_OPTIONS", "No journey alternatives were supplied.", stepId)];
      }
      const branches = [];
      for (const [optionId, option] of Object.entries(raw.options)) {
        for (const branch of expandStep(option, `${stepId}/${optionId}`, true)) {
          branches.push({ ...branch, selections: [{ stepId, optionId }, ...branch.selections] });
          checkCount(branches.length);
        }
      }
      return branches;
    }
    try {
      const step = normalizeJourneyStep(raw, stepId, handlers, date, { allowUnscheduled: calculating });
      if (!calculating && step.departures?.length === 0) {
        return [optionIssue("skipped", "NO_DEPARTURES", "No departures were supplied for this option.", stepId)];
      }
      return [{ steps: [step], selections: [] }];
    } catch (error) {
      if (calculating && !insideOption) throw error;
      return [{ steps: [], selections: [], issue: { status: "error", stepId, ...publicError(error) } }];
    }
  }

  let hasOptions = false;
  let paths = [{ steps: [], selections: [] }];
  for (const key of keys) {
    if (paths.every(path => path.issue)) break;
    const raw = route[key];
    hasOptions ||= isRecord(raw) && raw.type === StepType.BUS_OPTIONS;
    const choices = expandStep(raw, key);
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
  return { paths, hasOptions };
}
