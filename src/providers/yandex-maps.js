const DIRECTIONS_URL = "https://yandex.com/maps/";

function formatCoordinate(point) {
  return `${point.lat},${point.lng}`;
}

export function buildYandexMapsUrl({ origin, destination, waypoints }) {
  const url = new URL(DIRECTIONS_URL);
  const routePoints = [origin, ...waypoints, destination];

  url.searchParams.set("mode", "routes");
  url.searchParams.set("rtext", routePoints.map(formatCoordinate).join("~"));
  url.searchParams.set("rtt", "auto");

  return url.toString();
}
