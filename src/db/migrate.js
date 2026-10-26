import { readdir, readFile } from "node:fs/promises";

export async function migrate(database) {
  const client = await database.connect();
  try {
    await client.query("SELECT pg_advisory_lock(182885, 2)");
    await client.query("SELECT pg_advisory_lock(182885, 1)");
    await client.query(`CREATE TABLE IF NOT EXISTS iett_history_schema_migrations (
      name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now()
    )`);
    const directory = new URL("./migrations/", import.meta.url);
    const names = (await readdir(directory)).filter(name => /^\d+.*\.sql$/.test(name)).sort();
    const applied = [];
    for (const name of names) {
      if ((await client.query("SELECT 1 FROM iett_history_schema_migrations WHERE name = $1", [name])).rowCount) continue;
      await client.query("BEGIN");
      try {
        await client.query(await readFile(new URL(name, directory), "utf8"));
        await client.query("INSERT INTO iett_history_schema_migrations(name) VALUES ($1)", [name]);
        await client.query("COMMIT");
        applied.push(name);
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      }
    }
    return applied;
  } finally {
    try {
      await client.query("SELECT pg_advisory_unlock(182885, 1)");
      await client.query("SELECT pg_advisory_unlock(182885, 2)");
    }
    finally { client.release(); }
  }
}
