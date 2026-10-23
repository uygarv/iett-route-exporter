import { publicStepInfo } from "./steps.js";
import { departureLabel, formatTimestamp } from "./time.js";
import { StepType } from "./types.js";

export async function calculateForwardTimeline(request, estimateStep) {
  const result = {
    routeId: request.routeId,
    startStep: request.startStep,
    skippedStepIds: request.skippedStepIds,
    selections: request.selections,
    departureTime: formatTimestamp(request.departureTimestamp),
    startTime: formatTimestamp(request.departureTimestamp),
    arrivalTime: null,
    durationSeconds: null,
    elapsedDurationSeconds: 0,
    waitingDurationSeconds: 0,
    transferCount: Math.max(0, request.steps.filter(step => step.vehicle).length - 1),
    status: "calculated",
    reasons: [],
    warnings: [],
    steps: []
  };
  if (request.issue) {
    const { status, ...reason } = request.issue;
    return {
      ...result, status, reasons: [reason],
      steps: request.steps.map(step => ({
        ...publicStepInfo(step), durationSeconds: step.durationSeconds ?? null,
        startTime: null, endTime: null, status: "unreachable"
      }))
    };
  }
  let timestamp = request.departureTimestamp;
  let blocked = false;

  for (const step of request.steps) {
    const info = { ...publicStepInfo(step), durationSeconds: step.durationSeconds ?? null };
    if (blocked) {
      result.steps.push({ ...info, startTime: null, endTime: null, status: "unreachable" });
      continue;
    }
    if (step.scheduled && step.departures !== null) {
      const earliestBoarding = timestamp + request.boardingBufferSeconds * 1000;
      const departureTimestamp = step.departures.find(value => value >= earliestBoarding);
      if (departureTimestamp === undefined) {
        result.status = "no-departure";
        result.reasons.push({
          code: step.departures.length ? "NO_REACHABLE_DEPARTURE" : "NO_DEPARTURES",
          message: "No supplied departure can be reached from the current journey time.",
          stepId: step.id,
          readyAt: formatTimestamp(timestamp),
          earliestBoardingTime: formatTimestamp(earliestBoarding)
        });
        result.steps.push({ ...info, startTime: null, endTime: null, status: "no-departure" });
        blocked = true;
        continue;
      }
      if (departureTimestamp > timestamp) {
        const waitSeconds = (departureTimestamp - timestamp) / 1000;
        result.steps.push({
          id: `wait:${step.id}`, type: StepType.WAIT, beforeStepId: step.id,
          startTime: formatTimestamp(timestamp), endTime: formatTimestamp(departureTimestamp),
          durationSeconds: waitSeconds, durationSource: "schedule",
          boardingBufferSeconds: request.boardingBufferSeconds, status: "calculated"
        });
        result.waitingDurationSeconds += waitSeconds;
      }
      timestamp = departureTimestamp;
    }
    const executionStep = {
      ...step,
      departureTimestamp: timestamp,
      departureTime: formatTimestamp(timestamp),
      departure: departureLabel(timestamp, request.date)
    };
    const estimate = await estimateStep(executionStep);
    const timedInfo = step.scheduled ? { ...info, departureTime: executionStep.departureTime } : info;
    if (estimate.error) {
      result.status = "error";
      result.reasons.push({ ...estimate.error, stepId: step.id });
      result.steps.push({ ...timedInfo, startTime: formatTimestamp(timestamp), endTime: null,
        error: estimate.error, status: "error" });
      blocked = true;
      continue;
    }
    const endTimestamp = timestamp + estimate.durationSeconds * 1000;
    result.steps.push({
      ...timedInfo, ...estimate,
      startTime: formatTimestamp(timestamp), endTime: formatTimestamp(endTimestamp), status: "calculated"
    });
    result.warnings.push(...(estimate.warnings ?? []).map(warning => ({ ...warning, stepId: step.id })));
    timestamp = endTimestamp;
  }
  result.elapsedDurationSeconds = (timestamp - request.departureTimestamp) / 1000;
  if (!blocked) {
    result.arrivalTime = formatTimestamp(timestamp);
    result.durationSeconds = result.elapsedDurationSeconds;
  }
  return result;
}
