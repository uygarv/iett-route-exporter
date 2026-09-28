import { AppError } from "../shared/errors.js";
import {
  buildRouteGeometry,
  findClosestRoutePosition,
  haversineDistance
} from "../routing/geometry.js";
import { buildAppleMapsUrl } from "../providers/apple-maps.js";
import { buildGoogleMapsUrl } from "../providers/google-maps.js";
import { IettClient } from "../clients/iett-client.js";
import {
  parseCoordinate,
  readOptionalCoordinate,
  requireCode
} from "../shared/validation.js";
import { selectWaypoints } from "../routing/waypoints.js";

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

function endpointFromStop(stop, geometryPoint) {
  const coordinate = readOptionalCoordinate(stop);

  if (coordinate && haversineDistance(coordinate, geometryPoint) <= 250) {
    return coordinate;
  }

  return { lat: geometryPoint.lat, lng: geometryPoint.lng };
}

function stationConstraintsFromStops(stops, geometry) {
  const constraints = [];

  for (const [stationIndex, stop] of stops.entries()) {
    const coordinate = readOptionalCoordinate(stop);
    const stationName = stopName(stop);

    if (!coordinate || !stationName) {
      continue;
    }

    const match = findClosestRoutePosition(geometry, coordinate);

    if (match.distanceToRoute > 250) {
      continue;
    }

    constraints.push({
      ...coordinate,
      stationName,
      stationIndex,
      distanceAlongRoute: match.distanceAlongRoute
    });
  }

  return constraints.sort((first, second) => {
    return first.distanceAlongRoute - second.distanceAlongRoute;
  });
}

function validateBuildOptions(options, { defaultMaxWaypoints, maxWaypointsLimit }) {
  if (options === undefined) {
    return {
      maxWaypoints: defaultMaxWaypoints,
      debug: false,
      currentLocation: null,
      startStation: null
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

  if (options.startStation !== undefined) {
    if (typeof options.startStation !== "string") {
      throw new AppError(400, "INVALID_START_STATION", "startStation must be a string.");
    }

    startStation = options.startStation.trim();

    if (!startStation || startStation.length > 200) {
      throw new AppError(400, "INVALID_START_STATION", "startStation is invalid.");
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
    startStation
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

function normalizeStopName(value) {
  return value
    .normalize("NFKD")
    .replace(/\p{M}/gu, "")
    .replace(/ı/g, "i")
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
}

function directionId(start, end) {
  return `${normalizeStopName(start)}__${normalizeStopName(end)}`;
}

function resolveStartStation(stops, geometry, requestedName) {
  const normalizedRequest = normalizeStopName(requestedName);
  const matches = stops
    .map((stop, stationIndex) => ({
      stop,
      stationIndex,
      stationName: stopName(stop)
    }))
    .filter(candidate => {
      return candidate.stationName
        && normalizeStopName(candidate.stationName) === normalizedRequest;
    });

  if (!matches.length) {
    throw new AppError(
      400,
      "START_STATION_NOT_FOUND",
      "The requested start station does not exist on this route.",
      { startStation: requestedName }
    );
  }

  if (matches.length > 1) {
    throw new AppError(
      400,
      "AMBIGUOUS_START_STATION",
      "The requested station occurs more than once on this route.",
      {
        startStation: requestedName,
        stationIndexes: matches.map(match => match.stationIndex)
      }
    );
  }

  const selected = matches[0];
  const coordinate = readOptionalCoordinate(selected.stop);

  if (!coordinate) {
    throw new AppError(
      502,
      "IETT_INVALID_START_STATION",
      "The requested IETT station has invalid coordinates.",
      { startStation: selected.stationName }
    );
  }

  const routeMatch = findClosestRoutePosition(geometry, coordinate);

  if (routeMatch.distanceToRoute > 250) {
    throw new AppError(
      502,
      "IETT_START_STATION_OFF_ROUTE",
      "The requested IETT station is too far from its route geometry.",
      {
        startStation: selected.stationName,
        distanceMeters: Math.round(routeMatch.distanceToRoute)
      }
    );
  }

  return {
    name: selected.stationName,
    index: selected.stationIndex,
    coordinate,
    distanceAlongRoute: routeMatch.distanceAlongRoute
  };
}

function publicVariant(variant) {
  return {
    code: variant.code,
    type: variant.type,
    name: variant.name,
    rawName: variant.rawName,
    start: variant.start,
    end: variant.end
  };
}

export function createIettService({ client = new IettClient() } = {}) {
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

        return {
          variant: {
            code: route.code,
            type: route.type,
            name: route.type === "base"
              ? route.rawName ?? "Normal güzergâh"
              : route.rawName,
            rawName: route.rawName,
            start,
            end,
            directionLabel: `${start} → ${end}`,
            directionId: directionId(start, end)
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
    const geometryOrigin = geometry.points[0];
    const geometryDestination = geometry.points.at(-1);
    const destination = endpointFromStop(stops.at(-1), geometryDestination);
    const stationConstraints = stationConstraintsFromStops(stops, geometry);
    let origin = endpointFromStop(stops[0], geometryOrigin);
    let startDistanceAlongRoute = 0;
    let selectedStartStation = null;
    let originSource = "route-start";

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
      selectedStartStation = resolveStartStation(
        stops,
        geometry,
        options.startStation
      );
      origin = selectedStartStation.coordinate;
      startDistanceAlongRoute = selectedStartStation.distanceAlongRoute;
      originSource = "station";
    }

    const selection = selectWaypoints(geometry, {
      startDistance: startDistanceAlongRoute,
      maxWaypoints: options.maxWaypoints,
      stationConstraints
    });
    const url = provider.buildUrl({
      origin,
      destination,
      waypoints: selection.waypoints
    });
    const result = {
      routeCode,
      provider: provider.id,
      origin,
      originSource,
      destination,
      waypoints: selection.waypoints,
      routeLengthMeters: geometry.totalLength,
      startDistanceAlongRoute,
      remainingRouteLengthMeters: geometry.totalLength - startDistanceAlongRoute,
      stationCount: stops.length,
      stationWaypointCount: selection.waypoints.filter(waypoint => {
        return waypoint.reason === "station";
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

    if (options.debug) {
      result.debug = {
        candidates: selection.candidates,
        minSpacingMeters: selection.minSpacing,
        controlPath: {
          maxDeviationMeters: selection.metrics.maxDeviation,
          percentile95DeviationMeters: selection.metrics.percentile95Deviation
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

  return {
    getIettRouteOptions,
    prepareIettLine: getIettRouteOptions,
    buildIettGoogleMapsRoute,
    buildIettAppleMapsRoute
  };
}
