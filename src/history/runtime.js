import { createDatabase } from "../db/database.js";
import { IettArchiveClient } from "../clients/iett-archive-client.js";
import { HistoryRepository } from "./repository.js";
import { createHistoryCollector } from "./collector.js";

export function createHistoryRuntime() {
  const database = createDatabase();
  const repository = new HistoryRepository(database);
  const client = new IettArchiveClient({
    delayMs: Number(process.env.IETT_HISTORY_DELAY_MS ?? 1000),
    timeoutMs: Number(process.env.IETT_HISTORY_TIMEOUT_MS ?? 120000)
  });
  return { database, repository, collector: createHistoryCollector({ repository, client }) };
}
