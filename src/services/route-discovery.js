import { AppError } from "../shared/errors.js";
import { requireCode } from "../shared/validation.js";
import { normalizeRouteStops, stationName as stopName, normalizeStationName } from "../routing/stations.js";

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

export function createRouteDiscoveryService({ client }) {
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

        const readableStops = normalizeRouteStops(stops);

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

  return { getIettRouteOptions };
}
