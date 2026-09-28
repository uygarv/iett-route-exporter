# IETT route export API

This service discovers official IETT route variants and converts their geometry into Google Maps and Apple Maps driving-directions URLs. It does not call a maps API or any external routing service.

## Run

```bash
npm install
npm start
```

The server listens on port `3000` by default. `PORT` and `HOST` can override the listener settings.

## Project structure

```text
src/
  clients/      IETT HTTP client and caches
  providers/    Google Maps and Apple Maps URL builders
  routing/      Geometry and waypoint selection
  services/     Route discovery and route-building workflow
  shared/       Errors and input validation
  app.js        Express routes
  index.js      Public library exports
  server.js     HTTP server entrypoint
```

Run the complete `256` discovery and selection example with:

```bash
npm run example
```

To demonstrate an already-on-the-bus origin, provide coordinates from the selected route:

```bash
CURRENT_LAT=40.99 CURRENT_LNG=29.13 npm run example
```

## Discover a line

```bash
curl http://localhost:3000/api/iett/lines/256/options
```

Discovery follows the IETT RouteDetail page. It constructs and validates the two standard codes, `<line>_G_D0` and `<line>_D_D0`, then uses `GetAllRoute` for additional or depar variants. No additional variant code is invented.

Routes are grouped by their actual first and last stop names. An empty `GetAllRoute` response is valid and still returns any validated standard directions.

## Build a Google Maps URL

```bash
curl -X POST http://localhost:3000/api/iett/routes/256_G_D0/google-maps \
  -H 'content-type: application/json' \
  -d '{"maxWaypoints":9,"debug":false}'
```

For a rider who is already on the bus, include the current location. The service keeps the exact coordinate as the origin and optimizes only the remaining route.

```bash
curl -X POST http://localhost:3000/api/iett/routes/256_G_D0/google-maps \
  -H 'content-type: application/json' \
  -d '{"currentLocation":{"lat":41.0,"lng":29.0}}'
```

Intermediate IETT stops are the first waypoint candidates. The service uses their exact coordinates and chooses the set that best constrains the complete stop corridor. Turn and geometry candidates are used only when waypoint capacity remains.

Google Maps directions URLs cannot force more intermediate locations than `maxWaypoints`. A route with more stops than that can be strongly constrained by representative stops, but every stop cannot be made an explicit waypoint in one URL.

## Build an Apple Maps URL

Apple Maps supports up to 13 intermediate waypoints in this service, allowing four more IETT stops to be constrained than the Google Maps output.

```bash
curl -X POST http://localhost:3000/api/iett/routes/256_G_D0/apple-maps \
  -H 'content-type: application/json' \
  -d '{"maxWaypoints":13,"debug":false}'
```

The response uses the unified Apple Maps URL format with repeated `waypoint` parameters. Current-location and debug options work the same way as the Google Maps endpoint.

## Start from a bus stop

Both map providers can start at a named stop. Matching ignores case and Turkish diacritics. Stops and route geometry before the selected station are removed from waypoint selection.

```bash
curl -X POST http://localhost:3000/api/iett/routes/256_D_D0/apple-maps \
  -H 'content-type: application/json' \
  -d '{"startStation":"KÖPRÜLÜ KAVŞAK"}'
```

The same body works with the `/google-maps` endpoint. `startStation` and `currentLocation` cannot be supplied together.

## Library use

```js
import {
  buildIettAppleMapsRoute,
  buildIettGoogleMapsRoute,
  getIettRouteOptions
} from "./src/index.js";

const options = await getIettRouteOptions("256");
const variants = options.directions.flatMap(direction => direction.variants);
const selected = variants.find(variant => variant.code === "256_G_D0");

if (selected) {
  const result = await buildIettGoogleMapsRoute(selected.code, {
    maxWaypoints: 9,
    debug: true
  });

  console.log(result.url);

  const appleResult = await buildIettAppleMapsRoute(selected.code);
  console.log(appleResult.url);
}
```
