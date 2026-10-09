const DIRECTIONS_URL = "https://maps.apple.com/directions";

function formatCoordinate(point) {
  return `${point.lat},${point.lng}`;
}

export function buildAppleMapsUrl({
  origin,
  destination,
  waypoints,
  useCurrentLocation = false
}) {
  const url = new URL(DIRECTIONS_URL);

  if (!useCurrentLocation) {
    url.searchParams.set("source", formatCoordinate(origin));
  }

  url.searchParams.set("destination", formatCoordinate(destination));
  url.searchParams.set("mode", "driving");

  for (const waypoint of waypoints) {
    url.searchParams.append("waypoint", formatCoordinate(waypoint));
  }

  return url.toString();
}
