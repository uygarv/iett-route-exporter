import { AppError } from "../shared/errors.js";
import { compareCandidates } from "./ranking.js";

export const DEFAULT_SCORING_WEIGHTS = Object.freeze({
  lateDeparture: 1,
  duration: 1,
  transfers: 15
});

const isRecord = value => value !== null && typeof value === "object" && !Array.isArray(value);
const roundScore = value => Number(value.toFixed(6)) || 0;

export function normalizeScoring(input) {
  function invalid(message) { throw new AppError(400, "INVALID_SCORING", message); }
  if (input === undefined) return { ...DEFAULT_SCORING_WEIGHTS };
  if (!isRecord(input) || Object.keys(input).some(key => key !== "weights")) {
    invalid("scoring must be an object containing only weights.");
  }
  if (input.weights === undefined) return { ...DEFAULT_SCORING_WEIGHTS };
  if (!isRecord(input.weights)) invalid("scoring.weights must be an object.");
  const weights = { ...DEFAULT_SCORING_WEIGHTS };
  for (const [key, value] of Object.entries(input.weights)) {
    if (!Object.hasOwn(DEFAULT_SCORING_WEIGHTS, key)) invalid(`Unknown scoring weight: ${key}.`);
    if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 1_000) {
      invalid(`scoring.weights.${key} must be a finite number from 0 to 1000.`);
    }
    weights[key] = value;
  }
  if (!Object.values(weights).some(value => value > 0)) invalid("At least one scoring weight must be positive.");
  return weights;
}

// Score once, globally, after all eligibility checks. Comparing unrounded
// second-based utilities keeps presentation rounding out of selection decisions.
export function scoreJourneyCandidates(candidates, weights) {
  const eligible = candidates.filter(candidate => candidate.status === "feasible");
  const reference = eligible.reduce((earliest, candidate) => !earliest
    || Date.parse(candidate.homeDepartureTime) < Date.parse(earliest.homeDepartureTime) ? candidate : earliest, null);
  const rawScores = new Map();
  for (const candidate of candidates) {
    candidate.score = null;
    candidate.rank = null;
    candidate.scoreBreakdown = null;
    if (candidate.status !== "feasible") continue;
    const lateDeparture = (Date.parse(candidate.homeDepartureTime) - Date.parse(reference.homeDepartureTime)) / 1_000
      * weights.lateDeparture;
    const duration = -candidate.durationSeconds * weights.duration;
    const transfers = -candidate.transferCount * 60 * weights.transfers;
    const raw = lateDeparture + duration + transfers;
    rawScores.set(candidate, raw);
    candidate.score = roundScore(raw / 60);
    candidate.scoreBreakdown = {
      lateDeparture: roundScore(lateDeparture / 60),
      duration: roundScore(duration / 60),
      transfers: roundScore(transfers / 60)
    };
  }
  function compare(first, second) {
    const firstEligible = rawScores.has(first), secondEligible = rawScores.has(second);
    if (firstEligible !== secondEligible) return firstEligible ? -1 : 1;
    if (!firstEligible) return 0; // Stable sort preserves all ineligible input order.
    return rawScores.get(second) - rawScores.get(first) || compareCandidates(first, second);
  }
  const ranked = [...eligible].sort(compare);
  ranked.forEach((candidate, index) => { candidate.rank = index + 1; });
  return {
    scoring: { weights: { ...weights }, referenceDepartureTime: reference?.homeDepartureTime ?? null },
    bestOption: ranked[0] ?? null,
    compare
  };
}
