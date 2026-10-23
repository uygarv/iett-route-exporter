import assert from "node:assert/strict";
import test from "node:test";
import { normalizeScoring, scoreJourneyCandidates, DEFAULT_SCORING_WEIGHTS } from "../src/journeys/scoring.js";
import { createJourneyService } from "../src/services/journey-service.js";

const date = "2026-10-19";
const at = time => `${date}T${time}:00.000+03:00`;
const bus = (route, departures) => ({ type: "BUS", route, line: route, startStation: "START", endStation: "END", departures });
const providerResult = duration => ({ total: { estimatedDurationSeconds: duration } });
function planner(options = {}) {
  return createJourneyService({ clock: () => Date.parse(at("06:00")), ...options });
}
function candidate(id, time, durationSeconds, transferCount = 0, status = "feasible") {
  return { id, status, homeDepartureTime: at(time),
    arrivalTime: new Date(Date.parse(at(time)) + durationSeconds * 1_000).toISOString(),
    durationSeconds, transferCount };
}

test("default and partial weights are copied, with explicit zeros preserved", () => {
  assert.deepEqual(normalizeScoring(), { lateDeparture: 1, duration: 1, transfers: 15 });
  assert.deepEqual(normalizeScoring({}), DEFAULT_SCORING_WEIGHTS);
  assert.deepEqual(normalizeScoring({ weights: {} }), DEFAULT_SCORING_WEIGHTS);
  const input = { weights: { duration: 2, transfers: 0 } };
  const weights = normalizeScoring(input);
  input.weights.duration = 3;
  assert.deepEqual(weights, { lateDeparture: 1, duration: 2, transfers: 0 });
  assert.ok(Object.isFrozen(DEFAULT_SCORING_WEIGHTS));
});

test("invalid scoring is rejected before BUS or RING provider work", async () => {
  let calls = 0;
  const service = planner({ calculateBusTimes: async () => { calls += 1; return providerResult(600); },
    calculateDrivingTimes: async () => { calls += 1; return { durationSeconds: 600 }; } });
  for (const scoring of [null, [], "balanced", 1, { typo: 1 }, { weights: null }, { weights: [] },
    { weights: { lateDeparture: -1 } }, { weights: { duration: "1" } }, { weights: { duration: NaN } },
    { weights: { duration: Infinity } }, { weights: { transfers: 1_001 } }, { weights: { duration: true } },
    { weights: { unknown: 1 } }, { weights: { lateDeparture: 0, duration: 0, transfers: 0 } }]) {
    await assert.rejects(service.evaluateJourneys({ date, arrivalTime: "09:00", scoring, routes: {
      bus: { "1": bus("19", ["08:00"]) }, ring: { "1": { type: "RING", departure: "08:00" } }
    } }), error => error.status === 400 && error.code === "INVALID_SCORING");
  }
  assert.equal(calls, 0);
  assert.deepEqual(normalizeScoring({ weights: { duration: 1_000 } }), { lateDeparture: 1, duration: 1_000, transfers: 15 });
});

test("late departure, duration and transfers each affect the ranking through their own weights", () => {
  const a = candidate("early-short", "08:00", 600), b = candidate("late-long", "08:15", 1_200);
  assert.equal(scoreJourneyCandidates([a, b], normalizeScoring()).bestOption.id, b.id);
  assert.equal(scoreJourneyCandidates([a, b], normalizeScoring({ weights: { duration: 2 } })).bestOption.id, a.id);
  assert.equal(scoreJourneyCandidates([a, b], normalizeScoring({ weights: { lateDeparture: 0 } })).bestOption.id, a.id);
  const direct = candidate("direct", "08:00", 1_800), change = candidate("change", "08:00", 1_200, 1);
  assert.equal(scoreJourneyCandidates([direct, change], normalizeScoring()).bestOption.id, direct.id);
  assert.equal(scoreJourneyCandidates([direct, change], normalizeScoring({ weights: { transfers: 0 } })).bestOption.id, change.id);
});

test("score ties use arrival, then duration, then transfers, then stable ID", () => {
  const early = candidate("z", "08:00", 600), late = candidate("a", "08:10", 1_200);
  assert.equal(scoreJourneyCandidates([late, early], normalizeScoring()).bestOption.id, "z");
  const short = candidate("short", "08:05", 900), long = candidate("long", "08:00", 1_200);
  const transferOnly = normalizeScoring({ weights: { lateDeparture: 0, duration: 0, transfers: 1 } });
  assert.equal(scoreJourneyCandidates([long, short], transferOnly).bestOption.id, "short");
  const lessTransfers = candidate("z", "08:00", 600, 0), moreTransfers = candidate("a", "08:00", 600, 1);
  const durationOnly = normalizeScoring({ weights: { lateDeparture: 0, duration: 1, transfers: 0 } });
  assert.equal(scoreJourneyCandidates([moreTransfers, lessTransfers], durationOnly).bestOption.id, "z");
  const tie = [candidate("z", "08:00", 600), candidate("a", "08:00", 600)];
  assert.equal(scoreJourneyCandidates(tie, normalizeScoring()).bestOption.id, "a");
  assert.equal(scoreJourneyCandidates(tie.reverse(), normalizeScoring()).bestOption.id, "a");
});

test("presentation rounding does not decide ranks", () => {
  const earlier = candidate("earlier", "08:00", 100), shorter = candidate("shorter", "08:05", 99);
  const result = scoreJourneyCandidates([earlier, shorter], normalizeScoring({ weights: {
    lateDeparture: 0, duration: 1e-8, transfers: 0
  } }));
  assert.equal(earlier.score, 0);
  assert.equal(shorter.score, 0);
  assert.equal(result.bestOption.id, "shorter");
});

test("ineligible journeys cannot affect the reference or recommendation and keep stable order", () => {
  const eligible = candidate("good", "08:00", 3_600);
  const excluded = ["late", "missed", "connection-missed", "departure-too-early", "error", "skipped"]
    .map((status, i) => candidate(`excluded-${i}`, i ? "23:00" : "06:00", 1, 0, status));
  const result = scoreJourneyCandidates([...excluded, eligible], normalizeScoring());
  assert.equal(result.scoring.referenceDepartureTime, at("08:00"));
  assert.equal(result.bestOption.id, "good");
  assert.deepEqual([...excluded, eligible].sort(result.compare).map(c => c.id), ["good", ...excluded.map(c => c.id)]);
  for (const c of excluded) assert.deepEqual([c.score, c.rank, c.scoreBreakdown], [null, null, null]);
  const empty = scoreJourneyCandidates(excluded, normalizeScoring());
  assert.equal(empty.scoring.referenceDepartureTime, null);
  assert.equal(empty.bestOption, null);
});

test("an added earlier candidate shifts the reference but not pairwise score differences", () => {
  const a = candidate("a", "08:00", 900), b = candidate("b", "08:10", 1_800);
  scoreJourneyCandidates([a, b], normalizeScoring());
  const difference = a.score - b.score;
  scoreJourneyCandidates([a, b, candidate("outlier", "06:00", 20_000)], normalizeScoring());
  assert.equal(a.score - b.score, difference);
});

test("departure scoring uses full dates across Istanbul midnight", () => {
  const before = { ...candidate("before", "23:55", 1_200), homeDepartureTime: "2026-10-18T23:55:00+03:00",
    arrivalTime: at("00:15") };
  const after = candidate("after", "00:10", 1_200);
  const result = scoreJourneyCandidates([after, before], normalizeScoring());
  assert.equal(result.bestOption.id, "after");
  assert.equal(after.scoreBreakdown.lateDeparture, 15);
});

test("the supplied commute example selects 11T and ranks every feasible candidate globally", async () => {
  const service = planner({ calculateBusTimes: async (route, options) => providerResult(
    route === "16F" ? 2366 : route === "11T" ? 2081 : { "07:48": 2383, "08:05": 2477, "08:22": 2501 }[options.departureTime.slice(11, 16)]),
    calculateDrivingTimes: async options => ({ durationSeconds: { "08:15": 394, "08:30": 395, "08:40": 391, "08:45": 388 }[options.departureTime.slice(11, 16)] }) });
  const prefix = { "1": { type: "WALK", duration: 15 }, "2": { type: "MBUS", duration: 13 } };
  const input = { date, departureTime: "07:35", routes: {
    "16F": { ...prefix, "3": bus("16F", ["08:10"]) },
    "11T": { ...prefix, "3": bus("11T", ["08:15"]) },
    ring: { ...prefix, "3": { type: "METRO", duration: 20 }, "4": { type: "WALK", duration: 5 },
      "5": { type: "METRO", duration: 15 }, "6": { type: "RING", departures: ["08:15", "08:30", "08:40", "08:45"] } },
    "19": { ...prefix, "3": bus("19", ["07:48", "08:05", "08:22"]) }
  } };
  const result = await service.evaluateJourneys(input);
  const all = result.options.flatMap(group => group.candidates);
  const ranked = all.filter(c => c.rank !== null).sort((a, b) => a.rank - b.rank);
  assert.deepEqual(ranked.map(c => c.score), [-67.683333, -67.683333, -77.433333, -84.283333, -119.466667]);
  assert.deepEqual(ranked.map(c => c.routeId), ["11T", "19", "16F", "19", "ring"]);
  assert.deepEqual(ranked.map(c => c.rank), [1, 2, 3, 4, 5]);
  assert.equal(result.bestOption.routeId, "11T");
  assert.equal(result.bestOption.rank, 1);
  assert.equal(result.recommendationReason, "HIGHEST_FEASIBLE_SCORE");
  assert.equal(result.scoring.referenceDepartureTime, at("07:37"));
  assert.deepEqual(result.bestOption.scoreBreakdown, { lateDeparture: 10, duration: -62.683333, transfers: -15 });
  assert.deepEqual(result.options.map(g => g.id), ["11T", "19", "16F", "ring"]);
  assert.equal(result.options.find(g => g.id === "19").bestCandidateId, ranked[1].id);
  assert.ok(all.filter(c => c.status !== "feasible").every(c => c.score === null && c.rank === null));
  const deadline = await service.evaluateJourneys({ ...input, arrivalTime: "09:00" });
  const lateBus = deadline.options.find(g => g.id === "19").candidates.find(c => c.departures[0].departureTime === at("08:22"));
  assert.equal(lateBus.status, "late"); assert.equal(lateBus.score, null);
});

test("waiting is included in the duration penalty and invalid groups stay after scored groups", async () => {
  const service = planner({ calculateBusTimes: async () => providerResult(600) });
  const result = await service.evaluateJourneys({ date, arrivalTime: "09:00", routes: {
    invalidA: {},
    waited: { "1": bus("A", ["08:00"]), "2": bus("B", ["08:30"]) },
    invalidB: {}, direct: { "1": bus("C", ["08:00"]) }
  } });
  assert.deepEqual(result.options.map(group => group.id), ["direct", "waited", "invalidA", "invalidB"]);
  const waited = result.options.find(g => g.id === "waited").candidates[0];
  assert.equal(waited.waitingDurationSeconds, 1_200);
  assert.equal(waited.scoreBreakdown.duration, -40);
  assert.equal(waited.scoreBreakdown.transfers, -15);
});
