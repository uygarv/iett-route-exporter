import assert from "node:assert/strict";
import test from "node:test";
import { startHistoryScheduler } from "../src/history/scheduler.js";

function virtualWorker({ now = Date.parse("2026-10-28T19:59:50Z"), nextRetryAt = async () => null,
  sync = async () => ({ locked: true }) } = {}) {
  const timers = new Map();
  const calls = [];
  const errors = [];
  let sequence = 0;
  let daily;
  let stopped = false;
  let destroyed = false;
  const time = {
    now: () => now,
    setNow: value => { now = value; },
    calls, timers, errors,
    daily: () => daily(),
    async advanceTo(target) {
      for (;;) {
        const next = [...timers].sort((a, b) => a[1].at - b[1].at)[0];
        if (!next || next[1].at > target) break;
        now = next[1].at;
        timers.delete(next[0]);
        await next[1].callback();
      }
      now = target;
    },
    taskStopped: () => stopped && destroyed
  };
  const worker = startHistoryScheduler({ clock: time.now,
    repository: { nextRetryAt: () => nextRetryAt(time) },
    collector: { sync: options => { calls.push({ at: now, ...options }); return sync(options, time); } },
    logger: entry => errors.push(entry),
    setTimer: (callback, delay) => { const id = ++sequence; timers.set(id, { at: now + delay, callback }); return id; },
    clearTimer: id => timers.delete(id),
    schedule: (expression, callback, options) => {
      assert.equal(expression, "0 4 * * *");
      assert.equal(options.timezone, "Europe/Istanbul");
      assert.equal(options.noOverlap, true);
      daily = callback;
      return { stop: () => { stopped = true; }, destroy: () => { destroyed = true; } };
    }
  });
  return { worker, time };
}

test("retries start at nextAttemptAt down to milliseconds without waiting for the next hour", async t => {
  const deadline = Date.parse("2026-10-28T20:00:38.118Z");
  let next = new Date(deadline);
  const { worker, time } = virtualWorker({ nextRetryAt: async () => next,
    sync: async options => { if (options.retryOnly) next = null; return { locked: true }; } });
  t.after(() => worker.stop());
  await worker.ready;
  assert.equal(time.calls.length, 1);
  await time.advanceTo(deadline - 1);
  assert.equal(time.calls.length, 1);
  await time.advanceTo(deadline);
  assert.equal(time.calls.length, 2);
  assert.equal(time.calls[1].at, deadline);
  assert.equal(time.calls[1].retryOnly, true);
  assert.equal(time.calls[1].refresh, false);
});

test("successive retry deadlines are recalculated and idle database checks never import early", async t => {
  const start = Date.parse("2026-10-28T19:00:00Z");
  const deadlines = [start + 10_123, start + 91_456];
  let queries = 0;
  const { worker, time } = virtualWorker({ now: start,
    nextRetryAt: async () => { queries++; return deadlines[0] ?? null; },
    sync: async options => { if (options.retryOnly) deadlines.shift(); return { locked: true }; } });
  t.after(() => worker.stop());
  await worker.ready;
  await time.advanceTo(start + 120_000);
  assert.deepEqual(time.calls.map(call => call.at), [start, start + 10_123, start + 91_456]);
  assert.ok(queries >= 4, "a future deadline is rechecked without an upstream import");
});

test("manual CLI changes made while idle are discovered before their retry deadline", async t => {
  const start = Date.parse("2026-10-28T19:00:00Z");
  let next = null;
  const { worker, time } = virtualWorker({ now: start, nextRetryAt: async () => next,
    sync: async options => { if (options.retryOnly) next = null; return { locked: true }; } });
  t.after(() => worker.stop());
  await worker.ready;
  next = new Date(start + 90_750);
  await time.advanceTo(start + 60_000);
  assert.equal(time.calls.length, 1);
  await time.advanceTo(start + 90_749);
  assert.equal(time.calls.length, 1);
  await time.advanceTo(start + 90_750);
  assert.equal(time.calls[1].at, start + 90_750);
});

test("a missed 04:00 refresh is queued while busy, then overdue retries run without overlap", async () => {
  const start = Date.parse("2026-10-28T00:59:00Z"); // 03:59 Istanbul
  let finish;
  let next = new Date(start + 20_000);
  let active = 0;
  let peak = 0;
  const { worker, time } = virtualWorker({ now: start, nextRetryAt: async () => next,
    sync: async options => {
      active++;
      peak = Math.max(peak, active);
      if (time.calls.length === 1) await new Promise(resolve => { finish = resolve; });
      if (options.retryOnly) next = null;
      active--;
      return { locked: true };
    } });
  try {
    await Promise.resolve();
    assert.equal(time.calls[0].retryOnly, false);
    assert.equal(time.calls[0].refresh, false);
    time.setNow(Date.parse("2026-10-28T01:03:00Z"));
    const daily = time.daily();
    assert.equal(time.calls.length, 1);
    finish();
    await worker.ready;
    await daily;
    assert.equal(time.calls.length, 2);
    assert.equal(time.calls[1].refresh, true);
    assert.equal(time.calls[1].retryOnly, false);
    await time.advanceTo(time.now() + 1);
    assert.equal(time.calls[2].retryOnly, true);
    assert.equal(time.calls[2].refresh, false);
    assert.equal(peak, 1);
  } finally { await worker.stop(); }
});

test("another collector's lock causes a bounded retry instead of a busy loop", async t => {
  const start = Date.parse("2026-10-28T19:00:00Z");
  let attempts = 0;
  const { worker, time } = virtualWorker({ now: start,
    sync: async () => ({ locked: ++attempts > 1 }) });
  t.after(() => worker.stop());
  await worker.ready;
  await time.advanceTo(start + 29_999);
  assert.equal(attempts, 1);
  await time.advanceTo(start + 30_000);
  assert.equal(attempts, 2);
  assert.equal(time.calls[1].retryOnly, false, "startup catch-up is preserved after a lost lock race");
});

test("failed daily cycles keep their daily intent and retry after a minute", async t => {
  const start = Date.parse("2026-10-28T01:00:00Z");
  let fail = false;
  const { worker, time } = virtualWorker({ now: start,
    sync: async () => {
      if (fail) { fail = false; throw new Error("private connection details"); }
      return { locked: true };
    } });
  t.after(() => worker.stop());
  await worker.ready;
  fail = true;
  await time.daily();
  await time.advanceTo(start + 60_000);
  assert.equal(time.calls.length, 3);
  assert.equal(time.calls[2].retryOnly, false);
  assert.equal(time.calls[2].refresh, true);
  assert.equal(time.errors[0].code, "HISTORY_WORKER_FAILED");
  assert.doesNotMatch(JSON.stringify(time.errors), /private/);
});

test("database scheduling errors back off and recover without dropping the worker", async t => {
  const start = Date.parse("2026-10-28T19:00:00Z");
  let queries = 0;
  const { worker, time } = virtualWorker({ now: start, nextRetryAt: async () => {
    if (++queries === 1) throw new Error("database unavailable");
    return null;
  } });
  t.after(() => worker.stop());
  await worker.ready;
  assert.equal(time.errors[0].code, "HISTORY_RETRY_SCHEDULE_FAILED");
  await time.advanceTo(start + 60_000);
  assert.equal(time.calls.length, 2);
  assert.equal(queries, 2);
});

test("shutdown cancels timers and ignores late scheduling-query results", async () => {
  let finishQuery;
  const { worker, time } = virtualWorker({ nextRetryAt: () => new Promise(resolve => { finishQuery = resolve; }) });
  for (let turn = 0; turn < 5 && !finishQuery; turn++) await Promise.resolve();
  assert.equal(typeof finishQuery, "function");
  const stopping = worker.stop();
  finishQuery(new Date(time.now() + 500));
  await stopping;
  await worker.ready;
  assert.equal(time.timers.size, 0);
  assert.ok(time.taskStopped());
  assert.ok(time.calls[0].signal.aborted);
  await time.daily();
  assert.equal(time.calls.length, 1);
});

test("an older retry query cannot replace a timer installed by a concurrent daily cycle", async t => {
  const start = Date.parse("2026-10-28T01:00:00Z");
  let finishOldQuery;
  let queries = 0;
  const { worker, time } = virtualWorker({ now: start, nextRetryAt: () => {
    if (++queries === 1) return new Promise(resolve => { finishOldQuery = resolve; });
    return queries === 2 ? new Date(start + 2_123) : null;
  } });
  t.after(() => worker.stop());
  for (let turn = 0; turn < 5 && !finishOldQuery; turn++) await Promise.resolve();
  await time.daily();
  finishOldQuery(new Date(start + 50_000));
  await worker.ready;
  assert.equal(time.timers.size, 1);
  assert.equal([...time.timers.values()][0].at, start + 2_123);
  await time.advanceTo(start + 2_123);
  assert.equal(time.calls.at(-1).retryOnly, true);
});
