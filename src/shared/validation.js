import { AppError } from "./errors.js";

const MAX_CODE_LENGTH = 100;

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
