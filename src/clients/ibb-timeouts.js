import { AppError } from "../shared/errors.js";

export function readIbbTimeouts({ connectTimeoutMs, headersTimeoutMs, env = process.env } = {}) {
  const limits = {
    connectTimeoutMs: connectTimeoutMs ?? Number(env.IBB_CONNECT_TIMEOUT_MS?.trim() || 5000),
    headersTimeoutMs: headersTimeoutMs ?? Number(env.IBB_HEADERS_TIMEOUT_MS?.trim() || 15000)
  };
  if (Object.values(limits).some(value => !Number.isSafeInteger(value) || value <= 0 || value > 2_147_483_647)) {
    throw new AppError(503, "IBB_TIMEOUT_CONFIGURATION_ERROR", "IBB connection and header timeouts must be positive integer milliseconds.");
  }
  return limits;
}
export async function fetchIbbHeaders(fetchImpl, input, options, headersTimeoutMs) {
  options.signal?.throwIfAborted();
  const controller = new AbortController();
  const reason = new DOMException("Timed out waiting for IBB response headers.", "TimeoutError");
  reason.details = { networkCode: "UND_ERR_HEADERS_TIMEOUT", phase: "response_headers", headersTimeoutMs };
  const timer = setTimeout(() => controller.abort(reason), headersTimeoutMs);
  const signal = options.signal ? AbortSignal.any([options.signal, controller.signal]) : controller.signal;
  try {
    return await fetchImpl(input, { ...options, signal });
  } catch (error) {
    options.signal?.throwIfAborted();
    if (controller.signal.aborted) throw reason;
    throw error;
  } finally {
    clearTimeout(timer);
  }
}
