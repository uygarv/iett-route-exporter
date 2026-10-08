export function coordinateForRouteMatch(_coordinate, routeMatch) {
  return { lat: routeMatch.lat, lng: routeMatch.lng };
}
