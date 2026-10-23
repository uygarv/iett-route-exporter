import { formatTimestamp } from "./time.js";
import { StepType } from "./types.js";
import { publicStepInfo } from "./steps.js";

function baseCandidate(plan) {
  return {
    id: plan.id,
    routeId: plan.routeId,
    selections: plan.selections,
    departures: plan.steps.filter(step => step.scheduled && step.departureTime).map(step => ({
      stepId: step.id, type: step.type, departureTime: step.departureTime
    })),
    homeDepartureTime: null,
    arrivalTime: null,
    durationSeconds: null,
    waitingDurationSeconds: 0,
    transferCount: Math.max(0, plan.steps.filter(step => step.vehicle).length - 1),
    arrivalMarginSeconds: null,
    latenessSeconds: null,
    arrivesOnTime: false,
    departsAfterRequestedTime: false,
    canStillDepart: false,
    reasons: [],
    warnings: [],
    steps: []
  };
}

export function buildTimeline(plan, estimates, request) {
  const candidate = baseCandidate(plan);
  if (plan.issue) {
    const { status, ...reason } = plan.issue;
    return { ...candidate, status, reasons: [reason] };
  }

  candidate.warnings = estimates.flatMap((estimate, index) => (
    estimate.warnings ?? []
  ).map(warning => ({ ...warning, stepId: plan.steps[index].id })));
  const errors = estimates.flatMap((estimate, index) => estimate.error
    ? [{ ...estimate.error, stepId: plan.steps[index].id }] : []);
  if (errors.length) {
    return {
      ...candidate,
      status: "error",
      reasons: errors,
      steps: plan.steps.map((step, index) => ({
        ...publicStepInfo(step),
        ...estimates[index],
        durationSeconds: estimates[index].durationSeconds ?? null,
        startTime: null,
        endTime: null,
        status: estimates[index].error ? "error" : "unreachable"
      }))
    };
  }

  const firstScheduled = plan.steps.findIndex(step => step.scheduled);
  const prefixLength = firstScheduled === -1 ? plan.steps.length : firstScheduled;
  const prefixSeconds = estimates.slice(0, prefixLength).reduce((total, estimate) => total + estimate.durationSeconds, 0);
  const homeTimestamp = firstScheduled === -1
    ? request.departureTimestamp ?? request.deadlineTimestamp - prefixSeconds * 1000
    : plan.steps[firstScheduled].departureTimestamp - (prefixSeconds + request.boardingBufferSeconds) * 1000;
  candidate.homeDepartureTime = formatTimestamp(homeTimestamp);
  candidate.departsAfterRequestedTime = request.departureTimestamp === null
    || homeTimestamp >= request.departureTimestamp;
  if (!candidate.departsAfterRequestedTime) {
    candidate.reasons.push({
      code: "DEPARTURE_BEFORE_REQUESTED_TIME",
      message: "Catching this service requires leaving home before departureTime.",
      earliestDepartureTime: formatTimestamp(request.departureTimestamp)
    });
  }
  let timestamp = homeTimestamp;
  let blocked = false;

  for (const [index, step] of plan.steps.entries()) {
    const estimate = estimates[index];
    const info = { ...publicStepInfo(step), ...estimate };
    if (blocked) {
      candidate.steps.push({ ...info, startTime: null, endTime: null, status: "unreachable" });
      continue;
    }
    if (step.scheduled) {
      const requiredArrival = step.departureTimestamp - request.boardingBufferSeconds * 1000;
      if (timestamp > requiredArrival) {
        candidate.reasons.push({
          code: "CONNECTION_MISSED",
          message: "The boarding point cannot be reached before the required boarding time.",
          stepId: step.id,
          arrivalAtStop: formatTimestamp(timestamp),
          requiredArrivalTime: formatTimestamp(requiredArrival),
          departureTime: step.departureTime
        });
        candidate.steps.push({ ...info, startTime: null, endTime: null, status: "connection-missed" });
        blocked = true;
        continue;
      }
      const waitSeconds = (step.departureTimestamp - timestamp) / 1000;
      if (waitSeconds > 0) {
        candidate.steps.push({
          id: `wait:${step.id}`,
          type: StepType.WAIT,
          beforeStepId: step.id,
          durationSeconds: waitSeconds,
          durationSource: "schedule",
          boardingBufferSeconds: request.boardingBufferSeconds,
          startTime: formatTimestamp(timestamp),
          endTime: step.departureTime,
          status: "calculated"
        });
        candidate.waitingDurationSeconds += waitSeconds;
      }
      timestamp = step.departureTimestamp;
    }
    const endTimestamp = timestamp + estimate.durationSeconds * 1000;
    candidate.steps.push({
      ...info,
      startTime: formatTimestamp(timestamp),
      endTime: formatTimestamp(endTimestamp),
      status: "calculated"
    });
    timestamp = endTimestamp;
  }

  if (blocked) return { ...candidate, status: "connection-missed" };
  candidate.arrivalTime = formatTimestamp(timestamp);
  candidate.durationSeconds = (timestamp - homeTimestamp) / 1000;
  candidate.arrivalMarginSeconds = request.targetTimestamp === null ? null : (request.targetTimestamp - timestamp) / 1000;
  candidate.latenessSeconds = candidate.arrivalMarginSeconds === null ? null : Math.max(0, -candidate.arrivalMarginSeconds);
  candidate.arrivesOnTime = request.deadlineTimestamp === null || timestamp <= request.deadlineTimestamp;
  candidate.status = !candidate.departsAfterRequestedTime ? "departure-too-early"
    : candidate.arrivesOnTime ? "feasible" : "late";
  if (!candidate.arrivesOnTime) {
    candidate.reasons.push({
      code: "ARRIVAL_DEADLINE_EXCEEDED",
      message: "Estimated arrival exceeds the target time or its requested safety buffer.",
      effectiveLatenessSeconds: (timestamp - request.deadlineTimestamp) / 1000
    });
  }
  return candidate;
}
