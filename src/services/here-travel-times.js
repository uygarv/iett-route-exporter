import { AppError } from "../shared/errors.js";
import { HERE_HTTP_ATTEMPTS } from "../clients/here-client.js";
import { createGeometryMatcher } from "../routing/geometry-match.js";
import { haversineDistance } from "../routing/geometry.js";
import { evaluateLocalRouteAlternative } from "../routing/tomtom-local-alternative.js";
import { createHereTrace, splitHereTrace, readHereRoute, locateHerePieces, joinHerePieces,
  validatedHereCoverage, estimateHereGaps, herePublicSegments } from "../routing/here-route.js";
import { compactGeometryMatch, resultEnvelope } from "./travel-time-common.js";

const point = p => ({ lng: p[0], lat: p[1] });
const distance = (a, b) => haversineDistance(point(a), point(b));
const rounded = n => Math.round(n * 10) / 10;
const coverageErrors = new Set(["HERE_NO_ROUTE", "IETT_ROUTE_RECONSTRUCTION_FAILED"]);
const pathLength = path => path.coordinates.slice(1).reduce((n, p, i) => n + distance(path.coordinates[i], p), 0);

export function createHereRoutingService({ hereClient, geometryPolicy, shapeCacheTtlMs, shapeCacheMaxEntries, clock }) {
  const geometryMatcher = createGeometryMatcher({ policy: geometryPolicy });
  const matcher = {
    evaluate(reference, returned, reportedLength, stops) {
      const sourceLength = pathLength(reference), returnedLength = pathLength(returned);
      // Reject obvious large detours before allocating an ordered alignment
      // matrix. Otherwise an implausibly long provider route could consume
      // resources proportional to the detour instead of the requested line.
      const fraction = Math.max(0.5, geometryPolicy?.lengthToleranceFraction ?? 0.1);
      if (Math.abs(sourceLength - returnedLength) > Math.max(500, sourceLength * fraction)
        || Math.min(sourceLength, returnedLength) < 2) {
        return { valid: false, quality: "rejected", reasons: ["LENGTH_MISMATCH"],
          referenceLengthMeters: sourceLength, returnedLengthMeters: reportedLength,
          returnedPathLengthMeters: returnedLength, deviations: { reference: [], returned: [] } };
      }
      return geometryMatcher.evaluate(reference, returned, reportedLength, stops);
    },
    clear() { geometryMatcher.clear(); }
  };
  const shapes = new Map(), preparing = new Map();
  let generation = 0;

  async function run({ routeCode, prepared, nodes, options }, reference, handles = []) {
    const departureTime = options.departureTime === "now" ? new Date(Number(clock())).toISOString()
      : /(?:Z|[+-]\d{2}:\d{2})$/i.test(options.departureTime) ? new Date(options.departureTime).toISOString()
        : new Date(`${options.departureTime}+03:00`).toISOString();
    const parts = splitHereTrace(reference), operations = [], repairs = [], matches = [], rejected = [];
    const pieces = [], summaries = [], notices = [], nextHandles = [];
    let httpRequests = 0, sectionCount = 0, elapsed = 0;
    // One import (plus a stale-handle refresh) and two optional repair attempts
    // per request-sized source chunk. Exhausting repairs never rejects a line.
    const maximumOperations = parts.length * 4;
    async function call(type, chunkIndex, request) {
      const operation = { type, chunkIndex, httpRequestCount: 0 }; operations.push(operation);
      try {
        const response = await request();
        operation.httpRequestCount = response[HERE_HTTP_ATTEMPTS] ?? 1;
        httpRequests += operation.httpRequestCount; return response;
      } catch (error) {
        operation.httpRequestCount = error[HERE_HTTP_ATTEMPTS] ?? 1;
        httpRequests += operation.httpRequestCount; throw error;
      }
    }
    async function nativeRoute(part, chunkIndex, chunkDeparture) {
      let response;
      if (handles[chunkIndex]) {
        try {
          response = await call("route-handle", chunkIndex, () => hereClient.getRouteByHandle(handles[chunkIndex], { departureTime: chunkDeparture }));
          return readHereRoute(response);
        } catch (error) {
          if (error.code !== "HERE_ROUTE_HANDLE_INVALID" && !coverageErrors.has(error.code)) throw error;
        }
      }
      try {
        response = await call("import", chunkIndex, () => hereClient.importRoute({ trace: part.trace, via: part.via, departureTime: chunkDeparture }));
        return readHereRoute(response);
      } catch (error) {
        if (!coverageErrors.has(error.code)) throw error;
        notices.push(...(error.details?.notices ?? []), { code: error.code, severity: "warning" });
        return { pieces: [], sectionCount: 0, summaries: [], notices: [] };
      }
    }
    try {
      for (const [chunkIndex, part] of parts.entries()) {
        const chunkDeparture = new Date(Date.parse(departureTime) + elapsed * 1000).toISOString();
        const native = await nativeRoute(part, chunkIndex, chunkDeparture);
        nextHandles.push(native.handle);
        sectionCount += native.sectionCount; summaries.push(...native.summaries); notices.push(...native.notices);
        const stopDistances = nodes.map(n => n.distanceAlongRoute - part.offset).filter(at => at >= 0 && at <= part.geometry.totalLength);
        let chunkPieces, match;
        try {
          chunkPieces = native.pieces.length ? locateHerePieces(native.pieces, part) : [];
          if (chunkPieces.length) {
            match = matcher.evaluate(part.referencePath, joinHerePieces(chunkPieces),
              chunkPieces.reduce((n, p) => n + p.distanceMeters, 0), stopDistances);
            if (!match.valid && parts.length === 1) {
              const ranges = nodes.slice(1).flatMap((node, i) => (match.deviations.reference ?? []).some(region =>
                node.distanceAlongRoute > part.offset + region.startMeters && nodes[i].distanceAlongRoute < part.offset + region.endMeters)
                ? [{ start: nodes[i].distanceAlongRoute, end: node.distanceAlongRoute }] : []);
              match = evaluateLocalRouteAlternative({ matcher, match, nodes, geometry: prepared.geometry,
                returnedPath: joinHerePieces(chunkPieces), plan: { alternativeRanges: ranges } });
            }
          }
        } catch (error) {
          if (!coverageErrors.has(error.code)) throw error;
          match = { valid: false, reasons: [error.details?.reason ?? error.code] };
        }
        if (!match?.valid) {
          const salvaged = validatedHereCoverage(native.pieces, part, matcher, stopDistances);
          chunkPieces = salvaged.pieces;
          rejected.push(...salvaged.rejected.map(p => ({ ...p, chunkIndex })));
        }
        matches.push({ chunkIndex, ...(match ?? { valid: false, reasons: ["HERE_NO_ROUTE"] }) });
        const gaps = chunkPieces.filter(p => p.source === "gap").sort((a, b) => b.distanceMeters - a.distanceMeters);
        for (const gap of gaps.slice(0, 2)) {
          const before = chunkPieces.slice(0, chunkPieces.indexOf(gap));
          // Include conservative estimates for earlier gaps in the repair's
          // traffic departure, rather than treating missing roads as zero time.
          const seconds = before.reduce((n, p) => n + (p.duration ?? Math.max(8, Math.ceil(p.distanceMeters / 2.5))), 0)
            + nodes.slice(1, -1).filter(n => n.distanceAlongRoute > part.offset + 0.001
              && n.distanceAlongRoute <= gap.start + part.offset + 0.001).length * options.dwellTimeSeconds;
          try {
            const response = await call("local-repair", chunkIndex, () => hereClient.calculateRoute({
              origin: point(gap.path.coordinates[0]), destination: point(gap.path.coordinates.at(-1)),
              departureTime: new Date(Date.parse(chunkDeparture) + seconds * 1000).toISOString()
            }));
            const repaired = readHereRoute(response).pieces, repairedPath = joinHerePieces(repaired);
            const repairMatch = matcher.evaluate(gap.path, repairedPath, repaired.reduce((n, p) => n + p.distanceMeters, 0));
            const continuous = repaired.every((p, i) => !i || distance(repaired[i - 1].path.coordinates.at(-1), p.path.coordinates[0]) <= 5);
            const connected = distance(gap.path.coordinates[0], repairedPath.coordinates[0]) <= 5
              && distance(gap.path.coordinates.at(-1), repairedPath.coordinates.at(-1)) <= 5;
            const accepted = repairMatch.valid && continuous && connected;
            repairs.push({ startDistanceAlongRoute: rounded(gap.start + part.offset),
              endDistanceAlongRoute: rounded(gap.end + part.offset), accepted, geometryMatch: repairMatch });
            if (accepted) {
              const length = repaired.reduce((n, p) => n + p.geometry.totalLength, 0);
              let progress = gap.start;
              for (const p of repaired) {
                p.start = progress; progress += (gap.end - gap.start) * p.geometry.totalLength / length; p.end = progress;
              }
              repaired.at(-1).end = gap.end;
              chunkPieces.splice(chunkPieces.indexOf(gap), 1, ...repaired);
            }
          } catch (error) {
            if (!coverageErrors.has(error.code)) throw error;
            repairs.push({ startDistanceAlongRoute: rounded(gap.start + part.offset),
              endDistanceAlongRoute: rounded(gap.end + part.offset), accepted: false, errorCode: error.code });
          }
        }
        // If a provider changes direction or makes a detour, only independently
        // validated timing survives. The missing source intervals have no cap.
        estimateHereGaps(chunkPieces);
        pieces.push(...chunkPieces.map(p => ({ ...p, start: p.start + part.start, end: p.end + part.start })));
        elapsed += chunkPieces.reduce((n, p) => n + p.duration, 0)
          + nodes.slice(1, -1).filter(n => n.distanceAlongRoute - reference.offset > part.start + 0.001
            && n.distanceAlongRoute - reference.offset <= part.end + 0.001).length * options.dwellTimeSeconds;
      }
      const estimated = pieces.filter(p => p.source === "estimate");
      const segments = herePublicSegments(pieces, reference, nodes, options, departureTime);
      const total = segments.reduce((a, s) => {
        for (const k of ["distanceMeters", "drivingDurationSeconds", "providerDrivingDurationSeconds", "trafficDelaySeconds"]) a[k] += s[k];
        a.dwellDurationSeconds += s.dwellAfterArrivalSeconds;
        a.estimatedUnmappedDurationSeconds += s.estimatedUnmappedDurationSeconds ?? 0; return a;
      }, { distanceMeters: 0, drivingDurationSeconds: 0, providerDrivingDurationSeconds: 0,
        dwellDurationSeconds: 0, trafficDelaySeconds: 0, estimatedUnmappedDurationSeconds: 0 });
      const expectedProviderDuration = Math.round(pieces.filter(p => p.source === "provider").reduce((n, p) => n + p.duration, 0));
      const expectedEstimatedDuration = estimated.reduce((n, p) => n + p.duration, 0);
      if (total.providerDrivingDurationSeconds !== expectedProviderDuration || total.estimatedUnmappedDurationSeconds !== expectedEstimatedDuration) {
        throw new AppError(502, "HERE_MALFORMED_RESPONSE", "HERE stop allocation did not preserve the complete accepted duration.");
      }
      total.distanceMeters = rounded(total.distanceMeters);
      total.estimatedDurationSeconds = total.drivingDurationSeconds + total.dwellDurationSeconds;
      total.departureTime = segments[0].departureTime; total.arrivalTime = segments.at(-1).arrivalTime;
      if (!estimated.length) delete total.estimatedUnmappedDurationSeconds;
      const providerDistance = pieces.filter(p => p.source === "provider").reduce((n, p) => n + Math.max(0, p.end - p.start), 0);
      const sourceLength = reference.geometry.totalLength;
      const timingCoverage = { basis: "iett-route-distance", totalDistanceMeters: rounded(sourceLength),
        providerDistanceMeters: rounded(providerDistance), estimatedDistanceMeters: rounded(Math.max(0, sourceLength - providerDistance)),
        providerCoverageRatio: Math.round(Math.min(1, providerDistance / sourceLength) * 10000) / 10000,
        fullyProviderCovered: !estimated.length && providerDistance >= sourceLength - 1,
        estimatedTraversalDistanceMeters: rounded(estimated.reduce((n, p) => n + p.distanceMeters, 0)),
        ...(estimated.length ? { estimationMethod: "adjacent-here-speed-capped-at-2.5-mps-or-conservative-urban-speed" } : {}) };
      const approximate = matches.some(m => m.quality === "approximate");
      const match = { ...(matches.length === 1 && matches[0].valid ? matches[0] : {}), valid: true,
        quality: estimated.length ? "estimated" : approximate ? "approximate" : "validated",
        acceptanceBasis: "iett-source-geometry-with-validated-provider-timing",
        providerGeometryValid: !estimated.length,
        ...(estimated.length ? { estimatedLengthMeters: timingCoverage.estimatedDistanceMeters } : {}) };
      const warnings = [];
      if (approximate) warnings.push({ code: "IETT_GEOMETRY_APPROXIMATION",
        message: "Travel time uses bounded nearby HERE roads that preserve IETT stop order." });
      if (estimated.length) warnings.push({ code: "UNMAPPED_IETT_SECTION_ESTIMATED",
        message: "Unmatched IETT sections retain the original route and use separately identified estimated durations. Estimate quality decreases as provider coverage falls.",
        count: estimated.length, estimatedDurationSeconds: expectedEstimatedDuration,
        estimatedLengthMeters: timingCoverage.estimatedDistanceMeters, providerCoverageRatio: timingCoverage.providerCoverageRatio });
      if (!providerDistance) warnings.push({ code: "HERE_ROUTE_TIMING_UNAVAILABLE",
        message: "HERE could not validate timing for this route. The entire driving duration is a conservative estimate, without provider traffic coverage." });
      if (rejected.length) warnings.push({ code: "HERE_GEOMETRY_SECTIONS_DISCARDED",
        message: "Provider sections that changed the IETT route or order were excluded from driving time.", count: rejected.length });
      if (pieces.some(p => p.source === "provider" && !p.spans?.length)) warnings.push({ code: "STOP_TIMES_DISTANCE_INTERPOLATED",
        message: "HERE span timing was unavailable; stop times were interpolated by distance, preserving accepted provider totals." });
      if (notices.length) warnings.push({ code: "HERE_PROVIDER_NOTICES",
        message: "HERE reported route-matching notices; only validated provider timing was used.", notices });
      const result = { ...resultEnvelope({ routeCode, provider: "here", options, nodes, clock }), total,
        geometry: reference.referencePath, geometrySource: "iett", timingCoverage,
        trafficDataBasis: !providerDistance ? "unavailable-estimated" : options.departureTime === "now" ? "live-and-historical" : "historical-with-known-live-events",
        geometryMatch: compactGeometryMatch(match), segments,
        stopTimingSource: segments.every(s => s.stopTimingSource === segments[0].stopTimingSource) ? segments[0].stopTimingSource : "mixed-interpolation",
        routingQuality: !providerDistance ? "iett-geometry-estimated-timing" : estimated.length ? "validated-with-iett-section-estimate"
          : approximate ? "here-geometry-approximate" : "here-geometry-validated",
        ...(warnings.length ? { warnings } : {}) };
      if (options.debug) result.debug = { geometryMatch: match, providerGeometryMatches: matches, discardedProviderSections: rejected,
        transportMode: "car", tracePointCount: reference.trace.length, importChunkCount: parts.length,
        routingAnchorCount: reference.via.length, providerSectionCount: sectionCount,
        upstreamRequestCount: httpRequests, maximumUpstreamRequestCount: maximumOperations * 2,
        geometryAttemptCount: operations.length, maximumGeometryAttemptCount: maximumOperations,
        operations, reconstructionRepairs: repairs, providerNotices: notices,
        estimatedSections: estimated.map(p => ({ startDistanceAlongRoute: rounded(p.start + reference.offset),
          endDistanceAlongRoute: rounded(p.end + reference.offset), distanceMeters: rounded(p.distanceMeters),
          estimatedDurationSeconds: p.duration, ...p.estimation })), providerSummary: summaries };
      return { result, handles: nextHandles };
    } catch (error) {
      if (error instanceof AppError) error.details = { ...error.details, upstreamRequestCount: httpRequests,
        maximumUpstreamRequestCount: maximumOperations * 2, geometryAttemptCount: operations.length, maximumGeometryAttemptCount: maximumOperations };
      throw error;
    }
  }

  async function calculate(context) {
    const { prepared, nodes, options, routeCode } = context;
    const key = JSON.stringify(["here", routeCode, prepared.fingerprint, "car", options.dwellTimeSeconds,
      nodes.map(n => [n.stationIndex, n.distanceAlongRoute, n.providerCoordinate])]);
    const entry = () => {
      const cached = shapes.get(key);
      if (cached && cached.expiresAt > Number(clock())) return cached;
      shapes.delete(key); return undefined;
    };
    if (!entry() && preparing.has(key)) await preparing.get(key).catch(() => {});
    const cached = entry(), currentGeneration = generation;
    const reference = createHereTrace(prepared.geometry, nodes, options.dwellTimeSeconds);
    const pending = run(context, reference, cached?.handles).then(({ result, handles }) => {
      if (generation === currentGeneration && handles.some(Boolean)) {
        if (shapes.size >= shapeCacheMaxEntries && !shapes.has(key)) shapes.delete(shapes.keys().next().value);
        shapes.set(key, { handles, expiresAt: cached?.expiresAt ?? Number(clock()) + shapeCacheTtlMs });
      } else if (shapes.get(key) === cached) shapes.delete(key);
      return result;
    });
    if (!cached) {
      preparing.set(key, pending);
      const forget = () => { if (preparing.get(key) === pending) preparing.delete(key); };
      pending.then(forget, forget);
    }
    return pending;
  }
  return { calculate, clearCache() { generation += 1; shapes.clear(); preparing.clear(); matcher.clear(); } };
}
