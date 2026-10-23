import assert from "node:assert/strict";
import test from "node:test";
import { createJourneyService } from "../src/services/journey-service.js";
import { calculateJourney } from "../src/index.js";
import { AppError } from "../src/shared/errors.js";

const date = "2026-10-19";
const at = (time, day = date) => `${day}T${time}:00.000+03:00`;
const bus = (departures, extra = {}) => ({
  type: "BUS", route: "19_D_D0", line: "19", startStation: "UZUNÇAYIR METROBÜS",
  endStation: "YEDİTEPE ÜNİVERSİTESİ KAMPÜSÜ", departures, ...extra
});
const busResult = seconds => ({
  total: { estimatedDurationSeconds: seconds, liveTrafficDelaySeconds: 60 },
  provider: "tomtom-orbis", trafficDataBasis: "historical-with-known-live-events"
});
function planner(options = {}) {
  return createJourneyService({
    clock: () => Date.parse(at("06:00")),
    calculateBusTimes: async () => { throw new Error("Unexpected BUS call"); },
    calculateDrivingTimes: async () => { throw new Error("Unexpected RING call"); },
    ...options
  });
}

test("calculates one fixed route from the exact departure, with no ranking or arrival-deadline fields", async () => {
  const result = await planner().calculateJourney({ departureTime: at("08:00"), routeId: "metro", route: {
    "1": { type: "WALK", duration: 10 }, "2": { type: "METRO", duration: 20 },
    "3": { type: "WALK", duration: 5 }
  } });
  assert.equal(result.status, "calculated");
  assert.equal(result.startTime, at("08:00"));
  assert.equal(result.arrivalTime, at("08:35"));
  assert.equal(result.durationSeconds, 2100);
  assert.equal(result.elapsedDurationSeconds, 2100);
  assert.equal(result.waitingDurationSeconds, 0);
  assert.equal(result.transferCount, 0);
  assert.equal(result.routeId, "metro");
  assert.equal(result.startStep, "1");
  assert.deepEqual(result.skippedStepIds, []);
  for (const field of ["bestOption", "options", "candidates", "recommendationReason", "targetArrivalTime", "homeDepartureTime", "latenessSeconds"]) {
    assert.equal(Object.hasOwn(result, field), false, field);
  }
});

test("starts at step 2, calculates forward, and calls traffic only for the first catchable bus", async () => {
  const calls = [];
  const result = await planner({ calculateBusTimes: async (route, options) => {
    calls.push({ route, ...options });
    return busResult(2100);
  } }).calculateJourney({ startStep: 2, departureTime: at("07:50"), route: {
    "1": { type: "WALK", duration: 15 }, "2": { type: "MBUS", duration: "13" },
    "3": bus(["08:22", "07.48", "08.05", "08:05"])
  } });
  assert.equal(result.startTime, at("07:50"));
  assert.equal(result.arrivalTime, at("08:40"));
  assert.equal(result.durationSeconds, 50 * 60);
  assert.equal(result.waitingDurationSeconds, 120);
  assert.deepEqual(result.skippedStepIds, ["1"]);
  assert.deepEqual(result.steps.map(step => step.id), ["2", "wait:3", "3"]);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].departureTime, at("08:05"));
  assert.equal(calls[0].route, "19_D_D0");
  assert.equal(result.steps[2].trafficDelaySeconds, 60);
  assert.equal(result.steps[2].trafficDataBasis, "historical-with-known-live-events");
});

test("selects the next departure after the boarding buffer, without evaluating later trips for a better arrival", async () => {
  const calls = [];
  const result = await planner({ calculateBusTimes: async (route, options) => {
    calls.push(options);
    return busResult(600);
  } }).calculateJourney({ departureTime: at("08:04"), boardingBufferMinutes: 2, route: {
    "1": bus(["08:05", "08:06", "08:10"])
  } });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].departureTime, at("08:06"));
  assert.equal(result.waitingDurationSeconds, 120);
  assert.equal(result.steps[0].boardingBufferSeconds, 120);
  assert.equal(result.arrivalTime, at("08:16"));
  assert.equal(result.durationSeconds, 720);
});

test("checks later connections using the previous traffic-aware arrival and explicit walking steps", async () => {
  const calls = [];
  const result = await planner({ calculateBusTimes: async (route, options) => {
    calls.push(options.departureTime);
    return busResult(calls.length === 1 ? 1200 : 600);
  } }).calculateJourney({ departureTime: at("07:55"), route: {
    "1": bus(["08:00", "08:10"]), "2": { type: "WALK", duration: 5 },
    "3": bus(["08:24", "08:30"]), "4": { type: "WALK", duration: 5 }
  } });
  assert.deepEqual(calls, [at("08:00"), at("08:30")]);
  assert.equal(result.arrivalTime, at("08:45"));
  assert.equal(result.waitingDurationSeconds, 600);
  assert.equal(result.durationSeconds, 3000);
  assert.equal(result.transferCount, 1);
});

test("reports unavailable departures and leaves later steps unreachable without provider calls", async () => {
  for (const departures of [[], ["08:03"]]) {
    const result = await planner().calculateJourney({ departureTime: at("08:00"), route: {
      "1": { type: "WALK", duration: 5 }, "2": bus(departures),
      "3": { type: "METRO", duration: 10 }
    } });
    assert.equal(result.status, "no-departure");
    assert.equal(result.arrivalTime, null);
    assert.equal(result.durationSeconds, null);
    assert.equal(result.elapsedDurationSeconds, 300);
    assert.equal(result.reasons[0].code, departures.length ? "NO_REACHABLE_DEPARTURE" : "NO_DEPARTURES");
    assert.equal(result.reasons[0].readyAt, at("08:05"));
    assert.equal(result.steps[2].status, "unreachable");
    assert.equal(result.steps[2].durationSeconds, 600);
    assert.equal(result.steps[2].startTime, null);
  }
});

test("keeps partial progress on provider failure and does not calculate subsequent dynamic steps", async () => {
  let calls = 0;
  const result = await planner({ calculateBusTimes: async () => {
    calls += 1;
    throw new AppError(502, "TOMTOM_TIMEOUT", "Timed out.");
  } }).calculateJourney({ departureTime: at("08:00"), route: {
    "1": { type: "WALK", duration: 10 }, "2": bus(["08:15"]), "3": bus(["08:40"])
  } });
  assert.equal(calls, 1);
  assert.equal(result.status, "error");
  assert.equal(result.reasons[0].code, "TOMTOM_TIMEOUT");
  assert.equal(result.elapsedDurationSeconds, 900);
  assert.equal(result.arrivalTime, null);
  assert.equal(result.steps[2].startTime, at("08:15"));
  assert.equal(result.steps[2].endTime, null);
  assert.equal(result.steps[3].status, "unreachable");
});

test("uses RING traffic at the chosen departure and retries a fixed fallback on the next request", async () => {
  const calls = [];
  const service = planner({ calculateDrivingTimes: async options => {
    calls.push(options);
    if (calls.length === 1) throw new AppError(502, "TOMTOM_TIMEOUT", "Timed out.");
    return { durationSeconds: 600 };
  } });
  const input = { startStep: 2, departureTime: at("08:10"), route: {
    "1": { type: "METRO", duration: 20 },
    "2": { type: "RING", departures: ["08:15", "08:30"], duration: 15 }
  } };
  const fallback = await service.calculateJourney(input);
  assert.equal(fallback.arrivalTime, at("08:30"));
  assert.equal(fallback.steps[1].durationSource, "fixed-fallback");
  assert.equal(fallback.warnings[0].cause.code, "TOMTOM_TIMEOUT");
  const traffic = await service.calculateJourney(input);
  assert.equal(traffic.arrivalTime, at("08:25"));
  assert.equal(traffic.steps[1].durationSource, "traffic");
  assert.equal(calls.length, 2);
  assert.equal(calls[0].departureTime, at("08:15"));
  assert.deepEqual(calls[0].origin, { lat: 40.979940, lng: 29.128038 });
});

test("trims completed steps before validation, traffic calls and BUS_OPTIONS expansion", async () => {
  const result = await planner().calculateJourney({ startStep: "10", departureTime: at("08:00"), route: {
    "1": bus(["08:00"]),
    "2": { type: "BUS_OPTIONS", options: Object.fromEntries(Array.from({ length: 501 }, (_, i) => [String(i), {}])) },
    "3": { type: "UNKNOWN_TYPE", duration: -1 },
    "10": { type: "METRO", duration: 20 }
  } });
  assert.equal(result.arrivalTime, at("08:20"));
  assert.equal(result.startStep, "10");
  assert.deepEqual(result.skippedStepIds, ["1", "2", "3"]);
  assert.deepEqual(result.steps.map(step => step.id), ["10"]);
});

test("calculates every BUS_OPTIONS branch, preserves skipped options and selects earliest arrival", async () => {
  let calls = 0;
  let busCalls = 0;
  const service = planner({
    calculateDrivingTimes: async () => { calls += 1; return { durationSeconds: 1200 }; },
    calculateBusTimes: async () => { busCalls += 1; return busResult(600); }
  });
  const input = { departureTime: at("08:00"), route: {
    "1": { type: "BUS_OPTIONS", options: {
      "": {}, "19": { departures: [] }, RING: { type: "RING", departure: "08:15" }
    } }
  } };
  const unambiguous = await service.calculateJourney(input);
  assert.equal(unambiguous.arrivalTime, at("08:35"));
  assert.deepEqual(unambiguous.selections, [{ stepId: "1", optionId: "RING" }]);
  assert.equal(unambiguous.options.length, 3);
  assert.equal(unambiguous.options.filter(option => option.status === "skipped").length, 2);
  input.route["1"].options["19"] = bus(["08:20"]);
  const selected = await service.calculateJourney(input);
  assert.equal(selected.bestOptionId, "1=19");
  assert.equal(selected.arrivalTime, at("08:30"));
  assert.equal(selected.steps[1].id, "1/19");
  assert.equal(selected.options.find(option => option.id === "1=RING").arrivalTime, at("08:35"));
  assert.equal(selected.options.length, 3);
  assert.equal(calls, 2);
  assert.equal(busCalls, 1);
});

test("calculates nested BUS_OPTIONS and isolates invalid branches and traffic failures", async () => {
  const result = await planner().calculateJourney({ departureTime: at("08:00"), route: {
      "1": { type: "BUS_OPTIONS", options: {
        bus: bus(["08:05"]), outer: { type: "BUS_OPTIONS", options: {
          invalid: { type: "INVALID" }, walk: { type: "WALK", duration: 5 }
        } }
      } }
    }
  });
  assert.equal(result.arrivalTime, at("08:05"));
  assert.equal(result.steps[0].id, "1/outer/walk");
  assert.equal(result.selections.length, 2);
  assert.equal(result.bestOptionId, "1=outer/1%2Fouter=walk");
  assert.equal(result.options.length, 3);
  assert.equal(result.options.filter(option => option.status === "error").length, 2);
  assert.ok(result.options.every(option => Array.isArray(option.steps)));
});

test("validates the entire remaining route and single-route contract before provider work", async () => {
  let calls = 0;
  const service = planner({ calculateBusTimes: async () => { calls += 1; return busResult(600); } });
  const input = { departureTime: at("08:00"), route: { "1": bus(["08:05"]) } };
  for (const extra of [{ arrivalTime: "09:00" }, { routes: {} }, { startSteps: {} },
    { arrivalBufferMinutes: 5 }, { startStep: 0 }, { startStep: "02" }, { startStep: 2 },
    { optionSelections: null }, { optionSelections: [] }, { optionSelections: { "1": 1 } },
    { departureTime: "2026-02-30T08:00:00Z" }, { route: [] },
    { route: { named: { "1": { type: "WALK", duration: 5 } } } },
    { route: { "1": bus(["08:05"]), "2": { type: "UNKNOWN" } } }]) {
    await assert.rejects(service.calculateJourney({ ...input, ...extra }), error => error.status === 400);
  }
  assert.equal(calls, 0);
});

test("date-times infer tomorrow's timetable and preserve cross-midnight departures", async () => {
  const calls = [];
  const service = planner({ calculateBusTimes: async (route, options) => {
    calls.push(options);
    return busResult(600);
  } });
  const tomorrow = await service.calculateJourney({ departureTime: "2026-10-19T21:10:00Z", route: {
    "1": bus(["00:30"])
  } });
  assert.equal(tomorrow.date, "2026-10-20");
  assert.equal(tomorrow.startTime, at("00:10", "2026-10-20"));
  assert.equal(tomorrow.arrivalTime, at("00:40", "2026-10-20"));
  const overnight = await service.calculateJourney({ departureTime: at("23:50"), route: {
    "1": { type: "WALK", duration: 5 }, "2": bus(["2026-10-20T00:10:00+03:00"])
  } });
  assert.equal(overnight.arrivalTime, at("00:20", "2026-10-20"));
  assert.equal(calls[1].departureTime, at("00:10", "2026-10-20"));
});

test("defaults the start to the first actual key and departure to the current instant", async () => {
  const service = planner();
  const input = { route: { "3": { type: "WALK", duration: 5 } } };
  const implicit = await service.calculateJourney(input);
  const explicit = await service.calculateJourney({ ...input, departureTime: "now" });
  assert.equal(implicit.startStep, "3");
  assert.equal(implicit.startTime, at("06:00"));
  assert.equal(implicit.arrivalTime, at("06:05"));
  assert.deepEqual(implicit, explicit);
});

test("exports calculateJourney for direct JavaScript use without requiring HTTP", async () => {
  const result = await calculateJourney({ departureTime: at("08:00"), route: {
    "1": { type: "WALK", duration: 5 }
  } });
  assert.equal(result.arrivalTime, at("08:05"));
  assert.equal(result.status, "calculated");
});

test("BUS and RING without timetables use traffic at the time each step is reached", async () => {
  const calls = [];
  const result = await planner({
    calculateBusTimes: async (route, options) => { calls.push(options.departureTime); return busResult(1200); },
    calculateDrivingTimes: async options => { calls.push(options.departureTime); return { durationSeconds: 600 }; }
  }).calculateJourney({ departureTime: at("08:00"), boardingBufferMinutes: 2, route: {
    "1": { type: "WALK", duration: 5 }, "2": bus(undefined),
    "3": { type: "RING", duration: 15 }
  } });
  assert.deepEqual(calls, [at("08:05"), at("08:25")]);
  assert.equal(result.arrivalTime, at("08:35"));
  assert.equal(result.waitingDurationSeconds, 0);
  assert.equal(result.durationSeconds, 2100);
  assert.equal(result.steps[1].departureTime, at("08:05"));
});

test("selects options by the final arrival, including their effect on later connections", async () => {
  const calls = [];
  const result = await planner({ calculateBusTimes: async (route, options) => {
    calls.push({ route, departureTime: options.departureTime });
    if (route === "FAST") return busResult(600);
    return busResult(options.departureTime.includes("08:12") ? 2400 : 600);
  } }).calculateJourney({ departureTime: at("08:00"), route: {
    "1": { type: "BUS_OPTIONS", options: {
      fast: bus(undefined, { route: "FAST" }), slow: { type: "WALK", duration: 15 }
    } },
    "2": bus(["08:12", "08:20"])
  } });
  assert.equal(result.bestOptionId, "1=slow");
  assert.equal(result.arrivalTime, at("08:30"));
  assert.equal(result.options.find(option => option.id === "1=fast").arrivalTime, at("08:52"));
  assert.equal(calls.length, 3);
  assert.deepEqual(calls.filter(call => call.route !== "FAST").map(call => call.departureTime).sort(), [at("08:12"), at("08:20")]);
});

test("returns every combination when multiple steps have options", async () => {
  const result = await planner().calculateJourney({ departureTime: at("08:00"), route: {
    "1": { type: "BUS_OPTIONS", options: {
      fast: { type: "WALK", duration: 5 }, slow: { type: "WALK", duration: 10 }
    } },
    "2": { type: "BUS_OPTIONS", options: {
      long: { type: "WALK", duration: 20 }, short: { type: "WALK", duration: 5 }
    } }
  } });
  assert.equal(result.options.length, 4);
  assert.equal(new Set(result.options.map(option => option.id)).size, 4);
  assert.ok(result.options.every(option => option.selections.length === 2));
  assert.equal(result.bestOptionId, "1=fast/2=short");
  assert.equal(result.arrivalTime, at("08:10"));
});

test("shares prefix and equivalent provider calculations between options with stable tie-breaking", async () => {
  const calls = [];
  const result = await planner({ calculateBusTimes: async (route, options) => {
    calls.push({ route, departureTime: options.departureTime });
    return busResult(600);
  } }).calculateJourney({ departureTime: at("08:00"), route: {
    "1": bus(undefined, { route: "PREFIX" }),
    "2": { type: "BUS_OPTIONS", options: {
      B: bus(["08:15"], { line: "B label" }), A: bus(["08:15"], { line: "A label" })
    } }
  } });
  assert.equal(result.options.length, 2);
  assert.equal(result.bestOptionId, "2=A");
  assert.equal(result.arrivalTime, at("08:25"));
  assert.equal(calls.length, 2);
  assert.equal(calls.filter(call => call.route === "PREFIX").length, 1);
});

test("returns all unsuccessful options and a null bestOptionId when none can finish", async () => {
  const result = await planner().calculateJourney({ departureTime: at("08:00"), route: {
    "1": { type: "BUS_OPTIONS", options: {
      empty: {}, past: bus(["07:00"]), invalid: { type: "INVALID" }
    } }
  } });
  assert.equal(result.status, "no-option");
  assert.equal(result.bestOptionId, null);
  assert.equal(result.arrivalTime, null);
  assert.equal(result.durationSeconds, null);
  assert.equal(result.options.length, 3);
  assert.deepEqual(result.options.map(option => option.status), ["skipped", "no-departure", "error"]);
  assert.equal(result.reasons[0].code, "NO_CALCULABLE_OPTION");
});

test("rejects more than 500 option combinations before any provider call", async () => {
  let calls = 0;
  const service = planner({ calculateBusTimes: async () => { calls += 1; return busResult(600); } });
  const options = count => Object.fromEntries(Array.from({ length: count }, (_, i) => [String(i), { type: "WALK", duration: 1 }]));
  await assert.rejects(service.calculateJourney({ departureTime: at("08:00"), route: {
    "1": bus(["08:00"]),
    "2": { type: "BUS_OPTIONS", options: options(22) },
    "3": { type: "BUS_OPTIONS", options: options(24) }
  } }), { code: "TOO_MANY_OPTIONS", status: 400 });
  assert.equal(calls, 0);
});
