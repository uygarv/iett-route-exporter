import { createRoutingScheduler } from "./routing-scheduler.js";
export { retryAfterMilliseconds } from "./routing-scheduler.js";

export const TOMTOM_HTTP_ATTEMPTS = Symbol("TomTom HTTP attempts");
export function createTomTomScheduler(options = {}) {
  return createRoutingScheduler({
    requestsPerSecond: Number(process.env.TOMTOM_REQUESTS_PER_SECOND ?? 4),
    maxConcurrency: Number(process.env.TOMTOM_MAX_CONCURRENCY ?? 4),
    ...options, provider: "TOMTOM", providerLabel: "TomTom", attemptsSymbol: TOMTOM_HTTP_ATTEMPTS
  });
}

const schedulers = new Map();
export function sharedTomTomScheduler(apiKey) {
  if (!schedulers.has(apiKey)) schedulers.set(apiKey, createTomTomScheduler());
  return schedulers.get(apiKey);
}
