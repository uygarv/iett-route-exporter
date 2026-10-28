import dotenv from "dotenv";
import { createHistoryRuntime } from "./runtime.js";
import { startHistoryScheduler } from "./scheduler.js";
import { closeIbbProxyConnections } from "../clients/ibb-fetch.js";

dotenv.config({ quiet: true });
const runtime = createHistoryRuntime();
const worker = startHistoryScheduler({ collector: runtime.collector, repository: runtime.repository });
console.log(JSON.stringify({ event: "history.worker.started", at: new Date().toISOString(),
  timezone: "Europe/Istanbul", dailyTime: "04:00", queuePollMs: 60_000 }));
let stopping = false;
async function shutdown() {
  if (stopping) return;
  stopping = true;
  await worker.stop();
  await closeIbbProxyConnections();
  await runtime.database.end();
}
process.once("SIGINT", shutdown);
process.once("SIGTERM", shutdown);
