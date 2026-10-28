import cron from "node-cron";
import { localDate, TIME_ZONE } from "./time.js";
import { errorDiagnostics } from "../shared/error-diagnostics.js";

export function startHistoryScheduler({ collector, repository, clock = Date.now, schedule = cron.schedule,
  setTimer = setTimeout, clearTimer = clearTimeout,
  logger = entry => console.log(JSON.stringify(entry)) }) {
  const controller = new AbortController();
  let current;
  let planning;
  let timer;
  let planVersion = 0;
  let dailyPending = false;
  const hour = new Intl.DateTimeFormat("en-GB", { timeZone: TIME_ZONE, hour: "2-digit", hourCycle: "h23" });

  function cancelTimer() {
    planVersion++;
    if (timer !== undefined) clearTimer(timer);
    timer = undefined;
  }
  function logError(error, fallback) {
    if (!controller.signal.aborted) {
      logger({ event: "history.worker.error", at: new Date(Number(clock())).toISOString(), date: localDate(clock()),
        ...errorDiagnostics(error, fallback) });
    }
  }
  async function planNextRetry(retryDelay = 0, kind = "retry") {
    const version = ++planVersion;
    if (controller.signal.aborted || current) return;
    let delay = retryDelay;
    let runCollector = retryDelay > 0;
    if (!retryDelay) {
      try {
        const next = await repository.nextRetryAt();
        const at = next == null ? Infinity : new Date(next).getTime();
        if (Number.isNaN(at)) throw new Error("Invalid history retry timestamp.");
        const wait = Math.max(1, at - Number(clock()));
        delay = Math.min(wait, 60_000);
        runCollector = wait <= 60_000;
      } catch (error) {
        logError(error, "HISTORY_RETRY_SCHEDULE_FAILED");
        delay = 60_000;
        runCollector = true;
      }
    }
    if (version !== planVersion || controller.signal.aborted || current) return;
    timer = setTimer(() => {
      timer = undefined;
      if (runCollector) return run(kind);
      planning = planNextRetry(0, kind);
      return planning;
    }, delay);
  }
  function run(kind = "retry") {
    if (controller.signal.aborted) return Promise.resolve();
    if (current) {
      if (kind === "daily") dailyPending = true;
      return current;
    }
    cancelTimer();
    let retryDelay = 0;
    let nextKind = "retry";
    current = Promise.resolve().then(async () => {
      do {
        dailyPending = false;
        retryDelay = 0;
        nextKind = "retry";
        try {
          const refresh = kind === "daily" || kind === "startup" && Number(hour.format(clock())) >= 4;
          const outcome = await collector.sync({ automatic: true, retryOnly: kind === "retry",
            refresh, signal: controller.signal });
          if (outcome?.locked === false) {
            retryDelay = 30_000;
            nextKind = kind;
          }
        } catch (error) {
          logError(error, "HISTORY_WORKER_FAILED");
          retryDelay = 60_000;
          nextKind = kind;
        }
        kind = "daily";
      } while (dailyPending && !controller.signal.aborted);
    }).finally(() => {
      current = undefined;
      planning = planNextRetry(retryDelay, nextKind);
      return planning;
    });
    return current;
  }
  const task = schedule("0 4 * * *", () => run("daily"), { timezone: TIME_ZONE, noOverlap: true });
  const ready = run("startup");
  return {
    ready,
    async stop() {
      task.stop();
      controller.abort();
      cancelTimer();
      await current;
      await planning;
      task.destroy();
    }
  };
}
