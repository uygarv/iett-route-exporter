import { AppError } from "../shared/errors.js";
import { requireCode, parseCoordinate } from "../shared/validation.js";
import { minutesToSeconds } from "./time.js";
import { DEFAULT_RING_ROUTE, StepType, publicError } from "./types.js";

function requiredText(value, field) {
  return requireCode(value, field);
}

function fixedHandler(vehicle) {
  return {
    scheduled: false,
    dynamic: false,
    vehicle,
    normalize: step => ({ durationSeconds: minutesToSeconds(step.duration, "duration") }),
    estimate: step => ({ durationSeconds: step.durationSeconds, durationSource: "fixed" })
  };
}

export function validateEstimate(estimate) {
  if (
    !estimate || typeof estimate.durationSeconds !== "number"
    || !Number.isFinite(estimate.durationSeconds) || estimate.durationSeconds < 0
    || estimate.durationSeconds > 31_536_000
  ) {
    throw new AppError(502, "INVALID_TRAVEL_DURATION", "The step calculator returned an invalid duration.");
  }
  return { ...estimate, durationSeconds: Math.ceil(estimate.durationSeconds) };
}

export function createStepHandlers({ ringRoute = DEFAULT_RING_ROUTE, stepHandlers = {} } = {}) {
  const origin = parseCoordinate(ringRoute.origin, "ring.origin");
  const destination = parseCoordinate(ringRoute.destination, "ring.destination");
  const handlers = new Map([
    [StepType.WALK, fixedHandler(false)],
    [StepType.METRO, fixedHandler(true)],
    [StepType.MBUS, fixedHandler(true)],
    [StepType.BUS, {
      scheduled: true,
      dynamic: true,
      concurrency: "provider",
      vehicle: true,
      normalize: step => ({
        route: requiredText(step.route, "route"),
        startStation: requiredText(step.startStation, "startStation"),
        endStation: requiredText(step.endStation, "endStation")
      }),
      async estimate(step, context) {
        const result = await context.calculateBusTimes(step.route, {
          startStation: step.startStation,
          endStation: step.endStation,
          departureTime: step.departureTime
        });
        return validateEstimate({
          durationSeconds: result?.total?.estimatedDurationSeconds,
          durationSource: "traffic",
          provider: result?.provider,
          trafficDelaySeconds: result?.total?.liveTrafficDelaySeconds
            ?? result?.total?.trafficDelaySeconds,
          requestedTrafficMode: result?.requestedTrafficMode,
          trafficTimeContext: result?.trafficTimeContext,
          trafficDataBasis: result?.trafficDataBasis,
          routingQuality: result?.routingQuality,
          geometryMatch: result?.geometryMatch,
          warnings: result?.warnings ?? []
        });
      }
    }],
    [StepType.RING, {
      scheduled: true,
      dynamic: true,
      concurrency: "provider",
      vehicle: true,
      normalize: step => ({
        origin: { ...origin },
        destination: { ...destination },
        ...(step.duration === undefined ? {} : {
          fallbackDurationSeconds: minutesToSeconds(step.duration, "duration")
        })
      }),
      async estimate(step, context) {
        try {
          const result = validateEstimate(await context.calculateDrivingTimes({
            origin: step.origin,
            destination: step.destination,
            departureTime: step.departureTime
          }));
          return { ...result, durationSource: "traffic" };
        } catch (error) {
          if (step.fallbackDurationSeconds === undefined) throw error;
          return {
            durationSeconds: step.fallbackDurationSeconds,
            durationSource: "fixed-fallback",
            warnings: [{
              code: "RING_FIXED_DURATION_FALLBACK",
              message: "Driving time could not be calculated; the supplied duration was used.",
              cause: publicError(error)
            }]
          };
        }
      }
    }]
  ]);

  for (const [type, handler] of Object.entries(stepHandlers)) {
    if (
      type === StepType.BUS_OPTIONS || type === StepType.WAIT
      || typeof handler?.normalize !== "function" || typeof handler?.estimate !== "function"
    ) {
      throw new TypeError(`Invalid journey step handler: ${type}`);
    }
    handlers.set(type, handler);
  }
  return handlers;
}
