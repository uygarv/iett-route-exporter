import { readFileSync } from "node:fs";
import pg from "pg";
import { AppError } from "../shared/errors.js";

export function createDatabase({ connectionString, caFile, poolSize = 5, connectionTimeoutMs = 10_000, statementTimeoutMs } = {}) {
  let pool;
  function getPool() {
    if (pool) return pool;
    const url = connectionString ?? process.env.DATABASE_URL;
    if (!url) throw new AppError(503, "HISTORY_DATABASE_UNAVAILABLE", "History storage is not configured.");
    const certificate = caFile ?? process.env.DATABASE_SSL_CA_FILE;
    const parsed = new URL(url);
    if (certificate && ["sslmode", "sslrootcert", "sslcert", "sslkey"].some(key => parsed.searchParams.has(key))) {
      throw new Error("Use DATABASE_SSL_CA_FILE without SSL parameters in DATABASE_URL.");
    }
    if (parsed.hostname.endsWith(".rds.amazonaws.com") && !certificate) {
      throw new Error("RDS connections require DATABASE_SSL_CA_FILE for certificate verification.");
    }
    pool = new pg.Pool({
      connectionString: url,
      max: poolSize,
      connectionTimeoutMillis: connectionTimeoutMs,
      ...(statementTimeoutMs ? { statement_timeout: statementTimeoutMs } : {}),
      idleTimeoutMillis: 30_000,
      application_name: "iett-history",
      ...(certificate ? { ssl: { ca: readFileSync(certificate, "utf8"), rejectUnauthorized: true } } : {})
    });
    pool.on("error", error => console.error("History database connection error:", error.code ?? "UNKNOWN"));
    return pool;
  }
  return {
    query: (...args) => getPool().query(...args),
    connect: () => getPool().connect(),
    end: async () => { if (pool) await pool.end(); }
  };
}
