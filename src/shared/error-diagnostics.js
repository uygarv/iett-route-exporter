
const codePattern = /^(?:[A-Z][A-Z0-9_]{0,79}|[0-9][A-Z0-9]{4})$/;
const phases = new Set(["proxy_discovery", "proxy_probe", "response_headers", "response_body", "decode", "database", "cancelled"]);
const explanations = {
  UND_ERR_CONNECT_TIMEOUT: "TCP/TLS connection timed out.",
  UND_ERR_HEADERS_TIMEOUT: "Timed out waiting for response headers.",
  UND_ERR_BODY_TIMEOUT: "Timed out while downloading the response body.",
  UND_ERR_SOCKET: "The remote connection closed unexpectedly.",
  ECONNREFUSED: "The destination refused the connection.",
  ECONNRESET: "The connection was reset.",
  ETIMEDOUT: "The network operation timed out.",
  ENOTFOUND: "DNS could not resolve the hostname.",
  EAI_AGAIN: "DNS resolution temporarily failed.",
  UNABLE_TO_VERIFY_LEAF_SIGNATURE: "TLS certificate verification failed.",
  CERT_HAS_EXPIRED: "The TLS certificate has expired.",
  IETT_ARCHIVE_TIMEOUT: "The archive request deadline expired.",
  IBB_PROXY_CONFIGURATION_ERROR: "The proxy configuration is missing or invalid.",
  IBB_TIMEOUT_CONFIGURATION_ERROR: "The connection or header timeout configuration is invalid.",
  IETT_ARCHIVE_INVALID_XML: "IETT returned invalid archive XML.",
  IETT_ARCHIVE_INVALID_JSON: "IETT returned invalid archive JSON.",
  IETT_ARCHIVE_SOAP_FAULT: "IETT returned a SOAP fault.",
  HISTORY_IMPORT_CANCELLED: "The import was cancelled; the day remains queued.",
  IETT_ARCHIVE_EMPTY: "IETT returned an empty archive.",
  PROXY_SOURCE_EMPTY: "The proxy source returned no usable proxies.",
  PROXY_PROBE_FAILED: "The tested proxies could not reach IBB.",
  PROXY_PROBE_TIMEOUT: "The short IBB proxy probe timed out.",
  PROXY_COOLDOWN: "Listed proxies are temporarily cooling down after failures.",
  PROXY_SOURCE_BAD_STATUS: "The proxy list provider returned an HTTP error.",
  PROXY_SOURCE_INVALID_RESPONSE: "The proxy list provider returned an invalid response.",
  PROXY_SOURCE_FETCH_FAILED: "Fetching the proxy list failed.",
  PROXY_SOURCE_TIMEOUT: "The proxy list provider request timed out."
};

export function diagnosticDetails(error) {
  const result = {};
  const codes = [];
  const seen = new Set();
  function visit(cause, depth = 0) {
    if (!cause || typeof cause !== "object" || seen.has(cause) || depth >= 6 || seen.size >= 16) return;
    seen.add(cause);
    if (typeof cause.code === "string" && codePattern.test(cause.code)) codes.push(cause.code);
    const proxyStatus = /Proxy response \((\d{3})\)/.exec(cause.message ?? "")?.[1];
    if (proxyStatus) result.proxyStatus = Number(proxyStatus);
    visit(cause.cause, depth + 1);
    if (Array.isArray(cause.errors)) for (const nested of cause.errors.slice(0, 6)) visit(nested, depth + 1);
  }
  visit(error);
  const details = error?.details ?? {};
  for (const key of ["networkCode", "proxySourceCode", "databaseCode"]) {
    if (typeof details[key] === "string" && codePattern.test(details[key])) result[key] = details[key];
  }
  for (const key of ["proxyIndex", "proxyCount", "proxyStatus", "proxySourceStatus", "status", "retryAfterMs", "timeoutMs", "connectTimeoutMs", "headersTimeoutMs", "bytesReceived"]) {
    if (Number.isSafeInteger(details[key]) && details[key] >= 0) result[key] = details[key];
  }
  if (phases.has(details.phase)) result.phase = details.phase;
  const errorName = details.errorName ?? error?.name;
  if (["Error", "TypeError", "TimeoutError", "AbortError", "AggregateError", "AppError", "SyntaxError"].includes(errorName)) result.errorName = errorName;
  if (["direct", "proxy"].includes(details.transport)) result.transport = details.transport;
  if (typeof details.proxy === "string") {
    try {
      const url = new URL(details.proxy);
      if (["http:", "https:"].includes(url.protocol)) result.proxy = url.origin;
    } catch {}
  }
  const nestedCodes = [...new Set([...(Array.isArray(details.causeCodes) ? details.causeCodes : [])
    .filter(value => typeof value === "string" && codePattern.test(value)), ...codes])].slice(0, 16);
  const databaseCode = nestedCodes.find(code => /^[0-9A-Z]{5}$/.test(code) && /[0-9]/.test(code));
  if (databaseCode) result.databaseCode ??= databaseCode;
  const networkCode = nestedCodes.find(code => !/^(IBB_|IETT_|HISTORY_)/.test(code) && code !== databaseCode);
  if (networkCode) result.networkCode ??= networkCode;
  if (nestedCodes.length) result.causeCodes = nestedCodes;
  return result;
}

export function errorDiagnostics(error, fallback = "HISTORY_IMPORT_FAILED") {
  const code = error?.name === "AbortError" ? "HISTORY_IMPORT_CANCELLED"
    : typeof error?.code === "string" && codePattern.test(error.code) ? error.code : fallback;
  const details = diagnosticDetails(error);
  const reason = details.networkCode ?? details.proxySourceCode ?? code;
  const message = details.proxyStatus ? `Proxy CONNECT returned HTTP ${details.proxyStatus}.`
    : details.status ? `IETT returned HTTP ${details.status}.`
    : explanations[reason] ?? explanations[code] ?? "Operation failed; inspect the diagnostic codes and phase.";
  const result = { code, message, ...details };
  if (Array.isArray(error?.details?.attempts)) {
    result.attempts = error.details.attempts.slice(0, 3).map(entry => ({
      attempt: Number.isSafeInteger(entry.attempt) ? entry.attempt : null,
      durationMs: Number.isSafeInteger(entry.durationMs) ? entry.durationMs : null,
      ...errorDiagnostics({ code: entry.code, details: diagnosticDetails({ details: entry }) })
    }));
  }
  return result;
}
