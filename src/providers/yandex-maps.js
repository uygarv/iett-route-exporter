const DIRECTIONS_URL = "https://yandex.com/maps/";

function formatCoordinate(point) {
  return `${point.lat},${point.lng}`;
}

export function buildYandexMapsUrl({
  origin,
  destination,
  waypoints,
  useCurrentLocation = false
}) {
  const url = new URL(DIRECTIONS_URL);
  const routePoints = [
    ...(useCurrentLocation ? [] : [origin]),
    ...waypoints,
    destination
  ];
  const routeText = routePoints.map(formatCoordinate).join("~");

  url.searchParams.set("mode", "routes");
  url.searchParams.set("rtext", useCurrentLocation ? `~${routeText}` : routeText);
  url.searchParams.set("rtt", "auto");

  return url.toString();
}
