import assert from "node:assert/strict";
import test from "node:test";
import { errorDiagnostics } from "../src/shared/error-diagnostics.js";

test("diagnostics extract nested aggregate causes and sanitize proxy addresses", () => {
  const error = Object.assign(new Error("postgresql://user:password@db/?token=secret"), {
    code: "IETT_ARCHIVE_REQUEST_FAILED",
    cause: new AggregateError([
      Object.assign(new Error("secret"), { code: "ECONNREFUSED" }),
      Object.assign(new Error("secret"), { code: "ENOTFOUND" })
    ], "private"),
    details: { proxy: "http://user:password@proxy.example:8080/path?token=secret",
      proxyIndex: 2, proxyCount: 3, phase: "response_headers", source: "secret", stack: "secret" }
  });
  error.cause.cause = error;
  const result = errorDiagnostics(error);
  assert.equal(result.networkCode, "ECONNREFUSED");
  assert.ok(result.causeCodes.includes("ENOTFOUND"));
  assert.equal(result.proxy, "http://proxy.example:8080");
  assert.equal(result.proxyIndex, 2);
  assert.equal(result.message, "The destination refused the connection.");
  assert.doesNotMatch(JSON.stringify(result), /password|secret|token|private/);
});

test("diagnostics handle cancellation and malformed metadata without raw error strings", () => {
  assert.equal(errorDiagnostics(new DOMException("private", "AbortError")).code, "HISTORY_IMPORT_CANCELLED");
  const result = errorDiagnostics({ code: 20, details: { causeCodes: "malformed", proxy: "malformed", proxyStatus: "secret" } });
  assert.equal(result.code, "HISTORY_IMPORT_FAILED");
  assert.equal(result.proxy, undefined);
  assert.equal(result.proxyStatus, undefined);
  const database = errorDiagnostics(Object.assign(new Error("INSERT with private data"), { code: "23505" }));
  assert.equal(database.code, "23505");
  assert.equal(database.databaseCode, "23505");
  assert.equal(database.networkCode, undefined);
});
