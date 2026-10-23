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
- [Example](#example)
- [Discover line directions and variants](#discover-line-directions-and-variants)
- [Google Maps](#build-a-google-maps-url), [Apple Maps](#build-an-apple-maps-url),
  and [Yandex Maps](#build-a-yandex-maps-url) URLs
- [Select start and end stops](#select-start-and-end-stops)
- [Use your current location](#use-your-current-location)
- [Traffic-aware travel times](#travel-time)
- [Download a GPX track](#download-a-gpx-track)
- [Additional information](#additional-information)
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

Internal travel time calculation uses TomTom Orbis. Create a TomTom API key
and add to .env:
```
TOMTOM_API_KEY=xxxx
```

The map URL endpoints do not require this key, this is only required for travel times.

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
consecutive bus stops using TomTom traffic data.

**This endpoint requires a TomTom API key.**

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

- `departureTime` accepts `"now"` or an ISO 8601 date time. When the value has no time zone offset, TomTom interprets it in the origin's local time zone.
- `dwellTimeSeconds` defaults to `15` and accepts integers from `0` through `600`.
- The existing `currentLocation`, `startStation`, and `endStation` rules also apply.

With TomTom, the service starts with origin and destination only: bus stops are not forced
waypoints, and long stop gaps do not receive arbitrary 1 km anchors. The complete
selected IETT geometry is retained in `legs[].path`, which TomTom uses for route
reconstruction. This separates supporting geometry from mandatory routing locations.
See [TomTom Orbis v3 route reconstruction](https://docs.tomtom.com/routing-api/documentation/tomtom-orbis-maps/v3/calculate-route).

Geometry validation operates on the **whole selected section**, not on artificial
waypoint legs. It uses distance-weighted measurements in both directions and an
ordered, banded Frechet alignment to detect reversed travel, missing loops and
shortcuts that nearest-point measurements would conceal. Prepared spatial indexes
and successful geometry comparisons are reused.

| Geometry limit | Validated | Approximate |
|---|---:|---:|
| Origin/destination offset | 40 m | 40 m |
| P95 deviation, each direction | 35 m | 50 m |
| Maximum deviation, including ordered alignment | 80 m | 150 m |

Both classes must also satisfy: at most 8% outside the 35 m corridor, at most
400 m of continuous deviation, and length difference at most `max(75 m, 10%)`.
Direction, local distance progression and stop order are checked as well.
Approximate results retain the actual TomTom duration and report:

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
quality, maximum ordered deviation, and any local alternatives. Set `debug: true`
to get complete endpoint/length metrics, deviations, order mismatches and original
rejection reasons under `debug.geometryMatch`.

If the initial result is unacceptable, the service expands each deviation to
adjacent bus-stop boundaries and adds those stops as ordered waypoints. Only
affected legs omit `path`; the rest retain supporting geometry. A final repair
can add up to six controls around remaining turns. Controls remain at least 60 m
apart, with at most 150 waypoints and **three geometry attempts**. A worse repair
never replaces the closest candidate in error diagnostics.

If TomTom cannot reconstruct the initial trace at all, the next request uses
only waypoints selected by the existing map-export algorithm (at most 18),
without any `path` fields. Remaining deviations receive the final targeted
repair. There are no uniform dense anchors or requests for every stop pair.

Local alternatives have a separate acceptance contract; the standard geometry
limits above remain unchanged. Every stop must match in order within 50 m, and
provider legs must connect. Endpoint offsets must stay within 40 m, total length
within 10%, P95 within 50 m in both directions, ordered maximum deviation within
250 m, distance outside the 35 m corridor within 8% in each direction, and
continuous deviation within 800 m. Each alternative stop interval must be at
most 1,000 m, with returned length between 50% and 150% of the reference and an
absolute difference at most 500 m. Contiguous blocks outside the declared
alternative intervals must pass the original geometry validation.

Accepted local alternatives return `routingQuality: "tomtom-geometry-approximate"`
with warning `IETT_LOCAL_ROUTE_APPROXIMATION`. `geometryMatch.valid: true` means
the local acceptance contract passed, not that the original geometry matched.
`geometryMatch` includes:

- `acceptanceBasis: "stop-preserving-local-alternative"`
- `alternatives` with station indexes and measured reference/returned lengths
- `maximumStopOffsetMeters` and `orderedMaximumDeviationMeters`

The full `debug.geometryMatch` additionally retains `referenceGeometryValid: false`,
`referenceGeometryReasons`, reference route ranges and all whole-route metrics.
Warnings reference `geometryMatch.alternatives` without duplicating those intervals.
Public distances are rounded to one decimal place, with cumulative rounding keeping
segment distance totals consistent with the route total.

Unresolved mismatches still return `IETT_ROUTE_RECONSTRUCTION_FAILED`. Local
alternatives use actual TomTom durations; no new speed-based duration is invented.

The recorded 11T case is a bounded approximation and now finishes in one geometry
request. The recorded full and partial 256 cases finish in two requests. The
local waypoint alternative preserves all stops, while the approximately 841 m
FİNANS MERKEZİ–BEGONYA SOKAK reference interval becomes about 504 m in TomTom.
That difference is explicitly reported as a local approximation.

Successful matched paths and controls are cached for 24 hours, bounded to 128
sections. Concurrent departures share preparation; the first preparation request
also supplies that departure's duration. Later departures each get a separate
traffic query, using learned paths for matched legs and retaining waypoint-only
routing for alternative legs. Cached controls and leg strategies are validated
against the original IETT section on every departure. Cache keys include the source fingerprint, route/direction and selected
endpoints. IETT records refresh 24 hours after completion; changed source data
invalidates preparation. Exact departure-time results still expire after 60 seconds;
errors and maneuver estimates are not stored as learned road paths.

`createIettService({ geometryPolicy, shapeCacheTtlMs, shapeCacheMaxEntries, clock })`
configures matching and caching. `geometryPolicy` overrides the exported
`DEFAULT_GEOMETRY_POLICY`; for example `{ approximateMaxMeters: 120 }` tightens
standard geometry acceptance and validation outside local alternatives without
changing the endpoint request schema. Local alternatives use the separate fixed
bounds documented above.

### Shared TomTom request limits

Every default `TomTomClient` in this process shares a scheduler per API key,
including direct IETT calls, repairs and retries.
Default settings are `TOMTOM_REQUESTS_PER_SECOND=4` (at least 250 ms between starts)
and `TOMTOM_MAX_CONCURRENCY=4`. This leaves headroom under TomTom's documented default [5 Routing QPS](https://docs.tomtom.com/platform/documentation/api-best-practices/qps-limits).

Identical pending HTTP payloads are combined before queueing. HTTP 429 updates a
shared cooldown using numeric or HTTP-date `Retry-After`, halves the request rate
and permits recovery after 60 seconds without another 429. Timeouts, network errors,
HTTP 5xx and 429 can be retried **once per HTTP operation**, always through the same
queue. Authentication and reconstruction errors do not receive transport retries.
Cooldowns longer than 10 seconds fail promptly with an explicit rate-limit cause.
Thus a BUS calculation has at most three geometry attempts and up to six HTTP
attempts if each operation requires its single transport retry. A lingering 429
is never reclassified as a geometry failure.

The default scope is one Node process using this API key. Multiple processes must
share external coordination if added later. For controlled tests or custom limits,
inject one `createTomTomScheduler(...)` into all `TomTomClient({ scheduler })`
instances. The scheduler accepts clock, timer and randomness dependencies.

The response still contains one segment per adjacent bus stop. Driving times are
interpolated from TomTom's route `progressPoints`, rather than forcing a separate
route leg at every stop. Each segment and the root expose
`stopTimingSource: "tomtom-progress-interpolation"`. These stop-level values are
estimates; the provider leg's total driving time, traffic delay, and distance are
preserved. Actual intermediate bus-stop waits are added exactly once to the public
timeline, including stops that were omitted as waypoints. Within each sparse leg,
stop pauses do not trigger additional traffic queries.

If progress points are absent or invalid, allocation uses distance and reports
`stopTimingSource: "distance-interpolation"` with a
`STOP_TIMES_DISTANCE_INTERPOLATED` warning. This fallback does not invent a BUS
driving duration; it distributes the duration actually returned by TomTom.

With `debug: true`, `waypointStrategy`, `waypointAttempts`, `controlPoints`,
`omittedStopWaypointCount`, `upstreamRequestCount`, and
`maximumUpstreamRequestCount` explain the reduced routing constraints and cost.
`geometryAttemptCount` and `maximumGeometryAttemptCount` distinguish geometry work
from actual HTTP attempts, including transport retries. `waypointStrategy` is
`hybrid-local-adaptive`; each attempt reports its `strategy` (`reconstruction`,
`local-waypoints`, or `waypoints-only`), `learned` status, and waypoint/HTTP counts.

Some IETT routes contain bus-only turns which do not exist in TomTom's car road
graph. When a clearly identified turn of at most 75 metres becomes a large detour,
the service can keep the IETT geometry and estimate only that short maneuver.
Such a response has:

```json
{
  "routingQuality": "validated-with-iett-maneuver-estimate",
  "warnings": [
    {
      "code": "UNMAPPED_IETT_MANEUVER_ESTIMATED"
    }
  ]
}
```

Fully reconstructed responses use `routingQuality: "tomtom-geometry-validated"`.
Larger unexplained mismatches fail with `IETT_ROUTE_RECONSTRUCTION_FAILED` instead
of returning a misleading duration.

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

`liveTrafficDelaySeconds` is the extra delay TomTom reports from real-time traffic
information. A value of `0` does not mean that historical congestion was ignored.
Orbis v3 does not expose a separate no-traffic duration, so the API intentionally
does not return a derived `freeFlowDurationSeconds` value.

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
- TomTom's free allowance currently includes 20,000 Routing API requests per month;
check the [current TomTom pricing](https://docs.tomtom.com/pricing) before deployment.
- Accuracy repair may require more than one TomTom request. Identical successful
travel-time requests share a 60-second in-memory cache.
- Travel-time results are traffic-aware estimates, not an official IETT timetable
or vehicle telemetry.


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
