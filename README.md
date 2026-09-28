# IETT route export API

This service converts official IETT route geometry into Google Maps and Apple Maps driving directions.

It uses IETT route geometry and stop data directly. It does not call the Google Maps API, Apple MapKit, or another routing service.

## Run

```bash
npm install
npm start
```

The server listens on port `3000` by default.

## Example

Run route discovery and URL generation for IETT line `256`:

```bash
npm run example
```

## Options of a line

```bash
curl http://localhost:3000/api/iett/lines/256/options
```

The service constructs and validates the two standard route codes, `<line>_G_D0` and `<line>_D_D0`, then uses `GetAllRoute` to discover additional or depar variants.

## Build a Google Maps URL

```bash
curl -X POST http://localhost:3000/api/iett/routes/256_G_D0/google-maps \
  -H 'content-type: application/json' \
  -d '{"maxWaypoints":9,"debug":false}'
```

Google Maps supports up to 9 intermediate waypoints.

### Sample output

```json
{
  "routeCode": "256_G_D0",
  "provider": "google-maps",
  "origin": {
    "lat": 40.9745340005498,
    "lng": 29.1539319999923
  },
  "originSource": "route-start",
  "destination": {
    "lat": 41.0391480005601,
    "lng": 28.9888429999892
  },
  "waypoints": [
    {
      "lat": 40.9824190005511,
      "lng": 29.1656109999925,
      "reason": "station",
      "stationName": "ÜSKÜDAR CADDESİ",
      "stationIndex": 3
    },
    ...
  ],
  "routeLengthMeters": 30154.34,
  "startDistanceAlongRoute": 0,
  "remainingRouteLengthMeters": 30154.34,
  "stationCount": 47,
  "stationWaypointCount": 9,
  "originalPointCount": 838,
  "resampledPointCount": 1007,
  "url": "https://www.google.com/maps/dir/?api=1&origin=40.9745340005498%2C29.1539319999923&destination=41.0391480005601%2C28.9888429999892&travelmode=driving&waypoints=..."
}
```

## Build an Apple Maps URL

```bash
curl -X POST http://localhost:3000/api/iett/routes/256_G_D0/apple-maps \
  -H 'content-type: application/json' \
  -d '{"maxWaypoints":13,"debug":false}'
```

Apple Maps supports up to 13 intermediate waypoints in this service.

### Sample output

```json
{
  "routeCode": "256_G_D0",
  "provider": "apple-maps",
  "origin": {
    "lat": 40.9745340005498,
    "lng": 29.1539319999923
  },
  "originSource": "route-start",
  "destination": {
    "lat": 41.0391480005601,
    "lng": 28.9888429999892
  },
  "waypoints": [
    {
      "lat": 40.9824190005511,
      "lng": 29.1656109999925,
      "reason": "station",
      "stationName": "ÜSKÜDAR CADDESİ",
      "stationIndex": 3
    },
    ...
  ],
  "routeLengthMeters": 30154.34,
  "startDistanceAlongRoute": 0,
  "remainingRouteLengthMeters": 30154.34,
  "stationCount": 47,
  "stationWaypointCount": 13,
  "originalPointCount": 838,
  "resampledPointCount": 1007,
  "url": "https://maps.apple.com/directions?source=40.9745340005498%2C29.1539319999923&destination=41.0391480005601%2C28.9888429999892&mode=driving&waypoint=..."
}
```

## Start from a bus stop

Both map providers can start directions from a specific IETT stop.

```bash
curl -X POST http://localhost:3000/api/iett/routes/256_D_D0/apple-maps \
  -H 'content-type: application/json' \
  -d '{"startStation":"KÖPRÜLÜ KAVŞAK"}'
```

The response identifies the resolved stop and uses its exact IETT coordinate as the origin:

```json
{
  "originSource": "station",
  "startStation": {
    "name": "KÖPRÜLÜ KAVŞAK",
    "index": 11
  },
  "origin": {
    "lat": 41.0663270005644,
    "lng": 29.0116029999897
  },
  "startDistanceAlongRoute": 4862.366010391871
}
```

## Already on the bus

If the rider is already on the bus, provide their current location instead of a start station.

The service keeps the current coordinate as the route origin, removes the traveled portion and optimizes waypoints only for the remaining route.

```bash
curl -X POST http://localhost:3000/api/iett/routes/256_G_D0/google-maps \
  -H 'content-type: application/json' \
  -d '{"currentLocation":{"lat":41.0,"lng":29.0}}'
```

To demonstrate this behavior with the example script, provide coordinates from the selected route:

```bash
CURRENT_LAT=40.99 CURRENT_LNG=29.13 npm run example
```

`startStation` and `currentLocation` cannot be supplied together.

## Debug mode

Set `debug` to `true` to include waypoint candidates, component scores, selection status, adaptive spacing, and route-deviation metrics.

```json
{
  "debug": true
}
```

## Library use

```js
import {
  buildIettAppleMapsRoute,
  buildIettGoogleMapsRoute,
  getIettRouteOptions
} from "./src/index.js";

const options = await getIettRouteOptions("256");

const variants = options.directions.flatMap(
  direction => direction.variants
);

const selected = variants.find(
  variant => variant.code === "256_G_D0"
);

if (selected) {
  const googleResult = await buildIettGoogleMapsRoute(selected.code, {
    maxWaypoints: 9,
    debug: true
  });

  console.log(googleResult.url);

  const appleResult = await buildIettAppleMapsRoute(selected.code, {
    maxWaypoints: 13
  });

  console.log(appleResult.url);
}
```
