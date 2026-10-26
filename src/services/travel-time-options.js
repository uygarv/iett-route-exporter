import { AppError } from "../shared/errors.js";
import { parseCoordinate, readStationOption } from "../shared/validation.js";
import { readRouteRecord } from "../clients/iett-client.js";

const DEFAULT_DWELL_TIME_SECONDS = 15;
const MAX_DWELL_TIME_SECONDS = 600;

function validateDepartureTime(value) {
  if (value === undefined || value === "now") {
    return "now";
  }

  if (typeof value !== "string") {
    throw new AppError(
      400,
      "INVALID_DEPARTURE_TIME",
      'departureTime must be "now" or an ISO 8601 date-time.'
    );
  }

  const trimmed = value.trim();
  const match = trimmed.match(
    /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.(\d+))?)?(Z|[+-]\d{2}:\d{2})?$/i
  );
  const parsed = new Date(trimmed);

  if (!match || Number.isNaN(parsed.getTime())) {
    throw new AppError(
      400,
      "INVALID_DEPARTURE_TIME",
      'departureTime must be "now" or an ISO 8601 date-time.'
    );
  }

  const [, year, month, day, hour, minute, second = "0"] = match;
  const validationDate = new Date(Date.UTC(
    Number(year),
    Number(month) - 1,
    Number(day),
    Number(hour),
    Number(minute),
    Number(second)
  ));
  const validComponents = validationDate.getUTCFullYear() === Number(year)
    && validationDate.getUTCMonth() === Number(month) - 1
    && validationDate.getUTCDate() === Number(day)
    && validationDate.getUTCHours() === Number(hour)
    && validationDate.getUTCMinutes() === Number(minute)
    && validationDate.getUTCSeconds() === Number(second);

  if (!validComponents) {
    throw new AppError(
      400,
      "INVALID_DEPARTURE_TIME",
      'departureTime must be "now" or an ISO 8601 date-time.'
    );
  }

  return match[8] ? parsed.toISOString() : trimmed;
}

export function validateTravelTimeOptions(input) {
  const options = input ?? {};

  if (!options || typeof options !== "object" || Array.isArray(options)) {
    throw new AppError(400, "INVALID_OPTIONS", "Travel-time options must be an object.");
  }

  if (options.debug !== undefined && typeof options.debug !== "boolean") {
    throw new AppError(400, "INVALID_DEBUG", "debug must be a boolean.");
  }

  const dwellTimeSeconds = options.dwellTimeSeconds ?? DEFAULT_DWELL_TIME_SECONDS;

  if (
    !Number.isInteger(dwellTimeSeconds)
    || dwellTimeSeconds < 0
    || dwellTimeSeconds > MAX_DWELL_TIME_SECONDS
  ) {
    throw new AppError(
      400,
      "INVALID_DWELL_TIME",
      `dwellTimeSeconds must be an integer from 0 to ${MAX_DWELL_TIME_SECONDS}.`
    );
  }

  const startStation = readStationOption(options, "startStation");
  const endStation = readStationOption(options, "endStation");
  const currentLocation = options.currentLocation === undefined
    ? null
    : parseCoordinate(options.currentLocation, "currentLocation");

  if (startStation && currentLocation) {
    throw new AppError(
      400,
      "CONFLICTING_START_OPTIONS",
      "Use either currentLocation or startStation, not both."
    );
  }

  const provider = options.provider === undefined ? "tomtom" : options.provider;
  if (provider !== "tomtom" && provider !== "here") {
    throw new AppError(400, "INVALID_PROVIDER", 'provider must be "tomtom" or "here".');
  }

  return {
    provider,
    startStation,
    endStation,
    currentLocation,
    departureTime: validateDepartureTime(options.departureTime),
    dwellTimeSeconds,
    debug: options.debug ?? false
  };
}

export function routeRecord(data, routeCode) {
  const record = readRouteRecord(data, routeCode);

  if (!record || typeof record.line !== "string" || !record.line.trim()) {
    throw new AppError(502, "IETT_MALFORMED_RESPONSE", "IETT returned a route without geometry.", {
      routeCode
    });
  }

  if (!Array.isArray(record.stationPlaces) || record.stationPlaces.length < 2) {
    throw new AppError(502, "IETT_INVALID_STOPS", "The IETT route must contain at least two stops.", {
      routeCode
    });
  }

  return record;
}

