import { AppError } from "../shared/errors.js";
import { buildRouteGeometry, findClosestRoutePosition } from "../routing/geometry.js";
import { buildAppleMapsUrl } from "../providers/apple-maps.js";
import { buildGoogleMapsUrl } from "../providers/google-maps.js";
import { buildYandexMapsUrl } from "../providers/yandex-maps.js";
import { readRouteRecord } from "../clients/iett-client.js";
import { parseCoordinate, readOptionalCoordinate, requireCode, readStationOption } from "../shared/validation.js";
import { selectWaypoints } from "../routing/waypoints.js";
import { coordinateForRouteMatch } from "../routing/stop-projection.js";
import { matchStopsToRoute } from "../routing/timing.js";
import { normalizeRouteStops, selectStation } from "../routing/stations.js";

function endpointFromStop(stop, geometry, geometryPoint, fallbackDistance) {
  const coordinate = readOptionalCoordinate(stop);

  if (!coordinate) {
    return {
      coordinate: { lat: geometryPoint.lat, lng: geometryPoint.lng },
      distanceAlongRoute: fallbackDistance
    };
  }

  const match = findClosestRoutePosition(geometry, coordinate);
  return {
    coordinate: coordinateForRouteMatch(coordinate, match),
    distanceAlongRoute: match.distanceAlongRoute
  };
}

function stationConstraintsFromStops(stops, geometry) {
  return matchStopsToRoute(stops, geometry, { allowInvalidStops: true }).map(stop => ({
    ...stop.providerCoordinate,
    rawCoordinate: stop.coordinate,
    stationName: stop.name,
    stationIndex: stop.stationIndex,
    distanceAlongRoute: stop.distanceAlongRoute,
    distanceToRoute: stop.distanceToRoute,
    projectedToRoute: stop.projectedToRoute
  }));
}

function validateBuildOptions(options, { defaultMaxWaypoints, maxWaypointsLimit }) {
  if (options === undefined) {
    return {
      maxWaypoints: defaultMaxWaypoints,
      debug: false,
      currentLocation: null,
      startStation: null,
      endStation: null
    };
  }

  if (!options || typeof options !== "object" || Array.isArray(options)) {
    throw new AppError(400, "INVALID_OPTIONS", "Route options must be an object.");
  }

  const maxWaypoints = options.maxWaypoints ?? defaultMaxWaypoints;

  if (
    !Number.isInteger(maxWaypoints)
    || maxWaypoints < 0
    || maxWaypoints > maxWaypointsLimit
  ) {
    throw new AppError(
      400,
      "INVALID_MAX_WAYPOINTS",
      `maxWaypoints must be an integer from 0 to ${maxWaypointsLimit}.`
    );
  }

  if (options.debug !== undefined && typeof options.debug !== "boolean") {
    throw new AppError(400, "INVALID_DEBUG", "debug must be a boolean.");
  }

  const currentLocation = options.currentLocation === undefined
    ? null
    : parseCoordinate(options.currentLocation, "currentLocation");
  const startStation = readStationOption(options, "startStation");
  const endStation = readStationOption(options, "endStation");

  if (currentLocation && startStation) {
    throw new AppError(
      400,
      "CONFLICTING_START_OPTIONS",
      "Use either currentLocation or startStation, not both."
    );
  }

  return {
    maxWaypoints,
    debug: options.debug ?? false,
    currentLocation,
    startStation,
    endStation
  };
}

function resolveNamedStation(stops, stationConstraints, geometry, requestedName, role) {
  const errorPrefix = role.toUpperCase();
  const detailName = `${role}Station`;
  const selected = selectStation(normalizeRouteStops(stops), requestedName, role);
  if (!selected.coordinate) {
    throw new AppError(
      502,
      `IETT_INVALID_${errorPrefix}_STATION`,
      "The requested IETT station has invalid coordinates.",
      { [detailName]: selected.name }
    );
  }

  const constraint = stationConstraints.find(candidate => {
    return candidate.stationIndex === selected.stationIndex;
  });
  const routeMatch = constraint ?? findClosestRoutePosition(geometry, selected.coordinate);
  const routeCoordinate = constraint
    ? { lat: constraint.lat, lng: constraint.lng }
    : coordinateForRouteMatch(selected.coordinate, routeMatch);

  return {
    name: selected.name,
    index: selected.stationIndex,
    coordinate: routeCoordinate,
    originalCoordinate: selected.coordinate,
    distanceAlongRoute: routeMatch.distanceAlongRoute,
    distanceToRoute: routeMatch.distanceToRoute,
    projectedToRoute: constraint?.projectedToRoute
      ?? (routeCoordinate.lat !== selected.coordinate.lat
        || routeCoordinate.lng !== selected.coordinate.lng)
  };
}

export function createMapRouteService({ client }) {
  async function buildIettMapsRoute(routeCodeInput, optionsInput, provider) {
    const routeCode = requireCode(routeCodeInput, "routeCode");
    const options = validateBuildOptions(optionsInput, provider);
    const routeData = await client.getRoutePin(routeCode);
    const record = readRouteRecord(routeData, routeCode);
    const geometry = buildRouteGeometry(record.line);
    const stops = Array.isArray(record.stationPlaces) ? record.stationPlaces : [];
    const stationConstraints = stationConstraintsFromStops(stops, geometry);
    const geometryOrigin = geometry.points[0];
    const geometryDestination = geometry.points.at(-1);
    const firstConstraint = stationConstraints.find(stop => stop.stationIndex === 0);
    const lastConstraint = stationConstraints.find(stop => {
      return stop.stationIndex === stops.length - 1;
    });
    const firstStop = firstConstraint
      ? {
          coordinate: { lat: firstConstraint.lat, lng: firstConstraint.lng },
          distanceAlongRoute: firstConstraint.distanceAlongRoute
        }
      : endpointFromStop(stops[0], geometry, geometryOrigin, 0);
    const lastStop = lastConstraint
      ? {
          coordinate: { lat: lastConstraint.lat, lng: lastConstraint.lng },
          distanceAlongRoute: lastConstraint.distanceAlongRoute
        }
      : endpointFromStop(
          stops.at(-1),
          geometry,
          geometryDestination,
          geometry.totalLength
        );
    let destination = lastStop.coordinate;
    let origin = firstStop.coordinate;
    let startDistanceAlongRoute = firstStop.distanceAlongRoute;
    let endDistanceAlongRoute = lastStop.distanceAlongRoute;
    let selectedStartStation = null;
    let selectedEndStation = null;
    let originSource = "route-start";
    let destinationSource = "route-end";

    if (options.currentLocation) {
      const match = findClosestRoutePosition(geometry, options.currentLocation);

      if (match.distanceToRoute > 500) {
        throw new AppError(
          400,
          "CURRENT_LOCATION_OFF_ROUTE",
          "The current location is more than 500 metres from this route.",
          { distanceMeters: Math.round(match.distanceToRoute) }
        );
      }

      if (match.ambiguous) {
        throw new AppError(
          400,
          "AMBIGUOUS_CURRENT_LOCATION",
          "The current location matches multiple distant positions along this route."
        );
      }

      origin = options.currentLocation;
      startDistanceAlongRoute = match.distanceAlongRoute;
      originSource = "current-location";
    } else if (options.startStation) {
      selectedStartStation = resolveNamedStation(
        stops,
        stationConstraints,
        geometry,
        options.startStation,
        "start"
      );
      origin = selectedStartStation.coordinate;
      startDistanceAlongRoute = selectedStartStation.distanceAlongRoute;
      originSource = "station";
    }

    if (options.endStation) {
      selectedEndStation = resolveNamedStation(
        stops,
        stationConstraints,
        geometry,
        options.endStation,
        "end"
      );
      destination = selectedEndStation.coordinate;
      endDistanceAlongRoute = selectedEndStation.distanceAlongRoute;
      destinationSource = "station";
    }

    if (endDistanceAlongRoute <= startDistanceAlongRoute + 1) {
      throw new AppError(
        400,
        "INVALID_STATION_RANGE",
        "The end station must come after the selected route start.",
        {
          startDistanceAlongRoute,
          endDistanceAlongRoute
        }
      );
    }

    const selection = selectWaypoints(geometry, {
      startDistance: startDistanceAlongRoute,
      endDistance: endDistanceAlongRoute,
      maxWaypoints: options.maxWaypoints,
      stationConstraints,
      debug: options.debug
    });
    const url = provider.buildUrl({
      origin,
      destination,
      waypoints: selection.waypoints,
      useCurrentLocation: Boolean(options.currentLocation)
    });
    const result = {
      routeCode,
      provider: provider.id,
      origin,
      originSource,
      destination,
      destinationSource,
      waypoints: selection.waypoints,
      routeLengthMeters: geometry.totalLength,
      startDistanceAlongRoute,
      endDistanceAlongRoute,
      remainingRouteLengthMeters: endDistanceAlongRoute - startDistanceAlongRoute,
      stationCount: stops.length,
      stationWaypointCount: selection.waypoints.filter(waypoint => {
        return waypoint.reason === "station";
      }).length,
      turnPreservingStationCount: selection.waypoints.filter(waypoint => {
        return waypoint.reason === "station" && waypoint.roles.includes("post-turn");
      }).length,
      additionalTurnWaypointCount: selection.waypoints.filter(waypoint => {
        return waypoint.reason !== "station" && waypoint.roles.includes("post-turn");
      }).length,
      originalPointCount: geometry.rawPointCount,
      resampledPointCount: selection.samples.length,
      url
    };

    if (selectedStartStation) {
      result.startStation = {
        name: selectedStartStation.name,
        index: selectedStartStation.index
      };
    }

    if (selectedEndStation) {
      result.endStation = {
        name: selectedEndStation.name,
        index: selectedEndStation.index
      };
    }

    if (options.debug) {
      result.debug = {
        candidates: selection.candidates,
        minSpacingMeters: selection.minSpacing,
        controlPath: {
          maxDeviationMeters: selection.metrics.maxDeviation,
          percentile95DeviationMeters: selection.metrics.percentile95Deviation,
          rootMeanSquareDeviationMeters: selection.metrics.rootMeanSquareDeviation
        }
      };
    }

    return result;
  }

  function buildIettGoogleMapsRoute(routeCode, options) {
    return buildIettMapsRoute(routeCode, options, {
      id: "google-maps",
      defaultMaxWaypoints: 9,
      maxWaypointsLimit: 9,
      buildUrl: buildGoogleMapsUrl
    });
  }

  function buildIettAppleMapsRoute(routeCode, options) {
    return buildIettMapsRoute(routeCode, options, {
      id: "apple-maps",
      defaultMaxWaypoints: 13,
      maxWaypointsLimit: 13,
      buildUrl: buildAppleMapsUrl
    });
  }

  function buildIettYandexMapsRoute(routeCode, options) {
    return buildIettMapsRoute(routeCode, options, {
      id: "yandex-maps",
      defaultMaxWaypoints: 18,
      maxWaypointsLimit: 18,
      buildUrl: buildYandexMapsUrl
    });
  }

  return { buildIettGoogleMapsRoute, buildIettAppleMapsRoute, buildIettYandexMapsRoute };
}
