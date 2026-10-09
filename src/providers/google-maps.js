const DIRECTIONS_URL = "https://www.google.com/maps/dir/";

function formatCoordinate(point) {
  return `${point.lat},${point.lng}`;
}

export function buildGoogleMapsUrl({
  origin,
  destination,
  waypoints,
  useCurrentLocation = false
}) {
  const url = new URL(DIRECTIONS_URL);

  url.searchParams.set("api", "1");

  if (!useCurrentLocation) {
    url.searchParams.set("origin", formatCoordinate(origin));
  }

  url.searchParams.set("destination", formatCoordinate(destination));
  url.searchParams.set("travelmode", "driving");

  if (waypoints.length) {
    url.searchParams.set("waypoints", waypoints.map(formatCoordinate).join("|"));
  }

  return url.toString();
}
