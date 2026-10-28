# IETT Route Export API

This Express.js service exports IETT (Istanbul public bus) routes to map providers like Google Maps, Apple Maps, and Yandex Maps using waypoints. These exported routes can be used to get travel time estimates for the bus. The service itself can also calculate travel times between individual bus stops and the total route travel time using live traffic data provided by TomTom Orbis.

### Features

- **Route discovery:** Find outbound and inbound directions, standard routes,
  and depar variants for an IETT bus line.
- **Map links:** Export bus routes to mapping providers using waypoints.
- **Stop selection:** Export the whole route or a section between desired stops.
- **Use your current location:** Use a current coordinate as the origin and generate
  directions for the remaining route.
- **Travel time estimates:** Calculate traffic-aware durations between stops,
  including configurable dwell time.
- **GPX export:** Download IETT route geometry as a GPX 1.1 track with bus stops
  as waypoints.
- **Trip history:** Collect daily IETT archives into PostgreSQL and query a line's
  history with typed fields, readable timestamps and cursor pagination.
- **Route statistics:** Analyze durations, arrivals by scheduled departure and
  weekday, departure deviations, headways and coverage from stored history.
- **JavaScript integration:** Call the route builders directly from another
  Node.js project.

### Data source

All IETT related data is fetched from IETT's public API.

Base URL:
```text
https://iett.istanbul/tr/RouteStation/
```

## Contents

- [Run and configuration](#run-and-configuration)
- [Historical trips](#historical-trips)
- [Route statistics](#route-statistics)
- [Example](#example)
- [Discover line directions and variants](#discover-line-directions-and-variants)
- [Google Maps](#build-a-google-maps-url), [Apple Maps](#build-an-apple-maps-url),
  and [Yandex Maps](#build-a-yandex-maps-url) URLs
- [Select start and end stops](#select-start-and-end-stops)
- [Use your current location](#use-your-current-location)
- [Traffic-aware travel times](#travel-time)
- [Download a GPX track](#download-a-gpx-track)
- [Debug mode](#debug-mode)
- [JavaScript library use](#library-use)

## Run and configuration

```bash
npm install
npm start
```

The server listens on port `3000` by default and is accessible on local network.

You can override the port with `PORT` or the bind address with `HOST`:

```bash
PORT=3000 HOST=0.0.0.0 npm start
```

Travel times use TomTom Orbis by default. The `travel-times` endpoint can also
select HERE Routing v8. Configure the keys you use in `.env`:
```
TOMTOM_API_KEY=xxxx
HERE_API_KEY=xxxx
```

Only the selected provider's key is required. Map URL endpoints do not require
these keys. HERE defaults to 2 requests/second, 2 concurrent requests and a
20-second timeout. `HERE_REQUESTS_PER_SECOND` and `HERE_MAX_CONCURRENCY` configure
its independent request queue.

## Historical trips

Configure `DATABASE_URL`, then migrate and queue the last 30 completed Istanbul
calendar days. Start the worker to process the durable PostgreSQL queue:

```bash
npm run db:migrate
npm run history:sync -- --days 30
npm run history:worker
```

The worker runs separately from the API. It catches up on startup, imports new
days at 04:00 Europe/Istanbul, and refreshes the last three days. Failed or empty
days become eligible again one hour after failure. A timer follows the earliest
`nextAttemptAt`, so retries do not wait for the next clock hour. If an import is
already running, the queue is checked between individual day imports; imports
never overlap. Changes outside the active range are picked up on the next cycle.
While idle, the database queue is checked at least once per minute. The 04:00
daily cycle is queued if the worker is busy.
Requests run sequentially with a default 1,000 ms delay after each response.
Previously collected data is retained indefinitely.

To retry a day manually without waiting for its `nextAttemptAt`:

```bash
cd ~/iett-route-exporter
npm run history:sync -- --from 2026-09-26 --to 2026-10-28
pm2 logs iett-history-worker --lines 50
```

`history:sync` now only queues work and returns immediately after the database
write, with `event: history.queued` and a `queued` day count. It does not fetch IETT
or wait for the ingestion lock. Keep the worker running; without a worker the
queue persists until one starts. Successful and currently running days are
skipped; `--force` re-fetches successful days and queues another pass if a day is
already running. Existing records are preserved. A request made during an import
cannot be overwritten by completion of that older import.

For a foreground import that waits for every selected day, use `--wait`:

```bash
pm2 stop iett-history-worker
npm run history:sync -- --from 2026-09-28 --to 2026-09-28 --wait
pm2 start iett-history-worker
```

## Route statistics

Open the  page at **[localhost:3000/statistics](http://localhost:3000/statistics)**.
Enter a line number to load its directions and variants, or enter an exact route
code manually. A selected route can also be opened directly:

```text
http://localhost:3000/routes/256_D_D0/statistics?departure_time=07:35
```
The underlying JSON endpoint remains available:

```bash
curl 'http://localhost:3000/api/iett/routes/256_D_D0/statistics'
curl 'http://localhost:3000/api/iett/routes/256_D_D0/statistics?departure_time=07:55'
curl 'http://localhost:3000/api/iett/routes/256_D_D0/statistics?departure_time=07:35&weekday=1'
```

## Example

Run route discovery and URL generation for IETT line `256`:

```bash
npm run example
```

## Discover line directions and variants

```bash
curl http://localhost:3000/api/iett/lines/<LINE_CODE>/
```

### Sample output

```json
{
    "line": "256",
    "directions": [
        {
            "id": "YEDITEPE_UNIVERSITESI_KAMPUSU__GUMUSSUYU_PERON",
            "label": "YEDİTEPE ÜNİVERSİTESİ KAMPÜSÜ - GÜMÜŞSUYU PERON",
            "start": "YEDİTEPE ÜNİVERSİTESİ KAMPÜSÜ",
            "end": "GÜMÜŞSUYU PERON",
            "variants": [
                {
                    "code": "256_G_D0",
                    "type": "base",
                    "name": "Normal Düzergah",
                    "rawName": null,
                    "start": "YEDİTEPE ÜNİVERSİTESİ KAMPÜSÜ",
                    "end": "GÜMÜŞSUYU PERON",
                    "stops": [
                        {
                            "name": "YEDİTEPE ÜNİVERSİTESİ KAMPÜSÜ",
                            "coordinate": {
                                "lat": 40.9745340005498,
                                "lng": 29.1539319999923
                            }
                        },
                        ...
                    ]
                }
            ]
        },
        {
            "id": "GUMUSSUYU_PERON__YEDITEPE_UNIVERSITESI_KAMPUSU",
            "label": "GÜMÜŞSUYU PERON - YEDİTEPE ÜNİVERSİTESİ KAMPÜSÜ",
            "start": "GÜMÜŞSUYU PERON",
            "end": "YEDİTEPE ÜNİVERSİTESİ KAMPÜSÜ",
            "variants": [
                {
                    "code": "256_D_D0",
                    "type": "base",
                    "name": "Normal Düzergah",
                    "rawName": null,
                    "start": "GÜMÜŞSUYU PERON",
                    "end": "YEDİTEPE ÜNİVERSİTESİ KAMPÜSÜ",
                    "stops": [
                        {
                            "name": "GÜMÜŞSUYU PERON",
                            "coordinate": {
                                "lat": 41.0391480005601,
                                "lng": 28.9888429999892
                            }
                        },
                        ...
                    ]
                }
            ]
        }
    ],
    "warnings": []
}
```

The service constructs and validates the two standard route codes, `<line>_G_D0` and `<line>_D_D0`, then uses the IETT API endpoint `GetAllRoute` to discover additional or depar variants.


## Build a Google Maps URL

Google Maps links support up to 9 intermediate waypoints.

```bash
curl -X POST http://localhost:3000/api/iett/routes/256_G_D0/google-maps \
  -H 'content-type: application/json' \
  -d '{"maxWaypoints":9,"debug":false}'
```

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

Apple Maps links support up to 13 intermediate waypoints.

```bash
curl -X POST http://localhost:3000/api/iett/routes/256_G_D0/apple-maps \
  -H 'content-type: application/json' \
  -d '{"maxWaypoints":13,"debug":false}'
```

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

## Build a Yandex Maps URL

Google Maps links support up to 18 intermediate waypoints.

```bash
curl -X POST http://localhost:3000/api/iett/routes/256_G_D0/yandex-maps \
  -H 'content-type: application/json' \
  -d '{"maxWaypoints":18,"debug":false}'
```

### Sample output

```json
{
  "routeCode": "256_G_D0",
  "provider": "yandex-maps",
  "origin": {
    "lat": 40.9745340005498,
    "lng": 29.1539319999923
  },
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
  "stationWaypointCount": 18,
  "url": "https://yandex.com/maps/?mode=routes&rtext=40.9745340005498%2C29.1539319999923%7E...&rtt=auto"
}
```

## Select start and end stops

When start/end stations are provided, the route between these stops provided will be exported.

### Sample response with start station
```bash
curl -X POST http://localhost:3000/api/iett/routes/256_D_D0/apple-maps \
  -H 'content-type: application/json' \
  -d '{"startStation":"KÖPRÜLÜ KAVŞAK"}'
```

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
End stop can also be added to body. Example body:
```json
{"startStation":"KÖPRÜLÜ KAVŞAK", "endStation":"ATAŞEHİR"}
```

- If no start stop provided, initial stop is used. 
- If no end stop provided, last stop is used.

## Use your current location

When `currentLocation` is provided, its coordinate is used to remove the
already-traveled route section and optimize only the remaining waypoints.

```bash
curl -X POST http://localhost:3000/api/iett/routes/256_G_D0/google-maps \
  -H 'content-type: application/json' \
  -d '{"currentLocation":{"lat":41.0,"lng":29.0}}'
```

To demonstrate this behavior with the example script, provide coordinates from the selected route:

```bash
CURRENT_LAT=40.99 CURRENT_LNG=29.13 npm run example
```

## Travel time

This endpoint returns the total trip estimate and one segment for every pair of
consecutive bus stops using the selected provider's traffic data.

**This endpoint requires the selected provider's API key.**

```bash
curl -X POST http://localhost:3000/api/iett/routes/256_D_D0/travel-times \
  -H 'content-type: application/json' \
  -d '{
    "startStation":"GÜMÜŞSUYU PERON",
    "endStation":"KÖPRÜLÜ KAVŞAK",
    "departureTime":"now",
    "dwellTimeSeconds":15,
    "debug":false
  }'
```

- `provider` accepts exactly `"tomtom"` (default) or `"here"`. Other values return
  `400 INVALID_PROVIDER` before upstream calls. Response provider IDs remain
  `"tomtom-orbis"` for TomTom and `"here"` for HERE.
- `departureTime` accepts `"now"` or an ISO 8601 date time. An omitted offset
  uses the origin's local time; HERE resolves these IETT times in Istanbul.
- `dwellTimeSeconds` defaults to `15` and accepts integers from `0` through `600`.
- The existing `currentLocation`, `startStation`, and `endStation` rules also apply.

With TomTom, the service starts with origin and destination only: bus stops are not forced
waypoints, and long stop gaps do not receive arbitrary 1 km anchors. The complete
selected IETT geometry is retained in `legs[].path`, which TomTom uses for route
reconstruction. This separates supporting geometry from mandatory routing locations.
See [TomTom Orbis v3 route reconstruction](https://docs.tomtom.com/routing-api/documentation/tomtom-orbis-maps/v3/calculate-route).

Geometry validation operates on the **whole selected section**. It uses distance weighted measurements in both directions and an
ordered, banded Frechet alignment to detect reversed travel, missing loops and
shortcuts that nearest point measurements would conceal. Prepared spatial indexes
and successful geometry comparisons are reused.

| Geometry limit | Validated | Approximate |
|---|---:|---:|
| Origin/destination offset | 40 m | 40 m |
| P95 deviation, each direction | 35 m | 50 m |
| Maximum deviation, including ordered alignment | 80 m | 150 m |

```json
{
  "routingQuality": "tomtom-geometry-approximate",
  "geometryMatch": {
    "valid": true,
    "quality": "approximate",
    "orderedMaximumDeviationMeters": 103.8
  },
  "warnings": [{ "code": "IETT_GEOMETRY_APPROXIMATION" }]
}
```

Normal responses include a compact `geometryMatch` summary with acceptance,
quality and maximum ordered deviation. Set `debug: true`
to get complete endpoint/length metrics, deviations, order mismatches and original
rejection reasons under `debug.geometryMatch`. 

### Shared TomTom request limits

Every default `TomTomClient` in this process shares a scheduler per API key.
Default settings are `TOMTOM_REQUESTS_PER_SECOND=4` (at least 250 ms between starts)
and `TOMTOM_MAX_CONCURRENCY=4`. Journey calculation concurrency remains a separate
setting. This leaves headroom under TomTom's documented default [5 Routing QPS](https://docs.tomtom.com/platform/documentation/api-best-practices/qps-limits).


### Sample output

```json
{
  "routeCode": "256_D_D0",
  "provider": "tomtom-orbis",
  "requestedTrafficMode": "live",
  "trafficTimeContext": "scheduled",
  "trafficDataBasis": "historical",
  "routingQuality": "tomtom-geometry-validated",
  "generatedAt": "2026-10-04T09:00:00.000Z",
  "origin": {
    "type": "station",
    "name": "GÜMÜŞSUYU PERON",
    "stationIndex": 0,
    "lat": 41.039148,
    "lng": 28.988843
  },
  "destination": {
    "type": "station",
    "name": "KÖPRÜLÜ KAVŞAK",
    "stationIndex": 11,
    "lat": 41.066327,
    "lng": 29.011603
  },
  "startDistanceAlongRoute": 0,
  "endDistanceAlongRoute": 4862,
  "iettGeometryLengthMeters": 4862,
  "total": {
    "distanceMeters": 4920,
    "drivingDurationSeconds": 980,
    "dwellDurationSeconds": 150,
    "liveTrafficDelaySeconds": 220,
    "estimatedDurationSeconds": 1130,
    "departureTime": "2026-10-04T09:00:00Z",
    "arrivalTime": "2026-10-04T09:18:50Z"
  },
  "segments": [
    {
      "index": 0,
      "from": {
        "type": "station",
        "name": "GÜMÜŞSUYU PERON",
        "stationIndex": 0,
        "lat": 41.039148,
        "lng": 28.988843
      },
      "to": {
        "type": "station",
        "name": "DOLMABAHÇE GAZHANE CADDESİ",
        "stationIndex": 1,
        "lat": 41.041,
        "lng": 28.991
      },
      "distanceMeters": 430,
      "drivingDurationSeconds": 82,
      "liveTrafficDelaySeconds": 17,
      "dwellAfterArrivalSeconds": 15,
      "elapsedUntilNextDepartureSeconds": 97,
      "departureTime": "2026-10-04T09:00:00Z",
      "arrivalTime": "2026-10-04T09:01:22Z"
    }
  ]
}
```

`requestedTrafficMode` is the mode sent to TomTom, not a claim that future
traffic is already known. Requests with `departureTime: "now"` use
`trafficTimeContext: "immediate"` and `trafficDataBasis: "live"`. Requests for a
scheduled time use `trafficTimeContext: "scheduled"` and
`trafficDataBasis: "historical"`.

### HERE travel times

```bash
curl -X POST http://localhost:3000/api/iett/routes/19_D_D0/travel-times \
  -H 'content-type: application/json' \
  -d '{
    "provider":"here",
    "startStation":"UZUNÇAYIR METROBÜS",
    "endStation":"YEDİTEPE ÜNİVERSİTESİ KAMPÜSÜ",
    "departureTime":"2026-10-21T08:06:00+03:00",
    "dwellTimeSeconds":15,
    "debug":true
  }'
```

## Download a GPX track

You can download the official IETT geometry as a GPX 1.1 file using this endpoint:

```bash
curl -OJ http://localhost:3000/api/iett/routes/256_D_D0/gpx
```

This file contains the complete route line as a track and the IETT stations as GPX
waypoints.

## Additional information
- Since the number of waypoints allowed by map providers is limited, **exported routes may not perfectly match the original IETT route**. The algorithm tries to achieve the highest accuracy within these limitations.
- When the same stop name appears more than once on a route, discovery adds an
internal suffix such as `UZUNÇAYIR METROBÜS (1)` and
`UZUNÇAYIR METROBÜS (2)`. Use that numbered name as `startStation` or
`endStation`.
- `startStation` and `currentLocation` cannot be supplied together.

## Debug mode

Set `debug` to `true` to include waypoint candidates, component scores, selection status, adaptive spacing, and route deviation metrics.

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
  buildIettYandexMapsRoute,
  buildIettGpx,
  calculateIettRouteTimes,
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

  const yandexResult = await buildIettYandexMapsRoute(selected.code, {
    maxWaypoints: 18
  });

  console.log(yandexResult.url);

  const travelTimes = await calculateIettRouteTimes(selected.code, {
    departureTime: "now",
    dwellTimeSeconds: 15
  });

  console.log(travelTimes.total);

  const gpx = await buildIettGpx(selected.code);
  console.log(gpx.gpx);
}
```
