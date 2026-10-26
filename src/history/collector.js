import { IettArchiveClient } from "../clients/iett-archive-client.js";
import { HistoryRepository } from "./repository.js";
import { completedRange, localDate, shiftDate } from "./time.js";

export function createHistoryCollector({ repository = new HistoryRepository(),
  client = new IettArchiveClient(), clock = Date.now,
  logger = entry => console.log(JSON.stringify(entry)) } = {}) {
  return {
    async sync({ from, to, days = 30, force = false, automatic = false, refresh = false,
      retryNow = !automatic, retryOnly = false, signal } = {}) {
      const today = localDate(clock());
      to ??= shiftDate(today, -1);
      if (!Number.isInteger(days) || days < 1 || days > 36500) throw new RangeError("days must be an integer between 1 and 36500.");
      from ??= shiftDate(to, 1 - days);
      completedRange(from, to, clock());
      return repository.withIngestionLock(async (locked, disconnected) => {
        const activeSignal = signal ? AbortSignal.any([signal, disconnected]) : disconnected;
        if (automatic) {
          const bounds = await locked.bounds();
          from = bounds.first_date ?? from;
          if (retryOnly && bounds.last_date) to = bounds.last_date;
        }
        await locked.enqueueRange(from, to, { force,
          ...(refresh ? { refreshSince: shiftDate(to, -2), refreshDate: today } : {}) });
        const dates = await locked.dueDates(from, to, { retryNow });
        const summary = { from, to, scheduled: dates.length, success: 0, empty: 0, failed: 0 };
        for (const date of dates) {
          activeSignal.throwIfAborted();
          const start = Number(clock());
          await locked.markRunning(date);
          try {
            const records = await client.fetchDay(date, { signal: activeSignal });
            activeSignal.throwIfAborted();
            const outcome = await locked.saveDay(date, records);
            summary[outcome.status] += 1;
            logger({ event: "history.import", date, ...outcome, durationMs: Number(clock()) - start });
          } catch (error) {
            if (disconnected.aborted) throw error;
            await locked.markFailure(date, error);
            activeSignal.throwIfAborted();
            summary.failed += 1;
            logger({ event: "history.import", date, status: "failed", code: error.code ?? "HISTORY_IMPORT_FAILED",
              durationMs: Number(clock()) - start });
          }
        }
        logger({ event: "history.sync", ...summary });
        return summary;
      });
    }
  };
}
