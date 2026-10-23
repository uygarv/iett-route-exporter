import { findRoutePositionCandidates, haversineDistance } from "./geometry.js";
import { returnedPathGeometry } from "./tomtom-controls.js";

function interpolate(points, distance) {
  for (let index = 1; index < points.length; index += 1) {
    const before = points[index - 1];
    const after = points[index];
    if (distance <= after.distance) {
      const fraction = Math.max(0, Math.min(1, (distance - before.distance) / (after.distance - before.distance || 1)));
      return before.time + fraction * (after.time - before.time);
    }
  }
  return points.at(-1).time;
}

// TomTom progress points belong to the concatenated route path. Convert each
// leg's portion to a monotonic time curve with its own exact summary endpoints.
function timeCurve(geometry, progressPoints, pathOffset, leg, routeDistances) {
  const routePoints = (Array.isArray(progressPoints) ? progressPoints : []).filter(point => point && Number.isInteger(point.pathIndex)
    && point.pathIndex >= 0 && point.pathIndex < routeDistances.length
    && Number.isFinite(point.travelDurationInSeconds) && point.travelDurationInSeconds >= 0);
  if (routePoints.length < 2 || routePoints.some((point, index) => index > 0
    && (point.pathIndex <= routePoints[index - 1].pathIndex
      || point.travelDurationInSeconds < routePoints[index - 1].travelDurationInSeconds))) return null;
  const endIndex = pathOffset + leg.path.coordinates.length - 1;
  const offset = routeDistances[pathOffset];
  const end = routeDistances[endIndex];
  if (offset === undefined || end === undefined || end <= offset
    || routePoints[0].pathIndex > pathOffset || routePoints.at(-1).pathIndex < endIndex) return null;
  function timeAt(index) {
    const afterIndex = routePoints.findIndex(point => point.pathIndex >= index);
    const after = routePoints[afterIndex];
    if (after.pathIndex === index) return after.travelDurationInSeconds;
    const before = routePoints[afterIndex - 1];
    const span = routeDistances[after.pathIndex] - routeDistances[before.pathIndex];
    const fraction = span > 0
      ? (routeDistances[index] - routeDistances[before.pathIndex]) / span
      : (index - before.pathIndex) / (after.pathIndex - before.pathIndex);
    return before.travelDurationInSeconds + fraction * (after.travelDurationInSeconds - before.travelDurationInSeconds);
  }
  const firstTime = timeAt(pathOffset);
  const lastTime = timeAt(endIndex);
  if (lastTime <= firstTime) return null;
  const curve = [{ distance: 0, time: 0 }];
  for (const point of routePoints) {
    if (point.pathIndex <= pathOffset || point.pathIndex >= endIndex) continue;
    const distance = (routeDistances[point.pathIndex] - offset) / (end - offset) * geometry.totalLength;
    if (distance <= curve.at(-1).distance || distance >= geometry.totalLength) continue;
    curve.push({ distance,
      time: (point.travelDurationInSeconds - firstTime) / (lastTime - firstTime) * leg.drivingDurationSeconds
    });
  }
  curve.push({ distance: geometry.totalLength, time: leg.drivingDurationSeconds });
  return curve;
}

export function distributeTomTomLegs(legs, controls, nodes, progressPoints, stopProgressMeters) {
  const rawCount = legs.reduce((sum, leg) => sum + leg.path.coordinates.length, 0);
  const duplicateBoundaries = Array.isArray(progressPoints) && progressPoints.at(-1)?.pathIndex === rawCount - 1;
  const joined = legs.flatMap((leg, index) => index && !duplicateBoundaries
    ? leg.path.coordinates.slice(1) : leg.path.coordinates);
  const routeDistances = [0];
  for (let index = 1; index < joined.length; index += 1) {
    routeDistances.push(routeDistances.at(-1) + haversineDistance(
      { lng: joined[index - 1][0], lat: joined[index - 1][1] },
      { lng: joined[index][0], lat: joined[index][1] }
    ));
  }
  let pathOffset = 0;
  const pieces = [];
  for (const [legIndex, leg] of legs.entries()) {
    const start = controls[legIndex].distanceAlongRoute;
    const end = controls[legIndex + 1].distanceAlongRoute;
    const geometry = returnedPathGeometry(leg.path);
    const curve = timeCurve(geometry, progressPoints, pathOffset, leg, routeDistances);
    const legStartDistance = routeDistances[pathOffset];
    pathOffset += leg.path.coordinates.length - (duplicateBoundaries ? 0 : 1);
    let previousDistance = 0;
    let previousDriving = 0;
    let previousDelay = 0;
    let previousLength = 0;
    let previousEstimate = 0;
    for (let index = 0; index < nodes.length - 1; index += 1) {
      if (nodes[index + 1].distanceAlongRoute <= start || nodes[index].distanceAlongRoute >= end) continue;
      const boundary = Math.min(end, nodes[index + 1].distanceAlongRoute);
      const fraction = (boundary - start) / (end - start);
      const expectedDistance = geometry.totalLength * fraction;
      const matches = findRoutePositionCandidates(geometry, {
        lat: nodes[index + 1].providerCoordinate.lat, lng: nodes[index + 1].providerCoordinate.lng
      });
      const match = matches.reduce((best, candidate) => {
        const score = item => item.distanceToRoute + Math.abs(item.distanceAlongRoute - expectedDistance) * 0.01;
        return best === null || score(candidate) < score(best) ? candidate : best;
      }, null);
      const validatedDistance = stopProgressMeters?.[index + 1] === undefined ? undefined
        : stopProgressMeters[index + 1] - legStartDistance;
      const distance = boundary === end ? geometry.totalLength
        : Math.max(previousDistance, Math.min(geometry.totalLength,
          validatedDistance ?? match?.distanceAlongRoute ?? expectedDistance));
      const driving = boundary === end ? leg.drivingDurationSeconds
        : Math.max(previousDriving, Math.min(leg.drivingDurationSeconds,
          Math.round(curve ? interpolate(curve, distance) : leg.drivingDurationSeconds * distance / geometry.totalLength)));
      const delay = boundary === end ? leg.liveTrafficDelaySeconds
        : Math.max(previousDelay, Math.min(leg.liveTrafficDelaySeconds,
          leg.liveTrafficDelaySeconds * (leg.drivingDurationSeconds ? driving / leg.drivingDurationSeconds : fraction)));
      const length = boundary === end ? leg.distanceMeters : leg.distanceMeters * distance / geometry.totalLength;
      const estimate = (leg.estimatedManeuverDurationSeconds ?? 0) * (leg.drivingDurationSeconds ? driving / leg.drivingDurationSeconds : fraction);
      pieces.push({ ...leg, publicSegmentIndex: index,
        distanceMeters: length - previousLength,
        drivingDurationSeconds: driving - previousDriving,
        liveTrafficDelaySeconds: delay - previousDelay,
        estimatedManeuverDurationSeconds: estimate - previousEstimate,
        stopTimingSource: curve ? "tomtom-progress-interpolation" : "distance-interpolation"
      });
      previousDistance = distance;
      previousDriving = driving;
      previousDelay = delay;
      previousLength = length;
      previousEstimate = estimate;
    }
  }
  return pieces;
}
