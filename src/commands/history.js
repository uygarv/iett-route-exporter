import dotenv from "dotenv";
import { parseArgs } from "node:util";
import { migrate } from "../db/migrate.js";
import { createHistoryRuntime } from "../history/runtime.js";
import { localDate, shiftDate } from "../history/time.js";
import { AppError } from "../shared/errors.js";
import { closeIbbProxyConnections } from "../clients/ibb-fetch.js";

dotenv.config({ quiet: true });

let runtime;
try {
  const action = process.argv[2];
  const { values } = parseArgs({ args: process.argv.slice(3), options: {
    days: { type: "string" }, from: { type: "string" }, to: { type: "string" }, force: { type: "boolean", default: false }
  } });
  if (!["migrate", "sync", "status"].includes(action)) throw new Error("Expected migrate, sync or status.");
  if ((values.from === undefined) !== (values.to === undefined)
    || (values.days !== undefined && values.from !== undefined)) {
    throw new Error("Use either --days or both --from and --to.");
  }
  runtime = createHistoryRuntime();
  if (action === "migrate") {
    console.log(JSON.stringify({ applied: await migrate(runtime.database) }));
  } else if (action === "status") {
    const status = await runtime.repository.status();
    const yesterday = shiftDate(localDate(Date.now()), -1);
    console.log(JSON.stringify({ ...status, latestExpectedDate: yesterday,
      collectionBehind: status.to == null || status.to < yesterday || status.incomplete.length > 0 }, null, 2));
  } else {
    const controller = new AbortController();
    const abort = () => controller.abort();
    process.once("SIGINT", abort);
    process.once("SIGTERM", abort);
    try {
      const outcome = await runtime.collector.sync({ from: values.from, to: values.to,
        days: values.days === undefined ? 30 : Number(values.days), force: values.force, signal: controller.signal });
      if (!outcome.locked) { console.log("Another history collector is already running."); process.exitCode = 2; }
      else if (outcome.result.failed || outcome.result.empty) process.exitCode = 1;
    } finally {
      process.removeListener("SIGINT", abort);
      process.removeListener("SIGTERM", abort);
    }
  }
} catch (error) {
  console.error(JSON.stringify({ error: error.code ?? "HISTORY_COMMAND_FAILED",
    message: error instanceof AppError || error instanceof RangeError || (!error.code && !runtime)
      ? error.message : "The history command failed. Check configuration and database access." }));
  process.exitCode = 1;
} finally {
  await closeIbbProxyConnections();
  await runtime?.database.end();
}
