import { setTimeout as sleep } from "node:timers/promises";
import { XMLParser, XMLValidator } from "fast-xml-parser";
import { AppError } from "../shared/errors.js";
import { dateOnly } from "../history/time.js";
import { ibbFetch, readIbbResponse } from "./ibb-fetch.js";

const SOAP_ACTION = "http://tempuri.org/GetIettArsivGorev_json";
const parser = new XMLParser({ removeNSPrefix: true, parseTagValue: false, trimValues: false });

export function parseArchiveResponse(xml) {
  if (/<!DOCTYPE/i.test(xml) || XMLValidator.validate(xml) !== true) {
    throw new AppError(502, "IETT_ARCHIVE_INVALID_XML", "IETT returned invalid archive XML.");
  }
  const body = parser.parse(xml)?.Envelope?.Body;
  if (body?.Fault) {
    throw new AppError(502, "IETT_ARCHIVE_SOAP_FAULT", "IETT returned an archive SOAP fault.");
  }
  const result = body?.GetIettArsivGorev_jsonResponse?.GetIettArsivGorev_jsonResult;
  let records;
  try { records = JSON.parse(result); }
  catch { throw new AppError(502, "IETT_ARCHIVE_INVALID_JSON", "IETT returned invalid archive JSON."); }
  if (!Array.isArray(records)) {
    throw new AppError(502, "IETT_ARCHIVE_INVALID_JSON", "IETT archive data must be an array.");
  }
  return records;
}

function retryAfter(value, now) {
  if (value == null) return 0;
  const seconds = Number(value);
  return Number.isFinite(seconds) ? Math.max(0, seconds * 1000) : Math.max(0, Date.parse(value) - now) || 0;
}

export class IettArchiveClient {
  constructor({ fetchImpl = ibbFetch,
    baseUrl = "https://api.ibb.gov.tr/iett/ibb/ibb360.asmx",
    timeoutMs = 120_000, delayMs = 1_000, clock = Date.now,
    sleepImpl = (ms, signal) => sleep(ms, undefined, { signal }) } = {}) {
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0 || !Number.isFinite(delayMs) || delayMs < 0) {
      throw new RangeError("Archive timeout must be positive and request delay must be non-negative.");
    }
    Object.assign(this, { fetchImpl, baseUrl, timeoutMs, delayMs, clock, sleepImpl });
    this.nextRequestAt = Number(clock()) + delayMs;
    this.tail = Promise.resolve();
  }

  fetchDay(date, { signal } = {}) {
    dateOnly(date);
    const pending = this.tail.then(() => this.#fetchDay(date, signal));
    this.tail = pending.catch(() => {});
    return pending;
  }

  async #fetchDay(date, signal) {
    for (let attempt = 0; ; attempt += 1) {
      signal?.throwIfAborted();
      const wait = this.nextRequestAt - Number(this.clock());
      if (wait > 0) await this.sleepImpl(wait, signal);
      try {
        return await this.#request(date, signal);
      } catch (error) {
        signal?.throwIfAborted();
        const retryable = ["IETT_ARCHIVE_TIMEOUT", "IETT_ARCHIVE_REQUEST_FAILED"].includes(error.code)
          || error.code === "IETT_ARCHIVE_PROXY_AUTH_FAILED" && error.details?.proxyCount > 1
          || error.details?.status === 429 || error.details?.status >= 500;
        if (!retryable || attempt >= 2) throw error;
        this.nextRequestAt = Math.max(this.nextRequestAt,
          Number(this.clock()) + Math.max(2_000 * 2 ** attempt, error.details?.retryAfterMs ?? 0));
      }
    }
  }

  async #request(date, signal) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(new DOMException("The IETT archive request timed out.", "TimeoutError")), this.timeoutMs);
    const requestSignal = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal;
    try {
      const response = await this.fetchImpl(this.baseUrl, {
        method: "POST",
        headers: { "content-type": "text/xml; charset=utf-8", SOAPAction: `"${SOAP_ACTION}"` },
        body: `<?xml version="1.0" encoding="utf-8"?><soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/"><soap:Body><GetIettArsivGorev_json xmlns="http://tempuri.org/"><Tarih>${date.replaceAll("-", "")}</Tarih></GetIettArsivGorev_json></soap:Body></soap:Envelope>`,
        signal: requestSignal
      });
      const xml = await readIbbResponse(response, "text");
      if (!response.ok) {
        throw new AppError(502, "IETT_ARCHIVE_BAD_STATUS", "IETT returned an unsuccessful archive response.", {
          status: response.status, retryAfterMs: retryAfter(response.headers.get("retry-after"), Number(this.clock()))
        });
      }
      return parseArchiveResponse(xml);
    } catch (error) {
      signal?.throwIfAborted();
      if (error instanceof AppError) throw error;
      if (error.code === "IBB_PROXY_REQUEST_FAILED" && error.details?.proxyStatus === 407) {
        throw new AppError(502, "IETT_ARCHIVE_PROXY_AUTH_FAILED", "The IBB proxy rejected authentication.", error.details);
      }
      throw new AppError(502, controller.signal.aborted ? "IETT_ARCHIVE_TIMEOUT" : "IETT_ARCHIVE_REQUEST_FAILED",
        controller.signal.aborted ? "The IETT archive request timed out." : "The IETT archive request failed.",
        error.code === "IBB_PROXY_REQUEST_FAILED" ? error.details : undefined);
    } finally {
      clearTimeout(timeout);
      this.nextRequestAt = Number(this.clock()) + this.delayMs;
    }
  }
}
