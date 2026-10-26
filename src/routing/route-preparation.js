import { createHash } from "node:crypto";
import { AppError } from "../shared/errors.js";
import { buildRouteGeometry, findClosestRoutePosition } from "./geometry.js";
import { matchStopsToRoute } from "./timing.js";
import { addStationSequenceNumbers, selectStation } from "./stations.js";

const MAX_CURRENT_LOCATION_DISTANCE_METERS = 500;

function stationNode(stop) {
  return {
    type: "station",
    name: stop.name,
    stationIndex: stop.stationIndex,
    lat: stop.coordinate.lat,
    lng: stop.coordinate.lng,
    distanceAlongRoute: stop.distanceAlongRoute,
    providerCoordinate: stop.providerCoordinate
  };
}

function currentLocationNode(location, routeMatch) {
  return {
    type: "current-location",
    lat: location.lat,
    lng: location.lng,
    distanceAlongRoute: routeMatch.distanceAlongRoute,
    providerCoordinate: {
      lat: routeMatch.lat,
      lng: routeMatch.lng
    }
  };
}

export function selectRouteNodes(matches, geometry, options) {
  const end = selectStation(matches, options.endStation, "end");
  let start;
  let nodes;

  if (options.currentLocation) {
    const routeMatch = findClosestRoutePosition(geometry, options.currentLocation);

    if (routeMatch.distanceToRoute > MAX_CURRENT_LOCATION_DISTANCE_METERS) {
      throw new AppError(
        400,
        "CURRENT_LOCATION_OFF_ROUTE",
        "The current location is more than 500 metres from this route.",
        { distanceMeters: Math.round(routeMatch.distanceToRoute) }
      );
    }

    if (routeMatch.ambiguous) {
      throw new AppError(
        400,
        "AMBIGUOUS_CURRENT_LOCATION",
        "The current location matches multiple distant positions along this route."
      );
    }

    start = currentLocationNode(options.currentLocation, routeMatch);
    nodes = [start, ...matches
      .filter(stop => {
        return stop.distanceAlongRoute > start.distanceAlongRoute + 1
          && stop.distanceAlongRoute <= end.distanceAlongRoute + 1;
      })
      .map(stationNode)];
  } else {
    const selectedStart = selectStation(matches, options.startStation, "start");
    start = stationNode(selectedStart);
    nodes = matches
      .filter(stop => {
        return stop.stationIndex >= selectedStart.stationIndex
          && stop.stationIndex <= end.stationIndex;
      })
      .map(stationNode);
  }

  if (end.distanceAlongRoute <= start.distanceAlongRoute + 1 || nodes.length < 2) {
    throw new AppError(
      400,
      "INVALID_STATION_RANGE",
      "The end station must come after the selected route start.",
      {
        startDistanceAlongRoute: start.distanceAlongRoute,
        endDistanceAlongRoute: end.distanceAlongRoute
      }
    );
  }

  return nodes;
}

export function createRoutePreparation() {
  let preparedRoutes = new WeakMap();
  function prepareRoute(record, provider = "tomtom") {
    // Geometry and stop matching depend on IETT data, not the departure instant.
    // Include a fingerprint so an updated record cannot reuse stale preparation.
    const fingerprint = createHash("sha256").update(JSON.stringify([record.line, record.stationPlaces])).digest("hex");
    let existing = preparedRoutes.get(record);
    if (existing?.fingerprint !== fingerprint) {
      existing = { fingerprint, providers: new Map() };
      preparedRoutes.set(record, existing);
    }
    if (existing.providers.has(provider)) return existing.providers.get(provider);
    const geometry = buildRouteGeometry(record.line, { minimumPointSpacingMeters: provider === "here" ? 0 : 2 });
    const matchedStops = addStationSequenceNumbers(matchStopsToRoute(record.stationPlaces, geometry));
    const prepared = { fingerprint, provider, geometry, matchedStops, sections: new Map() };
    existing.providers.set(provider, prepared);
    return prepared;
  }

  function prepareSection(prepared, options) {
    const key = JSON.stringify({
      startStation: options.startStation, endStation: options.endStation,
      currentLocation: options.currentLocation
    });
    if (prepared.sections.has(key)) return prepared.sections.get(key);
    const nodes = selectRouteNodes(prepared.matchedStops, prepared.geometry, options);
    const section = { nodes };
    // Current locations can vary with every request. Bound the retained sections.
    if (prepared.sections.size >= 64) prepared.sections.delete(prepared.sections.keys().next().value);
    prepared.sections.set(key, section);
    return section;
  }

  return { prepareRoute, prepareSection, clear() { preparedRoutes = new WeakMap(); } };
}

