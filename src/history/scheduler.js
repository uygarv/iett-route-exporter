import cron from "node-cron";
import { localDate, TIME_ZONE } from "./time.js";

export function startHistoryScheduler({ collector, clock = Date.now, schedule = cron.schedule,
  logger = entry => console.log(JSON.stringify(entry)) }) {
  const controller = new AbortController();
  let current;
  const hour = new Intl.DateTimeFormat("en-GB", { timeZone: TIME_ZONE, hour: "2-digit", hourCycle: "h23" });
  async function run(startup = false) {
    if (current || controller.signal.aborted) return;
    const afterFour = Number(hour.format(clock())) >= 4;
    current = collector.sync({ automatic: true, retryOnly: !startup && !afterFour,
      refresh: afterFour, signal: controller.signal }).catch(error => {
      if (!controller.signal.aborted) logger({ event: "history.worker.error", date: localDate(clock()), code: error.code ?? "HISTORY_WORKER_FAILED" });
    });
    try { await current; } finally { current = undefined; }
  }
  // After 04:00 the daily refresh is enqueued once, recorded durably per day.
  const task = schedule("0 * * * *", () => run(), { timezone: TIME_ZONE, noOverlap: true });
  const ready = run(true);
  return {
    ready,
    async stop() {
      task.stop();
      controller.abort();
      await current;
      task.destroy();
    }
  };
}
