import { AppError } from "../shared/errors.js";
import {
  buildRouteGeometry,
  findClosestRoutePosition
} from "../routing/geometry.js";
import { buildAppleMapsUrl } from "../providers/apple-maps.js";
import { buildGoogleMapsUrl } from "../providers/google-maps.js";
import { buildYandexMapsUrl } from "../providers/yandex-maps.js";
import { IettClient } from "../clients/iett-client.js";
import { TomTomClient } from "../clients/tomtom-client.js";
import {
  parseCoordinate,
  readOptionalCoordinate,
  requireCode
} from "../shared/validation.js";
import { selectWaypoints } from "../routing/waypoints.js";
import { coordinateForRouteMatch } from "../routing/stop-projection.js";
import { matchStopsToRoute } from "../routing/timing.js";
import {
  addStationSequenceNumbers,
  findStationsByName,
  normalizeStationName
} from "../routing/stations.js";
import { createIettTravelTimeService } from "./iett-travel-times.js";
import { createIettGpxService } from "./iett-gpx-service.js";

export function parseRouteCode(code) {
  const value = requireCode(code, "routeCode");
  const parts = value.split("_");

  return {
    line: parts[0],
    direction: parts[1] || null,
    variant: parts.slice(2).join("_") || null
  };
}

function firstRouteRecord(data, routeCode) {
  if (!Array.isArray(data)) {
    throw new AppError(502, "IETT_MALFORMED_RESPONSE", "IETT returned an invalid route response.", {
      routeCode
    });
  }

  if (!data.length) {
    throw new AppError(404, "IETT_ROUTE_NOT_FOUND", "IETT returned no data for this route code.", {
      routeCode
    });
  }

  if (!data[0] || typeof data[0] !== "object") {
    throw new AppError(502, "IETT_MALFORMED_RESPONSE", "IETT returned an invalid route record.", {
      routeCode
    });
  }

  return data[0];
}

function stopName(stop) {
  if (!stop || typeof stop.stationName !== "string") {
    return null;
  }

  return stop.stationName.trim() || null;
}

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
  const validStops = [];

  for (const [stationIndex, stop] of stops.entries()) {
    const coordinate = readOptionalCoordinate(stop);
    const stationName = stopName(stop);

    if (!coordinate || !stationName) {
      continue;
    }

    validStops.push({
      ...stop,
      stationIndex
    });
  }

  if (validStops.length < 2) {
    return validStops.map(stop => {
      const coordinate = readOptionalCoordinate(stop);
      const match = findClosestRoutePosition(geometry, coordinate);
      const routeCoordinate = coordinateForRouteMatch(coordinate, match);

      return {
        ...routeCoordinate,
        stationName: stopName(stop),
        stationIndex: stop.stationIndex,
        distanceAlongRoute: match.distanceAlongRoute,
        distanceToRoute: match.distanceToRoute,
        projectedToRoute: routeCoordinate.lat !== coordinate.lat
          || routeCoordinate.lng !== coordinate.lng
      };
    });
  }

  return matchStopsToRoute(validStops, geometry).map(stop => ({
    ...stop.providerCoordinate,
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
  let startStation = null;
  let endStation = null;

  if (options.startStation !== undefined) {
    if (typeof options.startStation !== "string") {
      throw new AppError(400, "INVALID_START_STATION", "startStation must be a string.");
    }

    startStation = options.startStation.trim();

    if (!startStation || startStation.length > 200) {
      throw new AppError(400, "INVALID_START_STATION", "startStation is invalid.");
    }
  }

  if (options.endStation !== undefined) {
    if (typeof options.endStation !== "string") {
      throw new AppError(400, "INVALID_END_STATION", "endStation must be a string.");
    }

    endStation = options.endStation.trim();

    if (!endStation || endStation.length > 200) {
      throw new AppError(400, "INVALID_END_STATION", "endStation is invalid.");
    }
  }

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

function warning(code, message, details) {
  return { code, message, details };
}

export function isValidRoutePinResponse(data) {
  return Array.isArray(data)
    && data.length > 0
    && typeof data[0]?.line === "string"
    && data[0].line.trim() !== ""
    && Array.isArray(data[0]?.stationPlaces)
    && data[0].stationPlaces.length >= 2;
}

function routeName(value) {
  if (typeof value !== "string") {
    return null;
  }

  return value.trim() || null;
}

function directionId(start, end) {
  return `${normalizeStationName(start)}__${normalizeStationName(end)}`;
}

function resolveNamedStation(stops, stationConstraints, geometry, requestedName, role) {
  const errorPrefix = role.toUpperCase();
  const detailName = `${role}Station`;
  const readableStops = addStationSequenceNumbers(stops.map((stop, stationIndex) => ({
    stationIndex,
    name: stopName(stop),
    coordinate: readOptionalCoordinate(stop)
  })));
  const matches = findStationsByName(readableStops, requestedName);

  if (!matches.length) {
    throw new AppError(
      400,
      `${errorPrefix}_STATION_NOT_FOUND`,
      `The requested ${role} station does not exist on this route.`,
      { [detailName]: requestedName }
    );
  }

  if (matches.length > 1) {
    throw new AppError(
      400,
      `AMBIGUOUS_${errorPrefix}_STATION`,
      "The requested station occurs more than once on this route.",
      {
        [detailName]: requestedName,
        stationIndexes: matches.map(match => match.stationIndex),
        candidates: matches.map(match => ({
          stationIndex: match.stationIndex,
          name: match.name,
          lat: match.coordinate?.lat ?? null,
          lng: match.coordinate?.lng ?? null
        }))
      }
    );
  }

  const selected = matches[0];
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

function publicVariant(variant) {
  return {
    code: variant.code,
    type: variant.type,
    name: variant.name,
    rawName: variant.rawName,
    start: variant.start,
    end: variant.end,
    stops: variant.stops
  };
}

export function createIettService({
  client = new IettClient(),
  tomTomClient = new TomTomClient(),
  timingCacheTtlMs = 60_000
} = {}) {
  const travelTimeService = createIettTravelTimeService({
    iettClient: client,
    tomTomClient,
    cacheTtlMs: timingCacheTtlMs
  });
  const gpxService = createIettGpxService({ iettClient: client });

  async function getIettRouteOptions(lineCodeInput) {
    const lineCode = requireCode(lineCodeInput, "lineCode");
    const warnings = [];
    const routes = new Map();
    const baseCodes = [
      `${lineCode}_G_D0`,
      `${lineCode}_D_D0`
    ];
    const baseResults = await Promise.all(baseCodes.map(async code => {
      try {
        const pinData = await client.getRoutePin(code);

        if (!isValidRoutePinResponse(pinData)) {
          return {
            code,
            error: warning(
              "INVALID_BASE_ROUTE",
              "An IETT base route did not return usable geometry and stops.",
              { routeCode: code }
            )
          };
        }

        return { code, pinData };
      } catch (error) {
        return {
          code,
          error: warning(
            "BASE_ROUTE_UNAVAILABLE",
            error instanceof AppError ? error.message : "An IETT base route could not be loaded.",
            { routeCode: code }
          )
        };
      }
    }));

    for (const result of baseResults) {
      if (result.error) {
        warnings.push(result.error);
        continue;
      }

      routes.set(result.code, {
        code: result.code,
        type: "base",
        rawName: null,
        pinData: result.pinData
      });
    }

    const routeEntries = await client.getAllRoutes(lineCode);

    if (!Array.isArray(routeEntries)) {
      throw new AppError(502, "IETT_MALFORMED_RESPONSE", "IETT returned an invalid route list.", {
        lineCode
      });
    }

    for (const [index, entry] of routeEntries.entries()) {
      const code = typeof entry?.GUZERGAH_GUZERGAH_KODU === "string"
        ? entry.GUZERGAH_GUZERGAH_KODU.trim()
        : "";

      if (!code) {
        warnings.push(warning(
          "MISSING_ROUTE_CODE",
          "An IETT route entry has no route code.",
          { index }
        ));
        continue;
      }

      const rawName = routeName(entry.GUZERGAH_ADI);
      const existing = routes.get(code);

      if (existing) {
        if (rawName && !existing.rawName) {
          existing.rawName = rawName;
        }

        continue;
      }

      routes.set(code, {
        code,
        type: "variant",
        rawName,
        pinData: null
      });
    }

    const resolved = await Promise.all([...routes.values()].map(async route => {
      try {
        const pinData = route.pinData ?? await client.getRoutePin(route.code);

        if (!isValidRoutePinResponse(pinData)) {
          return {
            route,
            error: warning(
              "INVALID_ROUTE_VARIANT",
              "An IETT route variant did not return usable geometry and stops.",
              { routeCode: route.code }
            )
          };
        }

        const stops = pinData[0].stationPlaces;
        const start = stopName(stops[0]);
        const end = stopName(stops.at(-1));

        if (!start || !end) {
          return {
            route,
            error: warning(
              "MISSING_STOP_NAMES",
              "A discovered route does not have usable endpoint stop names.",
              { routeCode: route.code }
            )
          };
        }

        const readableStops = addStationSequenceNumbers(stops.map((stop, stationIndex) => ({
          stationIndex,
          name: stopName(stop),
          coordinate: readOptionalCoordinate(stop)
        })));

        return {
          variant: {
            code: route.code,
            type: route.type,
            name: route.type === "base"
              ? route.rawName ?? "Normal Düzergah"
              : route.rawName,
            rawName: route.rawName,
            start,
            end,
            directionLabel: `${start} - ${end}`,
            directionId: directionId(start, end),
            stops: readableStops
          },
          missingName: route.type === "variant" && !route.rawName
        };
      } catch (error) {
        return {
          route,
          error: warning(
            "ROUTE_DISCOVERY_FAILED",
            error instanceof AppError ? error.message : "The route could not be inspected.",
            { routeCode: route.code }
          )
        };
      }
    }));

    const groups = new Map();

    for (const result of resolved) {
      if (result.error) {
        warnings.push(result.error);
        continue;
      }

      if (result.missingName) {
        warnings.push(warning(
          "MISSING_VARIANT_NAME",
          "IETT did not provide a name for a non-default route variant.",
          { routeCode: result.variant.code }
        ));
      }

      const id = result.variant.directionId;

      if (!groups.has(id)) {
        groups.set(id, []);
      }

      groups.get(id).push(result.variant);
    }

    if (!groups.size) {
      throw new AppError(404, "IETT_LINE_NOT_FOUND", "IETT returned no usable routes for this line.", {
        lineCode,
        warnings
      });
    }

    const directions = [...groups.entries()].map(([id, variants]) => {
      const representative = variants[0];

      return {
        id,
        label: representative.directionLabel,
        start: representative.start,
        end: representative.end,
        variants: variants.map(publicVariant)
      };
    });

    return {
      line: lineCode,
      directions,
      warnings
    };
  }

  async function buildIettMapsRoute(routeCodeInput, optionsInput, provider) {
    const routeCode = requireCode(routeCodeInput, "routeCode");
    const options = validateBuildOptions(optionsInput, provider);
    const routeData = await client.getRoutePin(routeCode);
    const record = firstRouteRecord(routeData, routeCode);
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
      stationConstraints
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

  async function calculateIettRouteTimes(routeCodeInput, options) {
    const routeCode = requireCode(routeCodeInput, "routeCode");
    return travelTimeService.calculateIettRouteTimes(routeCode, options);
  }

  async function buildIettGpx(routeCodeInput, options) {
    const routeCode = requireCode(routeCodeInput, "routeCode");
    return gpxService.buildIettGpx(routeCode, options);
  }

  return {
    getIettRouteOptions,
    prepareIettLine: getIettRouteOptions,
    buildIettGoogleMapsRoute,
    buildIettAppleMapsRoute,
    buildIettYandexMapsRoute,
    buildIettGpx,
    calculateIettRouteTimes,
    clearCaches() {
      travelTimeService.clearCache();
    }
  };
}
