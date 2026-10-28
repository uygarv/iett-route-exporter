import { setTimeout as sleep } from "node:timers/promises";
import { AppError } from "../shared/errors.js";
import { dateOnly } from "../history/time.js";
import { createIettFetch } from "./iett-fetch.js";
import { readArchiveResponse } from "./iett-archive-parser.js";
import { ibbResponseDetails } from "./ibb-fetch.js";
import { diagnosticDetails, errorDiagnostics } from "../shared/error-diagnostics.js";

export { parseArchiveResponse } from "./iett-archive-parser.js";

const SOAP_ACTION = "http://tempuri.org/GetIettArsivGorev_json";

function retryAfter(value, now) {
  if (value == null) return 0;
  const seconds = Number(value);
  return Number.isFinite(seconds) ? Math.max(0, seconds * 1000) : Math.max(0, Date.parse(value) - now) || 0;
}

export class IettArchiveClient {
  constructor({ useProxy, fetchImpl = createIettFetch({ scope: "archive", useProxy }),
    baseUrl = "https://api.ibb.gov.tr/iett/ibb/ibb360.asmx",
    timeoutMs = 120_000, delayMs = 1_000, clock = Date.now,
    logger = () => {},
    sleepImpl = (ms, signal) => sleep(ms, undefined, { signal }) } = {}) {
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0 || !Number.isFinite(delayMs) || delayMs < 0) {
      throw new RangeError("Archive timeout must be positive and request delay must be non-negative.");
    }
    Object.assign(this, { fetchImpl, baseUrl, timeoutMs, delayMs, clock, sleepImpl, logger });
    this.nextRequestAt = Number(clock()) + delayMs;
    this.tail = Promise.resolve();
  }

  fetchDay(date, { signal } = {}) {
    dateOnly(date);
    const pending = this.tail.then(() => this.#fetchDay(date, signal));
    this.tail = pending.then(() => {}, () => {});
    return pending;
  }

  async #fetchDay(date, signal) {
    const attempts = [];
    for (let attempt = 0; ; attempt += 1) {
      signal?.throwIfAborted();
      const wait = this.nextRequestAt - Number(this.clock());
      if (wait > 0) await this.sleepImpl(wait, signal);
      const start = Number(this.clock());
      this.logger({ event: "history.request.started", at: new Date(start).toISOString(), date, attempt: attempt + 1 });
      try {
        const records = await this.#request(date, signal, attempt + 1);
        this.logger({ event: "history.request.completed", at: new Date(Number(this.clock())).toISOString(),
          date, attempt: attempt + 1, sourceCount: records.length, durationMs: Number(this.clock()) - start });
        return records;
      } catch (error) {
        signal?.throwIfAborted();
        const retryable = ["IETT_ARCHIVE_TIMEOUT", "IETT_ARCHIVE_REQUEST_FAILED"].includes(error.code)
          || error.code === "IETT_ARCHIVE_PROXY_AUTH_FAILED" && error.details?.proxyCount > 1
          || error.details?.status === 429 || error.details?.status >= 500;
        const willRetry = retryable && attempt < 2;
        const retryDelayMs = willRetry ? Math.max(this.delayMs, 2_000 * 2 ** attempt, error.details?.retryAfterMs ?? 0) : null;
        const diagnostic = { attempt: attempt + 1, durationMs: Number(this.clock()) - start, ...errorDiagnostics(error) };
        attempts.push(diagnostic);
        this.logger({ event: "history.request.failed", at: new Date(Number(this.clock())).toISOString(),
          date, ...diagnostic, willRetry, retryDelayMs });
        if (!willRetry) {
          error.details = { ...error.details, attempts };
          throw error;
        }
        this.nextRequestAt = Math.max(this.nextRequestAt, Number(this.clock()) + retryDelayMs);
      }
    }
  }

  async #request(date, signal, attempt) {
    const started = Number(this.clock());
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(new DOMException("The IETT archive request timed out.", "TimeoutError")), this.timeoutMs);
    const requestSignal = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal;
    let phase = "response_headers";
    let context = {};
    let bytesReceived = 0;
    try {
      const response = await this.fetchImpl(this.baseUrl, {
        method: "POST",
        headers: { "content-type": "text/xml; charset=utf-8", SOAPAction: `"${SOAP_ACTION}"` },
        body: `<?xml version="1.0" encoding="utf-8"?><soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/"><soap:Body><GetIettArsivGorev_json xmlns="http://tempuri.org/"><Tarih>${date.replaceAll("-", "")}</Tarih></GetIettArsivGorev_json></soap:Body></soap:Envelope>`,
        signal: requestSignal
      });
      context = { transport: this.fetchImpl.transport, ...ibbResponseDetails(response) };
      if (!response.ok) {
        await response.body?.cancel();
        throw new AppError(502, "IETT_ARCHIVE_BAD_STATUS", "IETT returned an unsuccessful archive response.", {
          ...context, phase, status: response.status, retryAfterMs: retryAfter(response.headers.get("retry-after"), Number(this.clock()))
        });
      }
      phase = "response_body";
      this.logger({ event: "history.request.headers", at: new Date(Number(this.clock())).toISOString(),
        date, attempt, status: response.status, durationMs: Number(this.clock()) - started, ...context });
      const records = await readArchiveResponse(response, { signal: requestSignal, onChunk: bytes => { bytesReceived += bytes; } });
      this.logger({ event: "history.request.downloaded", at: new Date(Number(this.clock())).toISOString(),
        date, attempt, bytesReceived, durationMs: Number(this.clock()) - started });
      return records;
    } catch (error) {
      signal?.throwIfAborted();
      const details = { phase, transport: this.fetchImpl.transport, ...context, ...diagnosticDetails(error), timeoutMs: this.timeoutMs, bytesReceived };
      if (error instanceof AppError) {
        if (["IETT_ARCHIVE_INVALID_XML", "IETT_ARCHIVE_INVALID_JSON", "IETT_ARCHIVE_SOAP_FAULT"].includes(error.code)) details.phase = "decode";
        error.details = { ...error.details, ...details };
        throw error;
      }
      if (error.code === "IBB_PROXY_REQUEST_FAILED" && error.details?.proxyStatus === 407) {
        throw new AppError(502, "IETT_ARCHIVE_PROXY_AUTH_FAILED", "The IBB proxy rejected authentication.", details);
      }
      throw new AppError(502, controller.signal.aborted ? "IETT_ARCHIVE_TIMEOUT" : "IETT_ARCHIVE_REQUEST_FAILED",
        controller.signal.aborted ? "The IETT archive request timed out." : "The IETT archive request failed.",
        details);
    } finally {
      clearTimeout(timeout);
      this.nextRequestAt = Number(this.clock()) + this.delayMs;
    }
  }
}
