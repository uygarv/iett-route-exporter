import { AppError } from "../shared/errors.js";

const EARTH_RADIUS_METERS = 6_371_008.8;
const ISTANBUL_BOUNDS = {
  minLat: 39.5,
  maxLat: 42,
  minLng: 26.5,
  maxLng: 31.5
};

function toRadians(value) {
  return value * Math.PI / 180;
}

export function clamp(value, minimum, maximum) {
  return Math.min(Math.max(value, minimum), maximum);
}

export function haversineDistance(first, second) {
  const lat1 = toRadians(first.lat);
  const lat2 = toRadians(second.lat);
  const deltaLat = lat2 - lat1;
  const deltaLng = toRadians(second.lng - first.lng);
  const haversine = Math.sin(deltaLat / 2) ** 2
    + Math.cos(lat1) * Math.cos(lat2) * Math.sin(deltaLng / 2) ** 2;

  return 2 * EARTH_RADIUS_METERS * Math.asin(Math.sqrt(haversine));
}

function isIstanbulCoordinate(point) {
  return Number.isFinite(point.lat)
    && Number.isFinite(point.lng)
    && point.lat >= ISTANBUL_BOUNDS.minLat
    && point.lat <= ISTANBUL_BOUNDS.maxLat
    && point.lng >= ISTANBUL_BOUNDS.minLng
    && point.lng <= ISTANBUL_BOUNDS.maxLng;
}

export function parseWktSegments(line) {
  if (typeof line !== "string" || !line.trim()) {
    throw new AppError(502, "IETT_EMPTY_GEOMETRY", "The IETT route has no geometry.");
  }

  const rawSegments = line.split("|").map(value => value.trim()).filter(Boolean);

  if (!rawSegments.length) {
    throw new AppError(502, "IETT_EMPTY_GEOMETRY", "The IETT route has no geometry.");
  }

  return rawSegments.map((segment, segmentIndex) => {
    const match = segment.match(/^LINESTRING\s*\((.*)\)$/i);

    if (!match) {
      throw new AppError(502, "IETT_INVALID_GEOMETRY", "The IETT route contains malformed WKT.", {
        segmentIndex
      });
    }

    const points = match[1].split(",").map((pair, pointIndex) => {
      const values = pair.trim().split(/\s+/).map(Number);
      const point = { lng: values[0], lat: values[1] };

      if (values.length < 2 || !isIstanbulCoordinate(point)) {
        throw new AppError(502, "IETT_INVALID_GEOMETRY", "The IETT route contains an invalid coordinate.", {
          segmentIndex,
          pointIndex
        });
      }

      return point;
    });

    if (points.length < 2) {
      throw new AppError(502, "IETT_INVALID_GEOMETRY", "An IETT LINESTRING has fewer than two points.", {
        segmentIndex
      });
    }

    return points;
  });
}

export function buildRouteGeometry(line) {
  const segments = parseWktSegments(line);
  const rawPointCount = segments.reduce((sum, segment) => sum + segment.length, 0);
  const points = [];
  const cumulativeDistances = [];
  const routeEdges = [];
  const boundaryDistances = [];
  let totalLength = 0;

  for (let segmentIndex = 0; segmentIndex < segments.length; segmentIndex += 1) {
    const segment = segments[segmentIndex];

    if (segmentIndex > 0) {
      const gap = haversineDistance(points.at(-1), segment[0]);

      if (gap > 1_000) {
        throw new AppError(502, "IETT_DISCONNECTED_GEOMETRY", "The IETT route geometry contains a large gap.", {
          segmentIndex,
          gapMeters: Math.round(gap)
        });
      }
    }

    for (let pointIndex = 0; pointIndex < segment.length; pointIndex += 1) {
      const point = segment[pointIndex];

      if (!points.length) {
        points.push(point);
        cumulativeDistances.push(0);
        routeEdges.push(false);
        continue;
      }

      const distance = haversineDistance(points.at(-1), point);

      if (distance < 2) {
        continue;
      }

      totalLength += distance;
      points.push(point);
      cumulativeDistances.push(totalLength);
      routeEdges.push(!(segmentIndex > 0 && pointIndex === 0));
    }

    if (segmentIndex < segments.length - 1) {
      boundaryDistances.push(totalLength);
    }
  }

  if (points.length < 2 || totalLength < 1) {
    throw new AppError(502, "IETT_EMPTY_GEOMETRY", "The IETT route geometry is too short to process.");
  }

  const projector = createProjector(points);

  return {
    points,
    cumulativeDistances,
    routeEdges,
    boundaryDistances,
    totalLength,
    rawPointCount,
    projector
  };
}

export function createProjector(points) {
  const centerLat = points.reduce((sum, point) => sum + point.lat, 0) / points.length;
  const centerLng = points.reduce((sum, point) => sum + point.lng, 0) / points.length;
  const centerLatRadians = toRadians(centerLat);

  return {
    project(point) {
      return {
        x: EARTH_RADIUS_METERS * toRadians(point.lng - centerLng) * Math.cos(centerLatRadians),
        y: EARTH_RADIUS_METERS * toRadians(point.lat - centerLat)
      };
    }
  };
}

export function pointAlongRoute(geometry, distanceAlongRoute) {
  const distance = clamp(distanceAlongRoute, 0, geometry.totalLength);
  const cumulative = geometry.cumulativeDistances;

  let low = 0;
  let high = cumulative.length - 1;

  while (low < high) {
    const middle = Math.floor((low + high) / 2);

    if (cumulative[middle] < distance) {
      low = middle + 1;
    } else {
      high = middle;
    }
  }

  if (low === 0) {
    return { ...geometry.points[0], distanceAlongRoute: distance };
  }

  const previousDistance = cumulative[low - 1];
  const nextDistance = cumulative[low];

  if (!geometry.routeEdges[low]) {
    const usePrevious = distance - previousDistance <= nextDistance - distance;
    const index = usePrevious ? low - 1 : low;

    return {
      ...geometry.points[index],
      distanceAlongRoute: cumulative[index]
    };
  }

  const span = nextDistance - previousDistance;
  const ratio = span > 0 ? (distance - previousDistance) / span : 0;
  const previous = geometry.points[low - 1];
  const next = geometry.points[low];

  return {
    lat: previous.lat + (next.lat - previous.lat) * ratio,
    lng: previous.lng + (next.lng - previous.lng) * ratio,
    distanceAlongRoute: distance
  };
}

export function resampleRoute(geometry, spacingMeters = 30) {
  const points = [];

  for (let distance = 0; distance < geometry.totalLength; distance += spacingMeters) {
    const point = pointAlongRoute(geometry, distance);

    if (points.at(-1)?.distanceAlongRoute !== point.distanceAlongRoute) {
      points.push(point);
    }
  }

  const finalPoint = pointAlongRoute(geometry, geometry.totalLength);

  if (points.at(-1)?.distanceAlongRoute !== finalPoint.distanceAlongRoute) {
    points.push(finalPoint);
  }

  return points;
}

function projectToSegment(point, start, end) {
  const deltaX = end.x - start.x;
  const deltaY = end.y - start.y;
  const lengthSquared = deltaX ** 2 + deltaY ** 2;
  const rawRatio = lengthSquared > 0
    ? ((point.x - start.x) * deltaX + (point.y - start.y) * deltaY) / lengthSquared
    : 0;
  const ratio = clamp(rawRatio, 0, 1);
  const projected = {
    x: start.x + deltaX * ratio,
    y: start.y + deltaY * ratio
  };

  return {
    ratio,
    distance: Math.hypot(point.x - projected.x, point.y - projected.y)
  };
}

export function findRoutePositionCandidates(geometry, coordinate) {
  const projectedCoordinate = geometry.projector.project(coordinate);
  const matches = [];

  for (let index = 1; index < geometry.points.length; index += 1) {
    if (!geometry.routeEdges[index]) {
      continue;
    }

    const start = geometry.projector.project(geometry.points[index - 1]);
    const end = geometry.projector.project(geometry.points[index]);
    const match = projectToSegment(projectedCoordinate, start, end);
    const segmentDistance = geometry.cumulativeDistances[index]
      - geometry.cumulativeDistances[index - 1];
    const distanceAlongRoute = geometry.cumulativeDistances[index - 1]
      + segmentDistance * match.ratio;
    const previous = geometry.points[index - 1];
    const next = geometry.points[index];

    matches.push({
      distanceToRoute: match.distance,
      distanceAlongRoute,
      segmentIndex: index - 1,
      lat: previous.lat + (next.lat - previous.lat) * match.ratio,
      lng: previous.lng + (next.lng - previous.lng) * match.ratio
    });
  }

  return matches;
}

export function findClosestRoutePosition(geometry, coordinate) {
  const matches = findRoutePositionCandidates(geometry, coordinate);

  matches.sort((first, second) => first.distanceToRoute - second.distanceToRoute);
  const best = matches[0];
  const ambiguous = matches.some(match => {
    const similarlyClose = match.distanceToRoute <= Math.max(best.distanceToRoute + 15, 30);
    const differentProgress = Math.abs(match.distanceAlongRoute - best.distanceAlongRoute) > 500;

    return similarlyClose && differentProgress;
  });

  return { ...best, ambiguous };
}

function perpendicularDistance(point, start, end, projector) {
  const projectedPoint = projector.project(point);
  const projectedStart = projector.project(start);
  const projectedEnd = projector.project(end);

  return projectToSegment(projectedPoint, projectedStart, projectedEnd).distance;
}

export function measureControlPath(geometry, controlDistances, samples) {
  const sorted = [...controlDistances].sort((first, second) => first - second);
  const deviations = [];
  let maxDeviation = 0;
  let maxDeviationDistance = sorted[0];
  let squaredDeviationTotal = 0;
  let controlIndex = 0;

  for (const sample of samples) {
    if (sample.distanceAlongRoute < sorted[0] || sample.distanceAlongRoute > sorted.at(-1)) {
      continue;
    }

    while (
      controlIndex < sorted.length - 2
      && sample.distanceAlongRoute > sorted[controlIndex + 1]
    ) {
      controlIndex += 1;
    }

    const start = pointAlongRoute(geometry, sorted[controlIndex]);
    const end = pointAlongRoute(geometry, sorted[controlIndex + 1]);
    const deviation = perpendicularDistance(sample, start, end, geometry.projector);

    deviations.push(deviation);
    squaredDeviationTotal += deviation ** 2;

    if (deviation > maxDeviation) {
      maxDeviation = deviation;
      maxDeviationDistance = sample.distanceAlongRoute;
    }
  }

  deviations.sort((first, second) => first - second);
  const percentileIndex = Math.max(0, Math.ceil(deviations.length * 0.95) - 1);

  return {
    maxDeviation,
    percentile95Deviation: deviations[percentileIndex] ?? 0,
    rootMeanSquareDeviation: deviations.length
      ? Math.sqrt(squaredDeviationTotal / deviations.length)
      : 0,
    maxDeviationDistance
  };
}
