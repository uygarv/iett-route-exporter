import assert from "node:assert/strict";
import test from "node:test";
import { createJourneyService } from "../src/services/journey-service.js";
import { AppError } from "../src/shared/errors.js";
import { StepType } from "../src/journeys/types.js";

const date = "2026-10-19";
const morning = Date.parse(`${date}T06:00:00+03:00`);
const bus = (departures, extra = {}) => ({
  type: "BUS", route: "19_D_D0", line: "19", startStation: "UZUNÇAYIR METROBÜS",
  endStation: "YEDİTEPE ÜNİVERSİTESİ KAMPÜSÜ", departures, ...extra
});
const request = routes => ({ date, arrivalTime: "09:00", routes });
const busResult = duration => ({
  provider: "tomtom-orbis",
  requestedTrafficMode: "live",
  trafficTimeContext: "scheduled",
  trafficDataBasis: "historical-with-known-live-events",
  total: { estimatedDurationSeconds: duration, liveTrafficDelaySeconds: 60 }
});
const candidates = result => result.options.flatMap(option => option.candidates);
const at = (time, day = date) => `${day}T${time}:00.000+03:00`;

function service(options = {}) {
  return createJourneyService({
    clock: () => morning,
    calculateBusTimes: async () => { throw new Error("Unexpected BUS calculation"); },
    calculateDrivingTimes: async () => { throw new Error("Unexpected RING calculation"); },
    ...options
  });
}

test("evaluates every MBUS-19 departure with its own traffic and recommends the highest-scoring on-time departure", async () => {
  const calls = [];
  const planner = service({
    calculateBusTimes: async (route, options) => {
      calls.push({ route, ...options });
      return busResult({ "07:48": 2400, "08:05": 2100, "08:22": 2700 }[options.departureTime.slice(11, 16)]);
    }
  });
  const result = await planner.evaluateJourneys(request({ "MBUS-19": {
    "10": bus(["07.48", "8.05", "08:22", "08.05"], { departure: "8.05" }),
    "2": { type: "MBUS", duration: "13" },
    "1": { type: "WALK", duration: 15 }
  } }));

  assert.equal(calls.length, 3);
  assert.deepEqual(calls.map(call => call.departureTime).sort(), [at("07:48"), at("08:05"), at("08:22")]);
  assert.equal(calls[0].route, "19_D_D0");
  assert.equal(calls[0].startStation, "UZUNÇAYIR METROBÜS");
  assert.equal(calls[0].dwellTimeSeconds, undefined); // Keep the existing service's default.
  assert.equal(result.bestOption.homeDepartureTime, at("07:37"));
  assert.equal(result.bestOption.arrivalTime, at("08:40"));
  assert.equal(result.bestOption.durationSeconds, 63 * 60);
  assert.equal(result.bestOption.arrivalMarginSeconds, 20 * 60);
  assert.deepEqual(result.bestOption.steps.map(step => step.type), ["WALK", "MBUS", "BUS"]);
  assert.equal(result.bestOption.steps[1].startTime, at("07:52"));
  assert.equal(result.bestOption.steps[1].endTime, at("08:05"));
  assert.equal(result.bestOption.steps[2].durationSeconds, 2100);
  assert.equal(result.bestOption.steps[2].trafficDelaySeconds, 60);
  assert.equal(result.bestOption.steps[2].trafficDataBasis, "historical-with-known-live-events");
  const late = candidates(result).find(candidate => candidate.status === "late");
  assert.equal(late.arrivalTime, at("09:07"));
  assert.equal(late.latenessSeconds, 420);
  assert.equal(result.options[0].bestCandidateId, result.bestOption.id);
});

test("WALK, METRO, and MBUS use measured durations, including when no step has a timetable", async () => {
  const result = await service().evaluateJourneys(request({ fixed: {
    "1": { type: "WALK", duration: 10 },
    "2": { type: "METRO", line: "M4", duration: 20 },
    "3": { type: "MBUS", duration: 13 }
  } }));
  assert.equal(result.bestOption.homeDepartureTime, at("08:17"));
  assert.equal(result.bestOption.arrivalTime, at("09:00"));
  assert.equal(result.bestOption.transferCount, 1);
  assert.equal(result.bestOption.waitingDurationSeconds, 0);
  assert.ok(result.bestOption.steps.every(step => step.durationSource === "fixed"));
});

test("approximation metrics survive evaluation and forward calculation and remain eligible", async () => {
  for (const local of [false, true]) {
    const geometryMatch = { valid: true, quality: "approximate", orderedMaximumDeviationMeters: 110,
      ...(local ? { acceptanceBasis: "stop-preserving-local-alternative", referenceGeometryValid: false,
        referenceGeometryReasons: ["REFERENCE_WRONG_DIRECTION"], alternatives: [
          { fromStationIndex: 13, toStationIndex: 14, referenceLengthMeters: 841, returnedLengthMeters: 504 }
        ] } : {}) };
    const warnings = [{ code: local ? "IETT_LOCAL_ROUTE_APPROXIMATION" : "IETT_GEOMETRY_APPROXIMATION" }];
    const planner = service({ calculateBusTimes: async () => ({ ...busResult(600), geometryMatch,
      routingQuality: "tomtom-geometry-approximate", warnings }) });
    const route = { "1": bus(["08:00"]) };
    const evaluated = await planner.evaluateJourneys(request({ approximate: route }));
    assert.deepEqual(evaluated.bestOption.steps[0].geometryMatch, geometryMatch);
    assert.deepEqual(evaluated.bestOption.steps[0].warnings, warnings);
    const calculated = await planner.calculateJourney({ date, departureTime: "07:00", route });
    const busStep = calculated.steps.find(step => step.type === "BUS");
    assert.deepEqual(busStep.geometryMatch, geometryMatch);
    assert.deepEqual(busStep.warnings, warnings);
  }
});

test("uses the Istanbul date instead of the UTC date when date is omitted", async () => {
  const planner = service({ clock: () => Date.parse("2026-10-18T21:30:00Z") });
  const result = await planner.evaluateJourneys({ arrivalTime: "09:00", routes: {
    walk: { "1": { type: "WALK", duration: 10 } }
  } });
  assert.equal(result.date, date);
  assert.equal(result.generatedAt, at("00:30"));
  assert.equal(result.bestOption.homeDepartureTime, at("08:50"));
});

test("applies boarding and arrival buffers, includes final walking, and avoids adding bus dwell twice", async () => {
  const result = await service({ calculateBusTimes: async () => busResult(40 * 60) }).evaluateJourneys({
    ...request({ buffered: {
      "1": { type: "WALK", duration: 10 }, "2": bus(["08:00"]),
      "3": { type: "WALK", duration: 10 }
    } }), boardingBufferMinutes: 2, arrivalBufferMinutes: 5
  });
  assert.equal(result.effectiveArrivalTime, at("08:55"));
  assert.equal(result.bestOption.homeDepartureTime, at("07:48"));
  assert.equal(result.bestOption.arrivalTime, at("08:50"));
  assert.equal(result.bestOption.waitingDurationSeconds, 120);
  assert.equal(result.bestOption.durationSeconds, 62 * 60);
  assert.deepEqual(result.bestOption.steps.map(step => step.type), ["WALK", "WAIT", "BUS", "WALK"]);
  assert.equal(result.bestOption.steps[1].boardingBufferSeconds, 120);
});

test("builds multiple scheduled connections with waits and reports missed connections without impossible timestamps", async () => {
  const result = await service({
    calculateBusTimes: async () => busResult(20 * 60),
    calculateDrivingTimes: async () => ({ durationSeconds: 15 * 60 })
  }).evaluateJourneys(request({ connections: {
    "1": { type: "WALK", duration: 10 }, "2": bus(["08:00"]),
    "3": { type: "WALK", duration: 5 },
    "4": { type: "RING", departures: ["08:24", "08:30"] },
    "5": { type: "WALK", duration: 5 }
  } }));
  assert.equal(result.bestOption.homeDepartureTime, at("07:50"));
  assert.equal(result.bestOption.arrivalTime, at("08:50"));
  assert.equal(result.bestOption.waitingDurationSeconds, 300);
  const missed = candidates(result).find(candidate => candidate.status === "connection-missed");
  assert.equal(missed.arrivalTime, null);
  assert.equal(missed.reasons[0].arrivalAtStop, at("08:25"));
  assert.equal(missed.reasons[0].departureTime, at("08:24"));
  assert.equal(missed.steps.at(-2).startTime, null);
  assert.equal(missed.steps.at(-1).status, "unreachable");
  assert.equal(missed.steps.at(-1).durationSeconds, 300);
});

test("boarding buffer also applies to subsequent transfers and exact boarding deadlines are reachable", async () => {
  const result = await service({ calculateBusTimes: async () => busResult(10 * 60) }).evaluateJourneys({
    ...request({ connections: { "1": bus(["08:00"]), "2": bus(["08:11", "08:12"]) } }),
    boardingBufferMinutes: 2
  });
  assert.equal(candidates(result).find(candidate => candidate.departures[1].departureTime === at("08:11")).status, "connection-missed");
  assert.equal(result.bestOption.steps.filter(step => step.type === "WAIT").length, 2);
  assert.equal(result.bestOption.waitingDurationSeconds, 240);
  assert.equal(result.bestOption.arrivalTime, at("08:22"));
});

test("RING uses traffic per departure with the correct lat/lng coordinates and ignores its fallback on success", async () => {
  const calls = [];
  const result = await service({ calculateDrivingTimes: async options => {
    calls.push(options);
    return { durationSeconds: options.departureTime.includes("08:15") ? 1200 : 600, trafficDelaySeconds: 90 };
  } }).evaluateJourneys(request({ metro: {
    "1": { type: "METRO", duration: 20 },
    "2": { type: "RING", duration: 15, departures: ["8.15", "8.30"] }
  } }));
  assert.equal(calls.length, 2);
  assert.deepEqual(calls[0].origin, { lat: 40.979940, lng: 29.128038 });
  assert.deepEqual(calls[0].destination, { lat: 40.974683, lng: 29.153881 });
  assert.equal(candidates(result).find(candidate => candidate.departures[0].departureTime === at("08:15")).steps[1].durationSeconds, 1200);
  assert.equal(result.bestOption.steps[1].durationSeconds, 600);
  assert.equal(result.bestOption.arrivalTime, at("08:40"));
  assert.equal(result.bestOption.steps[1].durationSource, "traffic");
});

test("RING fallback reports the cause, is per option, and is retried on the next evaluation", async () => {
  let calls = 0;
  let failed = true;
  const planner = service({ calculateDrivingTimes: async () => {
    calls += 1;
    if (failed) throw new AppError(502, "TOMTOM_TIMEOUT", "Timed out.");
    return { durationSeconds: 600 };
  } });
  const input = request({ ring: { "1": { type: "BUS_OPTIONS", options: {
    short: { type: "RING", departure: "08:15", duration: 15 },
    long: { type: "RING", departure: "08:15", duration: 25 }
  } } } });
  const first = await planner.evaluateJourneys(input);
  assert.equal(calls, 1);
  assert.deepEqual(candidates(first).map(candidate => candidate.durationSeconds), [900, 1500]);
  assert.equal(first.bestOption.steps[0].durationSource, "fixed-fallback");
  assert.equal(first.bestOption.warnings[0].cause.code, "TOMTOM_TIMEOUT");
  failed = false;
  const second = await planner.evaluateJourneys(input);
  assert.equal(calls, 2);
  assert.ok(candidates(second).every(candidate => candidate.steps[0].durationSource === "traffic"));
});

test("RING without a fallback reports a calculation error, and malformed driving results use the fallback", async () => {
  const result = await service({ calculateDrivingTimes: async () => ({ durationSeconds: NaN }) })
    .evaluateJourneys(request({
      noFallback: { "1": { type: "RING", departure: "08:00" } },
      fallback: { "1": { type: "RING", departure: "08:00", duration: 15 } }
    }));
  assert.equal(result.options.find(option => option.id === "noFallback").candidates[0].status, "error");
  assert.equal(result.options.find(option => option.id === "noFallback").candidates[0].reasons[0].code, "INVALID_TRAVEL_DURATION");
  assert.equal(result.bestOption.routeId, "fallback");
});

test("expands nested BUS_OPTIONS and preserves empty/missing departures as skipped alternatives", async () => {
  const result = await service({ calculateDrivingTimes: async () => ({ durationSeconds: 600 }) })
    .evaluateJourneys(request({ alternatives: { "1": { type: "BUS_OPTIONS", options: {
      "": {}, "19": { route: "19_D_D0", departures: [] },
      nested: { type: "BUS_OPTIONS", options: {
        RING: { type: "RING", duration: 15, departures: ["08:15"] }
      } }
    } } } }));
  assert.equal(candidates(result).length, 3);
  assert.deepEqual(candidates(result).slice(1).map(candidate => candidate.status), ["skipped", "skipped"]);
  assert.deepEqual(new Set(candidates(result).slice(1).map(candidate => candidate.reasons[0].code)), new Set(["EMPTY_OPTION", "NO_DEPARTURES"]));
  assert.equal(result.bestOption.selections.length, 2);
  assert.equal(result.bestOption.selections[1].optionId, "RING");
});

test("isolates missing types, stop errors, failed departures, and malformed estimates", async () => {
  const calls = [];
  const result = await service({ calculateBusTimes: async (route, options) => {
    calls.push(options);
    if (options.startStation === "KÖPRÜŞÜ KAVŞAK") {
      throw new AppError(400, "START_STATION_NOT_FOUND", "No matching stop.");
    }
    if (options.departureTime.includes("08:00")) throw new AppError(502, "TOMTOM_TIMEOUT", "Timed out.");
    if (options.departureTime.includes("08:10")) return busResult(-1);
    return busResult(1200);
  } }).evaluateJourneys(request({
    missingType: { "1": { duration: 15 } },
    typo: { "1": bus(["07:55"], { startStation: "KÖPRÜŞÜ KAVŞAK" }) },
    partial: { "1": bus(["08:00", "08:10", "08:20"]) }
  }));
  assert.equal(calls.length, 4);
  assert.equal(result.options.find(option => option.id === "missingType").candidates[0].reasons[0].code, "INVALID_STEP_TYPE");
  assert.equal(result.options.find(option => option.id === "typo").candidates[0].reasons[0].code, "START_STATION_NOT_FOUND");
  assert.deepEqual(result.options.find(option => option.id === "partial").candidates.map(candidate => candidate.status), ["feasible", "error", "error"]);
  assert.equal(result.bestOption.homeDepartureTime, at("08:20"));
});

test("deduplicates identical bus calculations across routes but keeps different departures separate", async () => {
  let calls = 0;
  const result = await service({ calculateBusTimes: async () => {
    calls += 1;
    return busResult(600);
  } }).evaluateJourneys(request({
    first: { "1": bus(["08:00", "08:15"]) },
    second: { "1": bus(["08:00", "08:15"], { line: "Another label" }) }
  }));
  assert.equal(calls, 2);
  assert.equal(candidates(result).length, 4);
  assert.equal(new Set(candidates(result).map(candidate => candidate.id)).size, 4);
});

test("honors a configured concurrency limit across simultaneous evaluations and shares pending calls", async () => {
  let active = 0;
  let maximum = 0;
  let calls = 0;
  const planner = service({ maxConcurrency: 4, calculateBusTimes: async () => {
    calls += 1;
    active += 1;
    maximum = Math.max(maximum, active);
    await new Promise(resolve => setTimeout(resolve, 5));
    active -= 1;
    return busResult(600);
  } });
  const input = request({ bus: { "1": bus(Array.from({ length: 12 }, (_, i) => `08:${String(i).padStart(2, "0")}`)) } });
  await Promise.all([planner.evaluateJourneys(input), planner.evaluateJourneys(input)]);
  assert.equal(maximum, 4);
  assert.equal(calls, 12);
});

test("duplicate branches do not occupy concurrency slots needed by independent journeys", async () => {
  let release;
  const blocked = new Promise(resolve => { release = resolve; });
  const calls = [];
  const planner = service({ maxConcurrency: 2, calculateBusTimes: async route => {
    calls.push(route);
    await blocked;
    return busResult(600);
  } });
  const pending = planner.evaluateJourneys(request({
    first: { "1": bus(["08:00"], { route: "SHARED", line: "first label" }) },
    second: { "1": bus(["08:00"], { route: "SHARED", line: "second label" }) },
    third: { "1": bus(["08:00"], { route: "SHARED", line: "third label" }) },
    independent: { "1": bus(["08:00"], { route: "INDEPENDENT" }) }
  }));
  try {
    await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual(calls, ["SHARED", "INDEPENDENT"]);
  } finally {
    release();
    await pending;
  }
});

test("the default eight slots are shared by BUS and RING provider work", async () => {
  let active = 0;
  let maximum = 0;
  const track = async () => {
    active += 1;
    maximum = Math.max(maximum, active);
    await new Promise(resolve => setTimeout(resolve, 5));
    active -= 1;
  };
  const planner = service({
    calculateBusTimes: async () => { await track(); return busResult(600); },
    calculateDrivingTimes: async () => { await track(); return { durationSeconds: 600 }; }
  });
  const departures = Array.from({ length: 12 }, (_, i) => `08:${String(i).padStart(2, "0")}`);
  const result = await planner.evaluateJourneys(request({
    bus: { "1": bus(departures) },
    ring: { "1": { type: "RING", departures } }
  }));
  assert.equal(maximum, 8);
  assert.equal(candidates(result).length, 24);
});

test("evaluate and calculate share only in-flight work and retry failed calls on later requests", async () => {
  let calls = 0;
  let release;
  const blocked = new Promise(resolve => { release = resolve; });
  const planner = service({ maxConcurrency: 1, calculateBusTimes: async () => {
    calls += 1;
    if (calls === 1) {
      await blocked;
      throw new AppError(502, "TOMTOM_TIMEOUT", "Timed out.");
    }
    return busResult(600);
  } });
  const route = { "1": bus(["08:00"]) };
  const evaluations = Promise.all([
    planner.evaluateJourneys(request({ shared: route })),
    planner.calculateJourney({ date, departureTime: "08:00", route })
  ]);
  try {
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(calls, 1);
  } finally {
    release();
  }
  const [evaluated, calculated] = await evaluations;
  assert.equal(candidates(evaluated)[0].status, "error");
  assert.equal(calculated.status, "error");
  const retry = await planner.evaluateJourneys(request({ shared: route }));
  assert.equal(calls, 2);
  assert.equal(retry.bestOption.arrivalTime, at("08:10"));
  await planner.evaluateJourneys(request({ shared: route }));
  assert.equal(calls, 3); // Successful persistent caching belongs to the providers.
});

test("custom dynamic handlers retain the shared estimate concurrency limit", async () => {
  let active = 0;
  let maximum = 0;
  const planner = service({ maxConcurrency: 2, stepHandlers: { CUSTOM: {
    scheduled: false, dynamic: true, vehicle: false,
    normalize: step => ({ name: step.name }),
    estimate: async () => {
      active += 1;
      maximum = Math.max(maximum, active);
      await new Promise(resolve => setTimeout(resolve, 5));
      active -= 1;
      return { durationSeconds: 600 };
    }
  } } });
  await planner.evaluateJourneys(request(Object.fromEntries(Array.from({ length: 6 }, (_, index) => [
    String(index), { "1": { type: "CUSTOM", name: String(index) } }
  ]))));
  assert.equal(maximum, 2);
});

test("rejects invalid concurrency configuration before provider work", () => {
  for (const maxConcurrency of [0, 33, -1, 1.5, "4", NaN, null]) {
    assert.throws(() => service({ maxConcurrency }), RangeError);
  }
});

test("rejects excessive combinations before calling any provider, including providers in earlier routes", async () => {
  let calls = 0;
  const planner = service({ calculateBusTimes: async () => { calls += 1; return busResult(600); } });
  const departures = Array.from({ length: 9 }, (_, i) => `08:0${i}`);
  await assert.rejects(planner.evaluateJourneys(request({
    small: { "1": bus(["07:00"]) },
    large: { "1": bus(departures), "2": bus(departures), "3": bus(departures) }
  })), { code: "TOO_MANY_CANDIDATES", status: 400 });
  assert.equal(calls, 0);
});

test("keeps missed and late options in the response and rechecks the clock after provider work", async () => {
  let now = morning;
  const planner = service({ clock: () => now, calculateBusTimes: async () => {
    now = Date.parse(at("08:01"));
    return busResult(600);
  } });
  const result = await planner.evaluateJourneys(request({ old: { "1": bus(["08:00"]) } }));
  assert.equal(result.bestOption, null);
  assert.equal(candidates(result)[0].status, "missed");
  assert.equal(candidates(result)[0].arrivesOnTime, true);
  assert.equal(candidates(result)[0].canStillDepart, false);
  assert.equal(result.recommendationReason, "NO_FEASIBLE_OPTION");

  const late = await service({ calculateBusTimes: async () => busResult(600) })
    .evaluateJourneys(request({ late: { "1": bus(["09:20"]) } }));
  assert.equal(late.bestOption, null);
  assert.equal(candidates(late)[0].arrivalTime, at("09:30"));
});

test("accepts arrival and home departure exactly on the deadline, and detects a one-second overrun", async () => {
  const planner = service({ clock: () => Date.parse(at("08:00")), calculateBusTimes: async () => busResult(3600) });
  const result = await planner.evaluateJourneys(request({ exact: { "1": bus(["08:00"]) } }));
  assert.equal(result.bestOption.status, "feasible");
  assert.equal(result.bestOption.arrivalMarginSeconds, 0);
  const late = await service({ calculateBusTimes: async () => busResult(3601) })
    .evaluateJourneys(request({ overrun: { "1": bus(["08:00"]) } }));
  assert.equal(candidates(late)[0].latenessSeconds, 1);
  assert.equal(late.bestOption, null);
});

test("supports departure from home on the previous date and arrival after midnight without rolling timetables forward", async () => {
  const result = await service({
    clock: () => Date.parse("2026-10-18T23:00:00+03:00"),
    calculateBusTimes: async () => busResult(600)
  }).evaluateJourneys({ ...request({ night: {
    "1": { type: "WALK", duration: 20 }, "2": bus(["00:10"])
  } }), arrivalTime: "00:30" });
  assert.equal(result.bestOption.homeDepartureTime, at("23:50", "2026-10-18"));
  assert.equal(result.bestOption.arrivalTime, at("00:20"));
  const crossing = await service({ calculateBusTimes: async () => busResult(1200) })
    .evaluateJourneys({ ...request({ night: { "1": bus(["23:50"]) } }), arrivalTime: "23:59" });
  assert.equal(candidates(crossing)[0].arrivalTime, at("00:10", "2026-10-20"));
  assert.equal(candidates(crossing)[0].status, "late");
});

test("ranks by score and retains deterministic tie-breaking", async () => {
  const planner = service({ calculateBusTimes: async route => busResult({ short: 1200, long: 1800, lateStart: 1200 }[route]) });
  const tieRoutes = {
    z: { "1": { type: "METRO", duration: 5 }, "2": bus(["08:00"], { route: "short" }) },
    a: { "1": { type: "WALK", duration: 5 }, "2": bus(["08:00"], { route: "short" }) },
    b: { "1": { type: "WALK", duration: 5 }, "2": bus(["08:00"], { route: "short" }) },
    longer: { "1": { type: "WALK", duration: 5 }, "2": bus(["08:00"], { route: "long" }) }
  };
  const first = await planner.evaluateJourneys(request(tieRoutes));
  assert.equal(first.bestOption.routeId, "a");
  const second = await planner.evaluateJourneys(request({ ...tieRoutes,
    latest: { "1": bus(["08:10"], { route: "lateStart" }) }
  }));
  assert.equal(second.bestOption.routeId, "latest");
  const reordered = await planner.evaluateJourneys(request(Object.fromEntries(Object.entries(tieRoutes).reverse())));
  assert.equal(reordered.bestOption.id, first.bestOption.id);
});

test("a new step type can be registered without changes to the planning engine", async () => {
  const planner = service({ stepHandlers: { FERRY: {
    scheduled: false, dynamic: false, vehicle: true,
    normalize: step => ({ durationSeconds: Number(step.duration) * 60, name: step.name }),
    estimate: step => ({ durationSeconds: step.durationSeconds, durationSource: "fixed" })
  } } });
  const result = await planner.evaluateJourneys(request({ ferry: {
    "1": { type: "FERRY", name: "School ferry", duration: 20 }
  } }));
  assert.equal(result.bestOption.steps[0].name, "School ferry");
  assert.equal(result.bestOption.homeDepartureTime, at("08:40"));
  assert.ok(Object.isFrozen(StepType));
});

test("validates top-level dates, times and buffers, and isolates invalid per-route inputs", async () => {
  const planner = service();
  for (const input of [null, {}, { routes: [] }, request({}),
    { ...request({ a: {} }), date: "2026-02-30" },
    { ...request({ a: {} }), arrivalTime: "24:00" },
    { ...request({ a: {} }), boardingBufferMinutes: -1 },
    { ...request({ a: {} }), arrivalBufferMinutes: false }]) {
    await assert.rejects(planner.evaluateJourneys(input), error => error.status === 400);
  }
  const result = await planner.evaluateJourneys(request({
    empty: {}, order: { nope: { type: "WALK", duration: 5 } },
    negative: { "1": { type: "WALK", duration: -1 } },
    missing: { "1": bus(undefined) },
    invalid: { "1": bus(["08:60"]) },
    array: { "1": bus("08:00") },
    options: { "1": { type: "BUS_OPTIONS", options: [] } },
    good: { "1": { type: "WALK", duration: 5 } }
  }));
  assert.ok(result.options.slice(1).every(option => option.candidates[0].status === "error"));
  assert.equal(result.bestOption.routeId, "good");
});

test("departureTime alone scores eligible journeys without an implicit arrival deadline", async () => {
  const calls = [];
  const result = await service({ calculateBusTimes: async (route, options) => {
    calls.push(options);
    return busResult({ "07:48": 1200, "08:05": 4800, "08:22": 1800 }[options.departureTime.slice(11, 16)]);
  } }).evaluateJourneys({ date, departureTime: "07:30", routes: {
    bus: {
      "1": { type: "WALK", duration: 15 }, "2": { type: "MBUS", duration: 13 },
      "3": bus(["07:48", "08:05", "08:22"])
    }
  } });
  assert.equal(result.mode, "depart-after");
  assert.equal(result.departureTime, at("07:30"));
  assert.equal(result.targetArrivalTime, null);
  assert.equal(result.effectiveArrivalTime, null);
  assert.equal(result.arrivalTime, null);
  assert.equal(calls.length, 3);
  assert.equal(result.bestOption.homeDepartureTime, at("07:54"));
  assert.equal(result.bestOption.arrivalTime, at("08:52"));
  assert.equal(result.bestOption.arrivalMarginSeconds, null);
  assert.equal(result.bestOption.latenessSeconds, null);
  assert.equal(result.recommendationReason, "HIGHEST_FEASIBLE_SCORE");
  assert.equal(candidates(result).find(candidate => candidate.status === "departure-too-early").departures[0].departureTime, at("07:48"));
  assert.equal(candidates(result).find(candidate => candidate.status === "departure-too-early").reasons[0].code, "DEPARTURE_BEFORE_REQUESTED_TIME");
  assert.equal(candidates(result)[1].status, "feasible"); // No implicit 09:00 deadline.
  assert.equal(result.options[0].bestCandidateId, result.bestOption.id);
});

test("departureTime alone starts fixed-duration routes at the requested time", async () => {
  const result = await service().evaluateJourneys({ departureTime: "2026-10-20T08:50:00+03:00", routes: {
    slow: { "1": { type: "WALK", duration: 20 } },
    fast: { "1": { type: "WALK", duration: 10 } }
  } });
  assert.equal(result.date, "2026-10-20");
  assert.equal(result.bestOption.routeId, "fast");
  assert.equal(result.bestOption.homeDepartureTime, at("08:50", "2026-10-20"));
  assert.equal(result.bestOption.arrivalTime, at("09:00", "2026-10-20"));
  assert.ok(candidates(result).every(candidate => candidate.status === "feasible"));
});

test("both bounds filter ineligible journeys before scoring", async () => {
  const planner = service({ calculateBusTimes: async (route, options) => busResult(
    options.departureTime.includes("08:22") ? 2700 : 2100
  ) });
  const input = { ...request({ bus: {
    "1": { type: "WALK", duration: 28 }, "2": bus(["07:48", "08:05", "08:22"])
  } }), departureTime: "07:30" };
  const result = await planner.evaluateJourneys(input);
  assert.equal(result.mode, "arrive-by");
  assert.equal(result.bestOption.homeDepartureTime, at("07:37"));
  assert.deepEqual(candidates(result).map(candidate => candidate.status), ["feasible", "departure-too-early", "late"]);
  assert.equal(result.recommendationReason, "HIGHEST_FEASIBLE_SCORE");
  const impossible = await planner.evaluateJourneys({ ...input, departureTime: "07:40" });
  assert.equal(impossible.bestOption, null);
});

test("both bounds and buffers apply to fixed-duration routes", async () => {
  const result = await service().evaluateJourneys({ ...request({
    long: { "1": { type: "WALK", duration: 15 } },
    short: { "1": { type: "WALK", duration: 5 } }
  }), departureTime: "08:50", arrivalBufferMinutes: 5 });
  assert.equal(result.bestOption.routeId, "short");
  assert.equal(result.bestOption.homeDepartureTime, at("08:50"));
  assert.equal(result.bestOption.arrivalTime, at("08:55"));
  assert.equal(candidates(result).find(candidate => candidate.routeId === "long").status, "late");
});

test("all departures compete on score with any combination of time bounds", async () => {
  for (const bounds of [{ arrivalTime: "09:00" }, { departureTime: "08:00" },
    { departureTime: "08:00", arrivalTime: "09:00" }]) {
    const calls = [];
    const result = await service({
      calculateBusTimes: async (route, options) => {
        calls.push(options.departureTime);
        return busResult({ "08:15": 2400, "08:25": 900, "08:35": 1200 }[options.departureTime.slice(11, 16)]);
      },
      calculateDrivingTimes: async () => ({ durationSeconds: 2400 })
    }).evaluateJourneys({ date, ...bounds, routes: { alternatives: {
      "1": { type: "WALK", duration: 10 },
      "2": { type: "BUS_OPTIONS", options: {
        bus: bus(["08:15", "08:25", "08:35"]),
        ring: { type: "RING", departure: "08:30" }
      } },
      "3": { type: "WALK", duration: 5 }
    } } });
    assert.deepEqual(calls.sort(), [at("08:15"), at("08:25"), at("08:35")]);
    assert.equal(candidates(result).length, 4);
    assert.equal(result.bestOption.homeDepartureTime, at("08:25"));
    assert.equal(result.bestOption.arrivalTime, at("09:00"));
    assert.equal(result.bestOption.departures[0].departureTime, at("08:35"));
    assert.equal(result.bestOption.selections[0].optionId, "bus");
    assert.equal(result.recommendationReason, "HIGHEST_FEASIBLE_SCORE");
    assert.equal(result.options[0].bestCandidateId, result.bestOption.id);
  }
});

test("scores complete journeys across all connections including waiting and the final walk", async () => {
  const calls = [];
  const result = await service({ calculateBusTimes: async (route, options) => {
    calls.push({ route, departureTime: options.departureTime });
    return busResult(route === "LAST" && options.departureTime.includes("08:15") ? 2400 : 600);
  } }).evaluateJourneys({ date, departureTime: "08:00", arrivalTime: "09:00", routes: {
    transfers: {
      "1": bus(["08:00", "08:05"], { route: "FIRST" }),
      "2": bus(["08:15", "08:25"], { route: "LAST" }),
      "3": { type: "WALK", duration: 5 }
    }
  } });
  assert.equal(calls.length, 4);
  assert.equal(candidates(result).length, 4);
  assert.equal(result.bestOption.homeDepartureTime, at("08:05"));
  assert.equal(result.bestOption.arrivalTime, at("08:40"));
  assert.equal(result.bestOption.waitingDurationSeconds, 600);
  assert.equal(result.bestOption.departures[1].departureTime, at("08:25"));
});

test("fixed-duration routes with both bounds start at departureTime and score their durations", async () => {
  const result = await service({ calculateBusTimes: async () => busResult(1200) }).evaluateJourneys({
    date, departureTime: "08:00", arrivalTime: "09:00", routes: {
      walk: { "1": { type: "WALK", duration: 10 } },
      bus: { "1": bus(["08:00"]) }
    }
  });
  assert.equal(result.bestOption.routeId, "walk");
  assert.equal(result.bestOption.homeDepartureTime, at("08:00"));
  assert.equal(result.bestOption.arrivalTime, at("08:10"));
});

test("a dated arrival infers tomorrow for time-only BUS and RING timetables", async () => {
  const calls = [];
  const result = await service({
    calculateBusTimes: async (route, options) => { calls.push(options); return busResult(600); },
    calculateDrivingTimes: async options => { calls.push(options); return { durationSeconds: 600 }; }
  }).evaluateJourneys({ arrivalTime: "2026-10-20T09:00:00+03:00", routes: {
    bus: { "1": bus(["08:00"]) },
    ring: { "1": { type: "RING", departure: "08:15" } }
  } });
  assert.equal(result.date, "2026-10-20");
  assert.equal(result.targetArrivalTime, at("09:00", "2026-10-20"));
  assert.equal(result.arrivalTime, "09:00");
  assert.deepEqual(calls.map(call => call.departureTime).sort(), [at("08:00", "2026-10-20"), at("08:15", "2026-10-20")]);
  assert.equal(result.bestOption.routeId, "ring");
});

test("one dated boundary anchors a clock-only boundary, with explicit date overriding that default", async () => {
  const planner = service();
  const routes = { walk: { "1": { type: "WALK", duration: 10 } } };
  const departureDated = await planner.evaluateJourneys({ departureTime: "2026-10-20T07:00", arrivalTime: "09:00", routes });
  assert.equal(departureDated.date, "2026-10-20");
  assert.equal(departureDated.departureTime, at("07:00", "2026-10-20"));
  assert.equal(departureDated.targetArrivalTime, at("09:00", "2026-10-20"));
  const arrivalDated = await planner.evaluateJourneys({ departureTime: "07:00", arrivalTime: "2026-10-20T09:00", routes });
  assert.equal(arrivalDated.departureTime, at("07:00", "2026-10-20"));
  const explicitDate = await planner.evaluateJourneys({ date, departureTime: "07:00", arrivalTime: "2026-10-20T09:00", routes });
  assert.equal(explicitDate.departureTime, at("07:00"));
  assert.equal(explicitDate.targetArrivalTime, at("09:00", "2026-10-20"));
});

test("explicitly dated departures support overnight journeys and keep equal clock times on different days distinct", async () => {
  const calls = [];
  const result = await service({ calculateBusTimes: async (route, options) => { calls.push(options); return busResult(600); } })
    .evaluateJourneys({ departureTime: "2026-10-19T23:45:00+03:00", arrivalTime: "2026-10-20T00:30:00+03:00", routes: {
      night: {
        "1": { type: "WALK", duration: 10 },
        "2": bus(["2026-10-20T00:10:00+03:00", "2026-10-21T00:10:00+03:00"])
      }
    } });
  assert.equal(result.date, date);
  assert.equal(result.bestOption.homeDepartureTime, at("00:00", "2026-10-20"));
  assert.equal(result.bestOption.arrivalTime, at("00:20", "2026-10-20"));
  assert.equal(new Set(candidates(result).map(candidate => candidate.id)).size, 2);
  assert.equal(calls.length, 2);
  assert.equal(candidates(result)[1].status, "late");
});

test("departure, departureTime and departures merge and deduplicate by instant across ISO offsets", async () => {
  let calls = 0;
  const result = await service({ calculateBusTimes: async () => { calls += 1; return busResult(600); } })
    .evaluateJourneys({ ...request({ merged: { "1": bus(["08.15", "2026-10-19T05:15:00Z"], {
      departure: "2026-10-19T08:15:00+03:00", departureTime: "2026-10-19T08:15"
    }) } }) });
  assert.equal(calls, 1);
  assert.equal(candidates(result).length, 1);
  assert.equal(result.bestOption.homeDepartureTime, at("08:15"));
  assert.equal(result.bestOption.id, "merged/1@08:15");
  const alias = await service({ calculateDrivingTimes: async () => ({ durationSeconds: 600 }) })
    .evaluateJourneys(request({ ring: { "1": { type: "RING", departures: [], departureTime: "08:15" } } }));
  assert.equal(alias.bestOption.steps[0].type, "RING");
});

test("ISO inputs normalize to Istanbul, including UTC dates that cross the local midnight", async () => {
  const result = await service({ calculateBusTimes: async () => busResult(600) }).evaluateJourneys({
    arrivalTime: "2026-10-19T22:30:00Z", routes: { bus: { "1": bus(["00:30"]) } }
  });
  assert.equal(result.date, "2026-10-20");
  assert.equal(result.arrivalTime, "01:30");
  assert.equal(result.targetArrivalTime, at("01:30", "2026-10-20"));
  assert.equal(result.bestOption.arrivalTime, at("00:40", "2026-10-20"));
});

test("date-times preserve seconds and milliseconds, including exact eligibility boundaries", async () => {
  const departureTime = "2026-10-19T07:30:01.250+03:00";
  const result = await service({ calculateBusTimes: async () => busResult(60) }).evaluateJourneys({
    departureTime, arrivalTime: "2026-10-19T07:31:01.250+03:00", routes: {
      bus: { "1": bus([departureTime]) }
    }
  });
  assert.equal(result.bestOption.homeDepartureTime, departureTime);
  assert.equal(result.bestOption.arrivalTime, "2026-10-19T07:31:01.250+03:00");
  assert.equal(result.bestOption.arrivalMarginSeconds, 0);
});

test("rejects missing bounds, invalid ISO date-times, and reversed windows before provider calls", async () => {
  let calls = 0;
  const planner = service({ calculateBusTimes: async () => { calls += 1; return busResult(600); } });
  const routes = { bus: { "1": bus(["08:00"]) } };
  for (const input of [
    { routes }, { routes, departureTime: null }, { routes, arrivalTime: "2026-02-30T09:00:00Z" },
    { routes, departureTime: "2026-10-20T24:00:00+03:00" },
    { routes, departureTime: "2026-10-20T08:00:60+03:00" },
    { routes, departureTime: "2026-10-20T08:00:00+24:00" },
    { routes, departureTime: "2026-10-20T09:00", arrivalTime: "2026-10-20T08:00" },
    { routes, date, departureTime: "09:00", arrivalTime: "08:00" }
  ]) {
    await assert.rejects(planner.evaluateJourneys(input), error => error.status === 400);
  }
  assert.equal(calls, 0);
  const perRoute = await planner.evaluateJourneys(request({
    invalid: { "1": bus(["2026-02-30T08:00:00+03:00"]) },
    valid: { "1": bus(["08:00"]) }
  }));
  assert.equal(perRoute.options.find(option => option.id === "invalid").candidates[0].status, "error");
  assert.equal(perRoute.bestOption.routeId, "valid");
  assert.equal(calls, 1);
});
