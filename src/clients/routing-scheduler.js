import { AppError } from "../shared/errors.js";

function markAttempts(value, count, symbol) {
  if (value && typeof value === "object" && Object.isExtensible(value)) {
    Object.defineProperty(value, symbol, { value: count, configurable: true });
  }
  return value;
}

export function retryAfterMilliseconds(value, now) {
  if (value == null || String(value).trim() === "") return null;
  const seconds = Number(value);
  if (Number.isFinite(seconds)) return seconds >= 0 ? seconds * 1_000 : null;
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? Math.max(0, timestamp - now) : null;
}

// One scheduler per API key, shared by every client and endpoint in this process.
export function createRoutingScheduler({
  provider, providerLabel, attemptsSymbol,
  requestsPerSecond = 4,
  maxConcurrency = 4,
  maxRetryWaitMs = 10_000,
  recoveryMs = 60_000,
  clock = Date.now,
  setTimer = setTimeout,
  clearTimer = clearTimeout,
  random = Math.random
} = {}) {
  if (!Number.isFinite(requestsPerSecond) || requestsPerSecond <= 0
    || !Number.isInteger(maxConcurrency) || maxConcurrency < 1
    || !Number.isFinite(maxRetryWaitMs) || maxRetryWaitMs < 0
    || !Number.isFinite(recoveryMs) || recoveryMs <= 0) {
    throw new RangeError(`${providerLabel} request rate and concurrency must be positive.`);
  }
  const pending = new Map();
  const queue = [];
  let active = 0, lastStart = -Infinity, cooldownUntil = 0;
  let rate = requestsPerSecond, lastLimitedAt = -Infinity, timer;

  function drain() {
    if (timer !== undefined) { clearTimer(timer); timer = undefined; }
    if (!queue.length || active >= maxConcurrency) return;
    const now = Number(clock());
    if (now - lastLimitedAt >= recoveryMs) rate = requestsPerSecond;
    const wait = Math.max(cooldownUntil, lastStart + 1_000 / rate) - now;
    if (wait > maxRetryWaitMs && cooldownUntil > now) {
      queue.splice(0).forEach(item => item.reject(new AppError(429, `${provider}_RATE_LIMITED`, `${providerLabel} is in a shared rate-limit cooldown.`, {
        retryAfter: String(Math.ceil((cooldownUntil - now) / 1_000))
      })));
      return;
    }
    if (wait > 0) { timer = setTimer(drain, Math.ceil(wait)); return; }
    const item = queue.shift();
    active += 1;
    lastStart = now;
    Promise.resolve().then(item.run).then(item.resolve, item.reject).finally(() => {
      active -= 1;
      drain();
    });
    drain();
  }

  function schedule(run) {
    return new Promise((resolve, reject) => {
      queue.push({ run, resolve, reject });
      drain();
    });
  }

  async function attempt(run) {
    let calls = 0;
    for (let index = 0; ; index += 1) {
      try {
        // Handle failures before releasing the slot so no queued request can
        // slip past a newly received 429.
        const result = await schedule(async () => {
          calls += 1;
          try { return await run(); }
          catch (error) {
            if (error?.code === `${provider}_RATE_LIMITED`) {
              const now = Number(clock());
              lastLimitedAt = now;
              rate = Math.max(Math.min(requestsPerSecond, 0.5), rate / 2);
              const delay = retryAfterMilliseconds(error.details?.retryAfter, now) ?? 1_000;
              cooldownUntil = Math.max(cooldownUntil, now + delay + Math.floor(random() * 250));
            }
            throw error;
          }
        });
        return markAttempts(result, calls, attemptsSymbol);
      } catch (error) {
        const retryable = [`${provider}_RATE_LIMITED`, `${provider}_TIMEOUT`, `${provider}_REQUEST_FAILED`].includes(error?.code)
          || (error?.code === `${provider}_BAD_STATUS` && error.details?.status >= 500);
        if (index >= 1 || !retryable || cooldownUntil - Number(clock()) > maxRetryWaitMs) throw markAttempts(error, calls, attemptsSymbol);
        // Backoff is scheduled through the same queue, never while holding a slot.
        if (error.code !== `${provider}_RATE_LIMITED`) {
          cooldownUntil = Math.max(cooldownUntil, Number(clock()) + 500 + Math.floor(random() * 250));
        }
      }
    }
  }

  return {
    execute(identity, run) {
      if (pending.has(identity)) return pending.get(identity);
      const promise = attempt(run);
      pending.set(identity, promise);
      const forget = () => { if (pending.get(identity) === promise) pending.delete(identity); };
      promise.then(forget, forget);
      return promise;
    }
  };
}
