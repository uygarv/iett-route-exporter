import { formatTimestamp, localDate, TIME_ZONE } from "./time.js";
import { StepType } from "./types.js";

const STATUS_LABELS = Object.freeze({
  feasible: "Suitable",
  calculated: "Calculated",
  late: "Misses the arrival deadline",
  missed: "Required departure time has passed",
  "departure-too-early": "Requires leaving before your earliest allowed departure",
  "connection-missed": "Connection cannot be reached",
  "no-departure": "No reachable departure",
  "no-option": "No suitable option",
  skipped: "Not evaluated",
  error: "Could not be calculated"
});

const NOTE_LABELS = Object.freeze({
  IETT_GEOMETRY_APPROXIMATION: "Travel time was estimated using a road route close to the bus route.",
  RING_FIXED_DURATION_FALLBACK: "A traffic-based estimate was unavailable; the supplied fixed duration was used.",
  DEPARTURE_BEFORE_REQUESTED_TIME: "This option requires leaving before your earliest allowed departure.",
  ARRIVAL_DEADLINE_EXCEEDED: "Estimated arrival exceeds the arrival deadline or its safety buffer.",
  CONNECTION_MISSED: "A connection cannot be reached in time, including the boarding buffer.",
  HOME_DEPARTURE_PASSED: "The required departure time has already passed.",
  NO_REACHABLE_DEPARTURE: "None of the supplied departures can be reached in time.",
  NO_DEPARTURES: "No departures were supplied for this option.",
  EMPTY_OPTION: "This option is empty.",
  EMPTY_OPTIONS: "No alternatives were supplied.",
  INVALID_STEP_TYPE: "A journey step has a missing or unsupported transport type.",
  INVALID_BUS_OPTIONS: "The transport alternatives are incorrectly formatted."
});

function transportLabel(step, title = false) {
  switch (step.type) {
    case StepType.WALK: return "Walk";
    case StepType.MBUS: return "Metrobus";
    case StepType.METRO: return step.line ? title ? step.line : `${step.line} metro` : "Metro";
    case StepType.BUS: return step.line ? `Bus ${step.line}` : "Bus";
    case StepType.RING: return "Campus shuttle";
    case StepType.WAIT: return "Wait";
    default: {
      const name = String(step.type ?? "Unknown transport").toLowerCase().replaceAll("_", " ");
      return name[0].toUpperCase() + name.slice(1);
    }
  }
}

function minutes(seconds) {
  return typeof seconds === "number" && Number.isFinite(seconds)
    ? Math.round(seconds / 60) : null;
}

function timestamp(value) {
  const parsed = typeof value === "string" ? Date.parse(value) : NaN;
  return Number.isFinite(parsed) ? parsed : null;
}

function summarizeOption(option, id, date) {
  const steps = option.steps ?? [];
  const departure = option.homeDepartureTime ?? option.departureTime ?? null;
  const times = [departure, option.arrivalTime, ...steps.flatMap(step => [step.startTime, step.endTime])];
  // Use dated times for the whole option if any step is outside the root date.
  // This also covers departures before midnight and explicitly dated later days.
  const includeDate = times.some(value => {
    const parsed = timestamp(value);
    return parsed !== null && localDate(parsed) !== date;
  });
  const displayTime = value => {
    const parsed = timestamp(value);
    if (parsed === null) return null;
    const formatted = formatTimestamp(parsed);
    return includeDate ? formatted : formatted.slice(11, 16);
  };
  const vehicleSteps = steps.filter(step => step.type !== StepType.WALK && step.type !== StepType.WAIT);
  const labels = (vehicleSteps.length ? vehicleSteps : steps.filter(step => step.type !== StepType.WAIT))
    .map(step => transportLabel(step, true));
  const notes = [...(option.reasons ?? []), ...(option.warnings ?? [])]
    .map(note => NOTE_LABELS[note.code] ?? note.message)
    .filter(Boolean);
  // Retain important estimate qualifications even if a provider omits its warning.
  for (const step of steps) {
    if (step.durationSource === "fixed-fallback") notes.push(NOTE_LABELS.RING_FIXED_DURATION_FALLBACK);
    if (step.routingQuality === "tomtom-geometry-approximate") notes.push(NOTE_LABELS.IETT_GEOMETRY_APPROXIMATION);
  }
  return {
    id,
    route: labels.join(" + ") || "Unavailable route",
    departure: displayTime(departure),
    arrival: displayTime(option.arrivalTime),
    durationMinutes: minutes(option.durationSeconds),
    transfers: option.transferCount ?? null,
    status: STATUS_LABELS[option.status] ?? "Could not be calculated",
    steps: steps.map(step => ({
      transport: transportLabel(step),
      ...(step.startStation ? { from: step.startStation } : {}),
      ...(step.endStation ? { to: step.endStation } : {}),
      departure: displayTime(step.startTime),
      arrival: displayTime(step.endTime),
      durationMinutes: minutes(step.durationSeconds)
    })),
    ...(notes.length ? { notes: [...new Set(notes)] } : {})
  };
}

function summarize(result, options, bestId) {
  const recommendedIndex = bestId === null ? -1 : options.findIndex(option => option.id === bestId);
  return {
    date: result.date,
    timezone: TIME_ZONE,
    recommendedOptionId: recommendedIndex === -1 ? null : String(recommendedIndex + 1),
    options: options.map((option, index) => summarizeOption(option, String(index + 1), result.date))
  };
}

// Keep provider diagnostics, scoring and internal identifiers inside the service.
// HTTP consumers receive only the information needed to describe each journey.
export function summarizeEvaluation(result) {
  const candidates = result.options.flatMap(group => group.candidates);
  candidates.sort((a, b) => (a.rank ?? Infinity) - (b.rank ?? Infinity));
  return summarize(result, candidates, result.bestOption?.id ?? null);
}

export function summarizeCalculation(result) {
  const options = result.options ?? [{ ...result, id: "default" }];
  const bestId = result.options ? result.bestOptionId : result.status === "calculated" ? "default" : null;
  return summarize(result, options, bestId ?? null);
}
