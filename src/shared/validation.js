import { AppError } from "./errors.js";

const MAX_CODE_LENGTH = 100;

export function readStationOption(options, fieldName) {
  if (options[fieldName] === undefined) return null;
  const prefix = fieldName === "startStation" ? "START" : "END";
  if (typeof options[fieldName] !== "string") {
    throw new AppError(400, `INVALID_${prefix}_STATION`, `${fieldName} must be a string.`);
  }
  const value = options[fieldName].trim();
  if (!value || value.length > 200) {
    throw new AppError(400, `INVALID_${prefix}_STATION`, `${fieldName} is invalid.`);
  }
  return value;
}

export function requireCode(value, fieldName) {
  if (typeof value !== "string") {
    throw new AppError(400, "INVALID_INPUT", `${fieldName} must be a string.`);
  }

  const code = value.trim();

  if (!code || code.length > MAX_CODE_LENGTH || /[\u0000-\u001f\u007f]/.test(code)) {
    throw new AppError(400, "INVALID_INPUT", `${fieldName} is invalid.`);
  }

  return code;
}

export function parseCoordinate(value, fieldName = "coordinate") {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new AppError(400, "INVALID_COORDINATE", `${fieldName} must contain lat and lng.`);
  }

  const lat = Number(value.lat);
  const lng = Number(value.lng);

  if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
    throw new AppError(400, "INVALID_COORDINATE", `${fieldName} must contain numeric lat and lng.`);
  }

  if (lat < -90 || lat > 90 || lng < -180 || lng > 180) {
    throw new AppError(400, "INVALID_COORDINATE", `${fieldName} is outside valid coordinate bounds.`);
  }

  return { lat, lng };
}

export function readOptionalCoordinate(value) {
  if (!value || typeof value !== "object") {
    return null;
  }

  const lat = Number(value.lat);
  const lng = Number(value.lng);

  if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
    return null;
  }

  if (lat < -90 || lat > 90 || lng < -180 || lng > 180) {
    return null;
  }

  return { lat, lng };
}
