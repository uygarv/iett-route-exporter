import { createIettService } from "./iett-service.js";
import { createDrivingTimeService } from "./driving-times.js";
import { createStepHandlers, validateEstimate } from "../journeys/handlers.js";
import { normalizeJourneyRequest } from "../journeys/normalization.js";
import { normalizeSingleJourneyRequest } from "../journeys/single-journey.js";
import { buildTimeline } from "../journeys/timeline.js";
import { calculateForwardTimeline } from "../journeys/forward-timeline.js";
import { applyCurrentTime, selectBestCalculatedOption } from "../journeys/ranking.js";
import { scoreJourneyCandidates } from "../journeys/scoring.js";
import { formatTimestamp, TIME_ZONE } from "../journeys/time.js";
import { publicError } from "../journeys/types.js";

function createLimiter(concurrency) {
  let active = 0;
  const queue = [];
  function drain() {
    while (active < concurrency && queue.length) {
      const { run, resolve, reject } = queue.shift();
      active += 1;
      Promise.resolve().then(run).then(resolve, reject).finally(() => {
        active -= 1;
        drain();
      });
    }
  }
  return run => new Promise((resolve, reject) => {
    queue.push({ run, resolve, reject });
    drain();
  });
}

function memoizeCalculation(calculate) {
  const pending = new Map();
  return (...args) => {
    const key = JSON.stringify(args);
    if (!pending.has(key)) pending.set(key, Promise.resolve().then(() => calculate(...args)));
    return pending.get(key);
  };
}

function sharePendingCalculation(calculate) {
  const pending = new Map();
  return (...args) => {
    const key = JSON.stringify(args);
    if (pending.has(key)) return pending.get(key);
    const promise = Promise.resolve().then(() => calculate(...args));
    pending.set(key, promise);
    const forget = () => {
      if (pending.get(key) === promise) pending.delete(key);
    };
    promise.then(forget, forget);
    return promise;
  };
}

export function createJourneyService({
  calculateBusTimes,
  calculateDrivingTimes,
  clock = Date.now,
  ringRoute,
  stepHandlers,
  maxConcurrency = Number(process.env.JOURNEY_MAX_CONCURRENCY ?? 8)
} = {}) {
  if (!Number.isInteger(maxConcurrency) || maxConcurrency < 1 || maxConcurrency > 32) {
    throw new RangeError("maxConcurrency must be an integer from 1 to 32.");
  }
  const busCalculator = calculateBusTimes ?? createIettService().calculateIettRouteTimes;
  const drivingService = calculateDrivingTimes ? null : createDrivingTimeService({ clock });
  const drivingCalculator = calculateDrivingTimes ?? drivingService.calculateDrivingTimes;
  const handlers = createStepHandlers({ ringRoute, stepHandlers });
  // Share the limit across simultaneous requests to this service instance.
  const limit = createLimiter(maxConcurrency);
  // Deduplicate before taking a slot. Identical work across branches or
  // simultaneous requests must not block unrelated provider calls.
  const sharedBusCalculator = sharePendingCalculation((...args) => limit(() => busCalculator(...args)));
  const sharedDrivingCalculator = sharePendingCalculation((...args) => limit(() => drivingCalculator(...args)));

  function createEstimateSession() {
    const context = {
      calculateBusTimes: memoizeCalculation(sharedBusCalculator),
      calculateDrivingTimes: memoizeCalculation(sharedDrivingCalculator)
    };
    return memoizeCalculation(async step => {
      const handler = handlers.get(step.type);
      const calculate = async () => {
        try {
          return validateEstimate(await handler.estimate(step, context));
        } catch (error) {
          return { error: publicError(error) };
        }
      };
      return handler.dynamic === false || handler.concurrency === "provider" ? calculate() : limit(calculate);
    });
  }

  async function evaluateJourneys(input) {
    // Complete validation and expansion before any provider work is scheduled.
    const request = normalizeJourneyRequest(input, handlers, Number(clock()));
    const estimateStep = createEstimateSession();
    const candidates = await Promise.all(request.plans.map(async plan => {
      const estimates = plan.issue ? [] : await Promise.all(plan.steps.map(estimateStep));
      return buildTimeline(plan, estimates, request);
    }));
    const generatedAt = Number(clock());
    candidates.forEach(candidate => applyCurrentTime(candidate, generatedAt));
    const { bestOption, scoring, compare } = scoreJourneyCandidates(candidates, request.scoringWeights);

    const grouped = new Map(request.routeIds.map(id => [id, []]));
    candidates.forEach(candidate => grouped.get(candidate.routeId).push(candidate));
    const options = request.routeIds.map(id => {
      const routeCandidates = grouped.get(id).sort(compare);
      return { id, bestCandidateId: routeCandidates.find(candidate => candidate.rank !== null)?.id ?? null, candidates: routeCandidates };
    }).sort((first, second) => {
      const a = first.candidates[0]?.rank ?? Infinity, b = second.candidates[0]?.rank ?? Infinity;
      return a === b ? 0 : a - b;
    });
    return {
      generatedAt: formatTimestamp(generatedAt),
      timeZone: TIME_ZONE,
      date: request.date,
      mode: request.mode,
      departureTime: request.departureTimestamp === null ? null : formatTimestamp(request.departureTimestamp),
      arrivalTime: request.arrivalTime,
      targetArrivalTime: request.targetTimestamp === null ? null : formatTimestamp(request.targetTimestamp),
      effectiveArrivalTime: request.deadlineTimestamp === null ? null : formatTimestamp(request.deadlineTimestamp),
      boardingBufferMinutes: request.boardingBufferSeconds / 60,
      arrivalBufferMinutes: request.arrivalBufferSeconds / 60,
      scoring,
      bestOption,
      recommendationReason: bestOption ? "HIGHEST_FEASIBLE_SCORE" : "NO_FEASIBLE_OPTION",
      options
    };
  }

  async function calculateJourney(input) {
    const request = normalizeSingleJourneyRequest(input, handlers, Number(clock()));
    const estimateStep = createEstimateSession();
    const options = await Promise.all(request.paths.map(async path => ({
      ...await calculateForwardTimeline({ ...request, ...path }, estimateStep),
      id: path.id
    })));
    const bestOption = request.hasOptions ? selectBestCalculatedOption(options) : null;
    const result = request.hasOptions
      ? bestOption ?? await calculateForwardTimeline({
        ...request, steps: [], selections: [],
        issue: { status: "no-option", code: "NO_CALCULABLE_OPTION", message: "None of the supplied options could complete the journey." }
      }, estimateStep)
      : options[0];
    const { id, ...timeline } = result;
    return {
      generatedAt: formatTimestamp(Number(clock())),
      timeZone: TIME_ZONE,
      date: request.date,
      boardingBufferMinutes: request.boardingBufferSeconds / 60,
      ...timeline,
      ...(request.hasOptions ? { bestOptionId: bestOption?.id ?? null, options } : {})
    };
  }

  return { evaluateJourneys, calculateJourney, clearCaches: () => drivingService?.clearCache() };
}
