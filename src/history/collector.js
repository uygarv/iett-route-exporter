import { IettArchiveClient } from "../clients/iett-archive-client.js";
import { HistoryRepository } from "./repository.js";
import { importRange, localDate, shiftDate } from "./time.js";
import { errorDiagnostics } from "../shared/error-diagnostics.js";

export function createHistoryCollector({ repository = new HistoryRepository(),
  client = new IettArchiveClient(), clock = Date.now,
  logger = entry => console.log(JSON.stringify(entry)) } = {}) {
  return {
    async sync({ from, to, days = 30, force = false, automatic = false, refresh = false,
      retryNow = !automatic, retryOnly = false, signal } = {}) {
      const today = localDate(clock());
      ({ from, to } = importRange({ from, to, days }, clock()));
      return repository.withIngestionLock(async (locked, disconnected) => {
        const activeSignal = signal ? AbortSignal.any([signal, disconnected]) : disconnected;
        if (automatic) {
          const bounds = await locked.bounds();
          from = bounds.first_date ?? from;
          if (retryOnly && bounds.last_date) to = bounds.last_date;
          if (!retryOnly) await locked.requeueProxyFailures();
        }
        await locked.enqueueRange(from, to, { force,
          ...(refresh ? { refreshSince: shiftDate(to, -2), refreshDate: today } : {}) });
        const summary = { from, to, scheduled: 0, success: 0, empty: 0, failed: 0 };
        const processed = [];
        for (;;) {
          activeSignal.throwIfAborted();
          const job = await locked.claimNextDay(from, to, { retryNow, exclude: processed });
          if (!job) break;
          const { date, version, attempt } = job;
          processed.push(date);
          summary.scheduled++;
          const start = Number(clock());
          logger({ event: "history.import.started", at: new Date(start).toISOString(), date, attempt });
          let phase = "response_headers";
          try {
            const records = await client.fetchDay(date, { signal: activeSignal });
            activeSignal.throwIfAborted();
            phase = "database";
            logger({ event: "history.import.saving", at: new Date(Number(clock())).toISOString(), date, sourceCount: records.length });
            const outcome = await locked.saveDay(date, records, version);
            summary[outcome.status] += 1;
            logger({ event: "history.import", at: new Date(Number(clock())).toISOString(), date, ...outcome, durationMs: Number(clock()) - start });
          } catch (error) {
            if (disconnected.aborted) throw error;
            if (activeSignal.aborted) {
              await locked.releaseDay(date);
              logger({ event: "history.import.cancelled", at: new Date(Number(clock())).toISOString(), date,
                code: "HISTORY_IMPORT_CANCELLED", durationMs: Number(clock()) - start });
              throw activeSignal.reason;
            }
            error.details = { phase, ...error.details };
            if (error.code === "IETT_ARCHIVE_PROXY_UNAVAILABLE") {
              const attempted = error.details.attempts?.some(entry => entry.requestSent !== false) ?? error.details.requestSent === true;
              const waiting = await locked.deferForProxy(date, { from, to, error, version, attempted });
              summary.deferred = 1;
              logger({ event: "history.waiting_for_proxy", at: new Date(Number(clock())).toISOString(), date,
                ...errorDiagnostics(error), ...waiting, durationMs: Number(clock()) - start });
              break;
            }
            await locked.markFailure(date, error, "failed", version);
            summary.failed += 1;
            logger({ event: "history.import", at: new Date(Number(clock())).toISOString(), date, status: "failed", ...errorDiagnostics(error),
              durationMs: Number(clock()) - start });
          }
        }
        logger({ event: "history.sync", at: new Date(Number(clock())).toISOString(), ...summary });
        return summary;
      });
    }
  };
}
