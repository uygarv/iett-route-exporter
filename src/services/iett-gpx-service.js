import { AppError } from "../shared/errors.js";
import { readStationOption } from "../shared/validation.js";
import { readRouteRecord } from "../clients/iett-client.js";
import { buildRouteGeometry } from "../routing/geometry.js";
import { sliceRouteGeometry, matchStopsToRoute } from "../routing/timing.js";
import {
  normalizeRouteStops,
  selectStation
} from "../routing/stations.js";
import { buildGpxDocument } from "../providers/gpx.js";

function readOptions(input) {
  const options = input ?? {};

  if (!options || typeof options !== "object" || Array.isArray(options)) {
    throw new AppError(400, "INVALID_OPTIONS", "GPX options must be an object.");
  }

  return {
    startStation: readStationOption(options, "startStation"),
    endStation: readStationOption(options, "endStation")
  };
}

function routeRecord(data, routeCode) {
  const record = readRouteRecord(data, routeCode);

  if (!record || typeof record.line !== "string" || !record.line.trim()) {
    throw new AppError(502, "IETT_MALFORMED_RESPONSE", "IETT returned a route without geometry.");
  }

  return record;
}

export function createIettGpxService({ iettClient }) {
  async function buildIettGpx(routeCode, optionsInput) {
    const options = readOptions(optionsInput);
    const data = await iettClient.getRoutePin(routeCode);
    const record = routeRecord(data, routeCode);
    const geometry = buildRouteGeometry(record.line);
    const rawStops = Array.isArray(record.stationPlaces) ? record.stationPlaces : [];
    const stops = normalizeRouteStops(rawStops);
    const selectedStart = options.startStation
      ? selectStation(stops, options.startStation, "start")
      : null;
    const selectedEnd = options.endStation
      ? selectStation(stops, options.endStation, "end")
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

    const matchedStops = selectedStart || selectedEnd
      ? matchStopsToRoute(rawStops, geometry, { allowInvalidStops: true }) : [];
    const distanceFor = stop => matchedStops.find(match => match.stationIndex === stop.stationIndex).distanceAlongRoute;
    const startDistance = selectedStart ? distanceFor(selectedStart) : 0;
    const endDistance = selectedEnd ? distanceFor(selectedEnd) : geometry.totalLength;

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
