import { AppError } from "../shared/errors.js";
import { ibbFetch } from "./ibb-fetch.js";
import { readIbbProxySource } from "./ibb-proxy-source.js";

const PROXY_SETTINGS = Object.freeze({
  client: "IETT_CLIENT_USE_PROXY",
  archive: "IETT_ARCHIVE_USE_PROXY"
});

export function readIettProxyPolicy(scope, { useProxy, env = process.env } = {}) {
  if (!Object.hasOwn(PROXY_SETTINGS, scope)) throw new TypeError("Unknown IETT transport scope.");
  const setting = PROXY_SETTINGS[scope];
  if (useProxy !== undefined && typeof useProxy !== "boolean") throw new TypeError("useProxy must be a boolean.");
  let enabled = useProxy;
  if (enabled === undefined) {
    const value = env[setting]?.trim().toLowerCase();
    if (value && !["true", "false"].includes(value)) {
      throw new AppError(503, "IBB_PROXY_CONFIGURATION_ERROR", `${setting} must be true or false.`);
    }
    // Preserve existing installations that configure only the source URL.
    enabled = value ? value === "true" : Boolean(env.IBB_PROXY_SOURCE_URL?.trim());
  }
  if (!enabled) return false;
  let source;
  try { source = readIbbProxySource(env.IBB_PROXY_SOURCE_URL ?? ""); }
  catch {
    throw new AppError(503, "IBB_PROXY_CONFIGURATION_ERROR", "IBB_PROXY_SOURCE_URL must be a valid HTTP/HTTPS URL without credentials.");
  }
  if (!source) {
    throw new AppError(503, "IBB_PROXY_CONFIGURATION_ERROR", `IBB_PROXY_SOURCE_URL is required when ${setting} is enabled.`);
  }
  return true;
}

// Resolve on first request, after dotenv is loaded. Both clients reuse the
// shared discovery/rotation/pool layer; disabling one never touches that layer.
export function createIettFetch({ scope, useProxy,
  directFetch = globalThis.fetch, proxyFetch = ibbFetch } = {}) {
  let transport;
  let selected;
  const request = (input, options) => {
    if (!transport) {
      selected = readIettProxyPolicy(scope, { useProxy }) ? "proxy" : "direct";
      transport = selected === "proxy" ? proxyFetch : directFetch;
    }
    return transport(input, options);
  };
  Object.defineProperty(request, "transport", { get: () => selected });
  return request;
}
