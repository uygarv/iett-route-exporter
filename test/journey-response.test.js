import assert from "node:assert/strict";
import test from "node:test";
import { summarizeCalculation, summarizeEvaluation } from "../src/journeys/response.js";

const departure = "2026-10-20T08:00:00.000+03:00";
const arrival = "2026-10-20T08:20:00.000+03:00";
const date = "2026-10-20";
const fallbackNote = "A traffic-based estimate was unavailable; the supplied fixed duration was used.";
const warning = { code: "RING_FIXED_DURATION_FALLBACK", message: "Fixed duration used.", stepId: "2",
  cause: { code: "PROVIDER_UNAVAILABLE", details: { large: true } } };
const candidate = {
  id: "bus/2@08:10", routeId: "bus", rank: 1, score: -20,
  scoreBreakdown: { lateDeparture: 0, duration: -20, transfers: 0 },
  homeDepartureTime: departure, arrivalTime: arrival, durationSeconds: 1200,
  waitingDurationSeconds: 300, transferCount: 0, status: "feasible",
  selections: [{ stepId: "2", optionId: "RING" }], warnings: [warning], reasons: [],
  steps: [{ id: "2", type: "RING", startTime: departure, endTime: arrival,
    departureTime: departure, durationSeconds: 1200, durationSource: "fixed-fallback",
    geometryMatch: { points: Array(100).fill([1, 2]) }, warnings: [warning] }]
};

function evaluate(options, bestOption = options[0], extra = {}) {
  return summarizeEvaluation({ date, bestOption, options: [{ candidates: options }], ...extra });
}

function calculate(extra = {}) {
  return summarizeCalculation({ ...candidate, date, departureTime: departure,
    homeDepartureTime: undefined, startStep: "2", status: "calculated", ...extra });
}

test("summary flattens groups in global score order and remaps the recommendation without mutating data", () => {
  const third = { ...candidate, id: "third", rank: 3 };
  const second = { ...candidate, id: "second", rank: 2 };
  const failed = { ...candidate, id: "failed", rank: null, score: null, status: "error",
    reasons: [{ code: "BUS_FAILED", message: "Stop not found.", details: { large: true } }] };
  const input = { date, generatedAt: departure, bestOption: second,
    scoring: { weights: { duration: 1 } }, options: [
      { candidates: [candidate, third, failed] }, { candidates: [second] }
    ] };
  const before = structuredClone(input);
  const result = summarizeEvaluation(input);
  assert.deepEqual(Object.keys(result), ["date", "timezone", "recommendedOptionId", "options"]);
  assert.equal(result.recommendedOptionId, "2");
  assert.deepEqual(result.options.map(option => option.id), ["1", "2", "3", "4"]);
  assert.equal(result.options[3].status, "Could not be calculated");
  assert.deepEqual(result.options[3].notes, ["Stop not found.", fallbackNote]);
  assert.deepEqual(input, before);
  for (const key of ["geometryMatch", "details", "score", "rank", "selections", "durationSource", "stepId", "generatedAt"]) {
    assert.equal(JSON.stringify(result).includes(`"${key}"`), false, key);
  }
});

test("both endpoints use the approved compact schema, readable labels and deduplicated notes", () => {
  const expected = {
    date, timezone: "Europe/Istanbul", recommendedOptionId: "1",
    options: [{ id: "1", route: "Campus shuttle", departure: "08:00", arrival: "08:20",
      durationMinutes: 20, transfers: 0, status: "Suitable",
      steps: [{ transport: "Campus shuttle", departure: "08:00", arrival: "08:20", durationMinutes: 20 }],
      notes: [fallbackNote] }]
  };
  assert.deepEqual(evaluate([candidate]), expected);
  const calculated = calculate();
  assert.deepEqual(calculated, { ...expected, options: [{ ...expected.options[0], status: "Calculated" }] });
});

test("titles omit walking and waiting but include every vehicle in order; steps preserve stops and wait duration", () => {
  const steps = [
    { type: "WALK", durationSeconds: 900 }, { type: "MBUS", durationSeconds: 780 },
    { type: "METRO", line: "M4", durationSeconds: 1200 },
    { type: "METRO", line: "M8", durationSeconds: 900 },
    { type: "WAIT", durationSeconds: 90 },
    { type: "BUS", line: "19", startStation: "UZUNÇAYIR", endStation: "YEDİTEPE", durationSeconds: 901 }
  ];
  const option = evaluate([{ ...candidate, steps, warnings: [] }]).options[0];
  assert.equal(option.route, "Metrobus + M4 + M8 + Bus 19");
  assert.deepEqual(option.steps.map(step => step.transport), ["Walk", "Metrobus", "M4 metro", "M8 metro", "Wait", "Bus 19"]);
  assert.equal(option.steps[4].durationMinutes, 2);
  assert.equal(option.steps[5].durationMinutes, 15);
  assert.equal(option.steps[5].from, "UZUNÇAYIR");
  assert.equal(option.steps[5].to, "YEDİTEPE");
  assert.equal(Object.hasOwn(option.steps[0], "from"), false);
  assert.equal(Object.hasOwn(option, "notes"), false);
  assert.equal(evaluate([{ ...candidate, steps: [{ type: "WALK" }], warnings: [] }]).options[0].route, "Walk");
});

test("both endpoints round total and step durations to the nearest whole minute", () => {
  for (const [seconds, expected] of [[0, 0], [29, 0], [30, 1], [89, 1], [90, 2], [901, 15], [null, null]]) {
    const timed = { ...candidate, durationSeconds: seconds,
      steps: [{ type: "WALK", durationSeconds: seconds }] };
    const evaluated = evaluate([timed]).options[0];
    const calculated = calculate(timed).options[0];
    for (const option of [evaluated, calculated]) {
      assert.equal(option.durationMinutes, expected);
      assert.equal(option.steps[0].durationMinutes, expected);
    }
  }
});

test("failed options and partial steps remain visible without inventing times or recommendation", () => {
  const result = calculate({ status: "no-departure", arrivalTime: null, durationSeconds: null,
    warnings: [], reasons: [{ code: "NO_REACHABLE_DEPARTURE" }],
    steps: [{ type: "WALK", startTime: departure, endTime: arrival, durationSeconds: 1200 },
      { type: "BUS", line: "19", startTime: null, endTime: null, durationSeconds: null }] });
  assert.equal(result.recommendedOptionId, null);
  assert.equal(result.options[0].arrival, null);
  assert.equal(result.options[0].durationMinutes, null);
  assert.equal(result.options[0].status, "No reachable departure");
  assert.equal(result.options[0].steps[0].arrival, "08:20");
  assert.deepEqual(result.options[0].steps[1], {
    transport: "Bus 19", departure: null, arrival: null, durationMinutes: null
  });
  assert.deepEqual(result.options[0].notes, ["None of the supplied departures can be reached in time."]);
  const skipped = evaluate([{ ...candidate, steps: [], warnings: [], reasons: [{ code: "EMPTY_OPTION" }], status: "skipped" }], null);
  assert.equal(skipped.recommendedOptionId, null);
  assert.equal(skipped.options[0].route, "Unavailable route");
  assert.equal(skipped.options[0].status, "Not evaluated");
});

test("calculate maps the winning alternative by ID even if it is not first; no winner remains null", () => {
  const options = [{ ...candidate, id: "ring", status: "calculated" }, { ...candidate, id: "bus", status: "calculated" }];
  assert.equal(calculate({ options, bestOptionId: "bus" }).recommendedOptionId, "2");
  assert.equal(calculate({ options, bestOptionId: null }).recommendedOptionId, null);
  assert.equal(calculate({ options, bestOptionId: "missing" }).recommendedOptionId, null);
});

test("midnight, previous-day prefixes and later dated departures use full Istanbul ISO timestamps", () => {
  const cases = [
    ["2026-10-20T23:50:00+03:00", "2026-10-21T00:20:00+03:00"],
    ["2026-10-19T23:50:00+03:00", "2026-10-20T00:20:00+03:00"],
    ["2026-10-21T08:00:00+03:00", "2026-10-21T08:20:00+03:00"]
  ];
  for (const [start, end] of cases) {
    const option = evaluate([{ ...candidate, homeDepartureTime: start, arrivalTime: end,
      steps: [{ type: "BUS", line: "19", startTime: start, endTime: end }] }]).options[0];
    assert.equal(option.departure, start.replace("+03:00", ".000+03:00"));
    assert.equal(option.arrival, end.replace("+03:00", ".000+03:00"));
    assert.equal(option.steps[0].departure, option.departure);
    assert.equal(option.steps[0].arrival, option.arrival);
  }
  // Even when the overall journey is incomplete, a prefix crossing midnight has dates.
  const partial = calculate({ arrivalTime: null, steps: [
    { type: "WALK", startTime: "2026-10-20T23:50:00+03:00", endTime: "2026-10-21T00:10:00+03:00" }
  ] });
  assert.equal(partial.options[0].steps[0].arrival, "2026-10-21T00:10:00.000+03:00");
});

test("clock times use Istanbul rather than input offset or host timezone", () => {
  const option = evaluate([{ ...candidate, homeDepartureTime: "2026-10-19T22:00:00Z",
    arrivalTime: "2026-10-19T22:20:00Z", steps: [] }]).options[0];
  assert.equal(option.departure, "01:00");
  assert.equal(option.arrival, "01:20");
});

test("important quality warnings remain readable and all eligibility statuses are translated", () => {
  const labels = {
    late: "Misses the arrival deadline", missed: "Required departure time has passed",
    "departure-too-early": "Requires leaving before your earliest allowed departure",
    "connection-missed": "Connection cannot be reached", error: "Could not be calculated"
  };
  for (const [status, label] of Object.entries(labels)) {
    const option = evaluate([{ ...candidate, status, warnings: [],
      steps: [{ type: "BUS", routingQuality: "tomtom-geometry-approximate" }] }], null).options[0];
    assert.equal(option.status, label);
    assert.deepEqual(option.notes, ["Travel time was estimated using a road route close to the bus route."]);
  }
});
