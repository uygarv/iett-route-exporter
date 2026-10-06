import { AppError } from "../shared/errors.js";
import { readOptionalCoordinate } from "../shared/validation.js";
import {
  buildRouteGeometry,
  findClosestRoutePosition
} from "../routing/geometry.js";
import { sliceRouteGeometry } from "../routing/timing.js";
import {
  addStationSequenceNumbers,
  findStationsByName
} from "../routing/stations.js";
import { buildGpxDocument } from "../providers/gpx.js";

function stationName(stop) {
  if (typeof stop?.stationName !== "string") {
    return null;
  }

  return stop.stationName.trim() || null;
}

function readOptions(input) {
  const options = input ?? {};

  if (!options || typeof options !== "object" || Array.isArray(options)) {
    throw new AppError(400, "INVALID_OPTIONS", "GPX options must be an object.");
  }

  const result = {
    startStation: null,
    endStation: null
  };

  for (const field of ["startStation", "endStation"]) {
    if (options[field] === undefined) {
      continue;
    }

    if (typeof options[field] !== "string") {
      const prefix = field === "startStation" ? "START" : "END";

      throw new AppError(
        400,
        `INVALID_${prefix}_STATION`,
        `${field} must be a string.`
      );
    }

    const value = options[field].trim();

    if (!value || value.length > 200) {
      const prefix = field === "startStation" ? "START" : "END";

      throw new AppError(
        400,
        `INVALID_${prefix}_STATION`,
        `${field} is invalid.`
      );
    }

    result[field] = value;
  }

  return result;
}

function routeRecord(data, routeCode) {
  if (!Array.isArray(data)) {
    throw new AppError(502, "IETT_MALFORMED_RESPONSE", "IETT returned an invalid route response.");
  }

  if (!data.length) {
    throw new AppError(404, "IETT_ROUTE_NOT_FOUND", "IETT returned no data for this route code.", {
      routeCode
    });
  }

  const record = data[0];

  if (!record || typeof record.line !== "string" || !record.line.trim()) {
    throw new AppError(502, "IETT_MALFORMED_RESPONSE", "IETT returned a route without geometry.");
  }

  return record;
}

function resolveStation(stops, requestedName, role) {
  const matches = findStationsByName(stops, requestedName);
  const prefix = role.toUpperCase();

  if (!matches.length) {
    throw new AppError(
      400,
      `${prefix}_STATION_NOT_FOUND`,
      `The requested ${role} station does not exist on this route.`
    );
  }

  if (matches.length > 1) {
    throw new AppError(
      400,
      `AMBIGUOUS_${prefix}_STATION`,
      "The requested station occurs more than once on this route.",
      {
        candidates: matches.map(stop => ({
          stationIndex: stop.stationIndex,
          name: stop.name
        }))
      }
    );
  }

  return matches[0];
}

export function createIettGpxService({ iettClient }) {
  async function buildIettGpx(routeCode, optionsInput) {
    const options = readOptions(optionsInput);
    const data = await iettClient.getRoutePin(routeCode);
    const record = routeRecord(data, routeCode);
    const geometry = buildRouteGeometry(record.line);
    const rawStops = Array.isArray(record.stationPlaces) ? record.stationPlaces : [];
    const stops = addStationSequenceNumbers(rawStops.map((stop, stationIndex) => ({
      stationIndex,
      name: stationName(stop),
      coordinate: readOptionalCoordinate(stop)
    })));
    const selectedStart = options.startStation
      ? resolveStation(stops, options.startStation, "start")
      : null;
    const selectedEnd = options.endStation
      ? resolveStation(stops, options.endStation, "end")
      : null;
    const startIndex = selectedStart?.stationIndex ?? 0;
    const endIndex = selectedEnd?.stationIndex ?? Math.max(0, stops.length - 1);

    if (selectedStart && !selectedStart.coordinate) {
      throw new AppError(502, "IETT_INVALID_START_STATION", "The start station has invalid coordinates.");
    }

    if (selectedEnd && !selectedEnd.coordinate) {
      throw new AppError(502, "IETT_INVALID_END_STATION", "The end station has invalid coordinates.");
    }

    if (selectedStart && selectedEnd && endIndex <= startIndex) {
      throw new AppError(
        400,
        "INVALID_STATION_RANGE",
        "The end station must come after the selected route start."
      );
    }

    const startDistance = selectedStart
      ? findClosestRoutePosition(geometry, selectedStart.coordinate).distanceAlongRoute
      : 0;
    const endDistance = selectedEnd
      ? findClosestRoutePosition(geometry, selectedEnd.coordinate).distanceAlongRoute
      : geometry.totalLength;

    if (endDistance <= startDistance + 1) {
      throw new AppError(
        400,
        "INVALID_STATION_RANGE",
        "The end station must come after the selected route start."
      );
    }

    const points = sliceRouteGeometry(geometry, startDistance, endDistance);
    const selectedStops = stops.slice(startIndex, endIndex + 1);
    const safeRouteCode = routeCode.replace(/[^A-Za-z0-9._-]+/g, "-");

    return {
      routeCode,
      filename: `${safeRouteCode}.gpx`,
      contentType: "application/gpx+xml; charset=utf-8",
      gpx: buildGpxDocument({
        routeCode,
        points,
        stops: selectedStops
      })
    };
  }

  return { buildIettGpx };
}
