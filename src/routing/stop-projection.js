export const STOP_PROJECTION_THRESHOLD_METERS = 0;

export function coordinateForRouteMatch(coordinate, routeMatch) {
  if (routeMatch.distanceToRoute <= STOP_PROJECTION_THRESHOLD_METERS) {
    return { lat: coordinate.lat, lng: coordinate.lng };
  }

  return { lat: routeMatch.lat, lng: routeMatch.lng };
}
