import { AppError } from "../shared/errors.js";
import { requireCode } from "../shared/validation.js";
import { HistoryRepository } from "../history/repository.js";
import { historyRecord } from "../history/records.js";
import { completedRange, dateOnly, localDate, shiftDate, TIME_ZONE } from "../history/time.js";

function invalidCursor() {
  return new AppError(400, "INVALID_HISTORY_CURSOR", "The history cursor is invalid or does not match these filters.");
}

function decodeCursor(value) {
  if (value === undefined) return null;
  if (typeof value !== "string" || value.length > 2048 || !/^[A-Za-z0-9_-]+$/.test(value)) throw invalidCursor();
  try {
    const cursor = JSON.parse(Buffer.from(value, "base64url").toString("utf8"));
    if (cursor?.v !== 1 || typeof cursor.line !== "string" || typeof cursor.id !== "string"
      || !/^\d+$/.test(cursor.id) || BigInt(cursor.id) > 9_223_372_036_854_775_807n
      || !(cursor.routeCode === null || typeof cursor.routeCode === "string")) throw invalidCursor();
    for (const field of ["from", "to", "date"]) dateOnly(cursor[field]);
    if (cursor.date < cursor.from || cursor.date > cursor.to) throw invalidCursor();
    return cursor;
  } catch { throw invalidCursor(); }
}

export function createIettHistoryService({ repository = new HistoryRepository(), clock = Date.now } = {}) {
  return {
    async getHistory(lineCode, query = {}) {
      const line = requireCode(lineCode, "lineCode").toUpperCase();
      const cursor = decodeCursor(query.cursor);
      const routeCode = query.routeCode === undefined ? cursor?.routeCode ?? null
        : requireCode(query.routeCode, "routeCode").toUpperCase();
      const limit = query.limit === undefined ? 500
        : typeof query.limit === "string" && /^\d+$/.test(query.limit) ? Number(query.limit) : NaN;
      if (!Number.isInteger(limit) || limit < 1 || limit > 1000) {
        throw new AppError(400, "INVALID_HISTORY_LIMIT", "limit must be an integer between 1 and 1000.");
      }
      let from = query.from ?? cursor?.from;
      const to = query.to ?? cursor?.to ?? shiftDate(localDate(clock()), -1);
      if (from !== undefined) dateOnly(from, "from");
      dateOnly(to, "to");
      if (from !== undefined) completedRange(from, to, clock());
      else completedRange(to, to, clock());
      if (cursor && (cursor.line !== line || cursor.routeCode !== routeCode || cursor.to !== to || cursor.from !== from)) throw invalidCursor();

      try {
        if (from === undefined) from = (await repository.bounds()).first_date ?? to;
        // A filter ending before the first imported day is still a valid, empty query.
        if (query.from === undefined && !cursor && from > to) from = to;
        const options = { line, from, to, routeCode, limit, cursor };
        const [rows, days] = await Promise.all([repository.readHistory(options), repository.coverage(from, to)]);
        const hasMore = rows.length > limit;
        const page = rows.slice(0, limit);
        const last = page.at(-1);
        const successful = days.filter(day => day.last_success_at != null);
        const lastSuccessful = successful.reduce((latest, day) => {
          const timestamp = new Date(day.last_success_at).toISOString();
          return latest === null || timestamp > latest ? timestamp : latest;
        }, null);
        return {
          line, timezone: TIME_ZONE,
          data: page.map(historyRecord),
          pagination: { limit, hasMore, nextCursor: hasMore ? Buffer.from(JSON.stringify({
            v: 1, line, from, to, routeCode, date: last.record_date, id: String(last.source_id)
          })).toString("base64url") : null },
          coverage: {
            from, to, complete: successful.length === days.length,
            missingDates: days.filter(day => day.last_success_at == null).map(day => day.date),
            emptyDates: days.filter(day => day.status === "empty").map(day => day.date),
            failedDates: days.filter(day => day.status === "failed").map(day => day.date),
            lastSuccessfulSyncAt: lastSuccessful
          }
        };
      } catch (error) {
        if (error instanceof AppError) throw error;
        throw new AppError(503, "HISTORY_DATABASE_UNAVAILABLE", "History storage is temporarily unavailable.");
      }
    }
  };
}
