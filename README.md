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
- **Journey comparison:** Evaluate walking, metro, metrobus, bus, and school-ring
  alternatives against an arrival deadline, with departure advice and step timelines.
- **Single-journey calculation:** Calculate a chosen route forward from a selected
  step and departure time, including traffic estimates and timetable waits.
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
- [Compare journeys and choose when to leave](#compare-journeys)
- [Calculate one journey from a selected step](#calculate-one-journey)
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
rejection reasons under `debug.geometryMatch`. The compact summary and warnings are
included in BUS steps in both journey endpoints. Bounded approximations remain
eligible for the weighted-score recommendation in `evaluate`.

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
including direct IETT calls, both journey endpoints, RING, repairs and retries.
Default settings are `TOMTOM_REQUESTS_PER_SECOND=4` (at least 250 ms between starts)
and `TOMTOM_MAX_CONCURRENCY=4`. Journey calculation concurrency remains a separate
setting. This leaves headroom under TomTom's documented default [5 Routing QPS](https://docs.tomtom.com/platform/documentation/api-best-practices/qps-limits).

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

## Compare journeys

`POST /api/journeys/evaluate` evaluates your supplied alternatives using an
earliest home departure, a latest arrival, or both. It recommends the highest-scoring
eligible candidate, balancing later home departure, shorter total journey time and
fewer transfers. Arrival and departure bounds are hard eligibility constraints;
a high score cannot override them. Without `arrivalTime`, no implicit arrival
cutoff or tolerance window is added.
It calls the existing travel-time functions directly; there are no HTTP calls
from this endpoint back to the application's own API.

```bash
curl -X POST http://localhost:3000/api/journeys/evaluate \
  -H 'content-type: application/json' \
  -d '{
    "arrivalTime": "09:00",
    "boardingBufferMinutes": 0,
    "arrivalBufferMinutes": 0,
    "routes": {
      "MBUS-19": {
        "1": { "type": "WALK", "duration": 15 },
        "2": { "type": "MBUS", "duration": "13" },
        "3": {
          "type": "BUS",
          "route": "19_D_D0",
          "line": "19",
          "startStation": "UZUNÇAYIR METROBÜS",
          "endStation": "YEDİTEPE ÜNİVERSİTESİ KAMPÜSÜ",
          "departures": ["07.48", "08.05", "08.22"]
        }
      }
    }
  }'
```

### Input and time rules

| Field | Meaning |
| --- | --- |
| `routes` | Required, non-empty object keyed by your journey names. Each journey contains positive numbered step keys, sorted numerically. |
| `scoring` | Optional `{ "weights": { "lateDeparture": 1, "duration": 1, "transfers": 15 } }`. Partial overrides are supported; see scoring below. |
| `arrivalTime` | Optional latest arrival, for example `"09:00"` or `"2026-10-19T09:00:00+03:00"`. At least one of `arrivalTime` / `departureTime` is required. |
| `departureTime` | Optional earliest time you can leave home, for example `"07:00"` or `"2026-10-19T07:00:00+03:00"`. This is distinct from an individual vehicle's departure. |
| `date` | Optional `YYYY-MM-DD` default date for clock-only values. Without it, use the Istanbul date from a dated `departureTime`, then a dated `arrivalTime`, otherwise today. |
| `boardingBufferMinutes` | Minutes to reach the boarding point before **each** scheduled BUS/RING departure; default `0`. |
| `arrivalBufferMinutes` | Minutes to subtract from the arrival deadline; default `0`. |

Input `duration` values are minutes; numeric strings are accepted. Durations and
buffers must be non-negative and at most one year. Returned durations are seconds.
Both request boundaries and individual vehicle departures accept `"8.15"`,
`"08.15"`, `"08:15"`, or an ISO date-time such as
`"2026-10-19T08:15:00+03:00"`. ISO timestamps can include seconds and milliseconds.
An ISO value without an offset, such as `"2026-10-19T08:15"`, is interpreted in
`Europe/Istanbul`; `Z` and other offsets are converted to Istanbul time.
Explicit dates in timestamps are always retained, while `date` only supplies a
default for clock-only values. The server's local time zone is never used.

For scheduled steps, a single `departure`, single `departureTime`, or a
`departures` array can be supplied; their values are merged, sorted, and
deduplicated by instant. Equal clock times on different dates remain distinct.
Clock-only departures belong to the inferred or explicit `date`; departures
are never automatically moved to tomorrow. Calculated home departures and
arrivals may cross midnight. All response timestamps include the Istanbul offset.

For example, to compare tomorrow's journeys today, send the same `routes` with:

```json
{
  "departureTime": "2026-10-19T07:00:00+03:00",
  "arrivalTime": "2026-10-19T09:00:00+03:00",
  "routes": {
    "MBUS-19": {
      "1": { "type": "WALK", "duration": 15 },
      "2": { "type": "MBUS", "duration": 13 },
      "3": { "type": "BUS", "route": "19_D_D0", "startStation": "UZUNÇAYIR METROBÜS", "endStation": "YEDİTEPE ÜNİVERSİTESİ KAMPÜSÜ", "departures": ["07.48", "08.05", "08.22"] }
    }
  }
}
```

The vehicle times in this example are evaluated on October 19. You can also
provide only `departureTime`, with no arrival deadline:

```json
{
  "departureTime": "2026-10-19T08:50:00+03:00",
  "routes": { "walk": { "1": { "type": "WALK", "duration": 15 } } }
}
```

This fixed-duration journey starts at 08:50 and arrives at 09:05. For scheduled
vehicles, the engine may suggest leaving later than `departureTime`, as long as
the vehicle remains reachable; it avoids adding unnecessary waiting at the first
stop. To express a window crossing midnight, include dates on both boundaries
and on any vehicle departures belonging to another date. A departure boundary
later than the arrival boundary returns `400 INVALID_TIME_WINDOW`.

BUS times are departures **from the specified `startStation`**, not from the
line's first stop. The final step's endpoint is the arrival destination. Add a
final WALK step if you need time from the last stop to your actual destination.

| Type | Duration calculation |
| --- | --- |
| `WALK`, `METRO`, `MBUS` | Use your measured `duration` unchanged, without any routing call or extra service-frequency estimate. |
| `BUS` | Requires `route`, `startStation`, `endStation`, and departure(s). Every distinct departure gets its own traffic-aware estimate, including the existing service's 20-second intermediate-stop dwell allowance. Dwell is not added again. `line` is an optional display label. |
| `RING` | Requires departure(s). Estimates driving time from İçerenköy metro (`40.979940, 29.128038`) to Yeditepe University (`40.974683, 29.153881`) at that departure. Optional `duration` is used only if routing fails. |
| `BUS_OPTIONS` | Expands its `options` object into independent branches. Options can themselves contain `BUS_OPTIONS`. |
| `WAIT` | Output-only step generated for timetable waits and boarding buffers. |

For example, a final alternative step can be:

```json
{
  "6": {
    "type": "BUS_OPTIONS",
    "options": {
      "": {},
      "RING": { "type": "RING", "duration": 15, "departures": ["8.15", "8.30", "8.40", "8.45"] },
      "19": { "type": "BUS", "route": "19_D_D0", "startStation": "ATAŞEHİR 100.YIL CUMHURİYET ANADOLU LİSESİ", "endStation": "YEDİTEPE ÜNİVERSİTESİ KAMPÜSÜ", "departures": [] }
    }
  }
}
```

BUS and RING traffic estimates require `TOMTOM_API_KEY`. If RING cannot be routed,
including when the provider is unavailable or unconfigured, its supplied duration
is returned with `durationSource: "fixed-fallback"` and a
`RING_FIXED_DURATION_FALLBACK` warning containing the failure code/message. Without a
fallback, that candidate has an error. BUS failures do not use invented durations.

### Results and recommendation

Both journey endpoints return the same compact, English, LLM-friendly envelope:

- `date`: reference date (`YYYY-MM-DD`).
- `timezone`: always `Europe/Istanbul`.
- `recommendedOptionId`: the selected option's short ID, or `null` if none qualifies.
- `options`: every evaluated departure/branch, including failures.

Each option contains `id`, `route`, `departure`, `arrival`, `durationMinutes`,
`transfers`, `status`, and `steps`. Route names are readable, such as
`"Metrobus + M4 + M8 + Bus 19"`; walking and waiting remain in the steps but are
excluded from vehicle route titles. Walking-only routes are named `"Walk"`.
Each step contains `transport`, `departure`, `arrival`, `durationMinutes`, and
`from`/`to` when station names are available. Station names retain their original
spelling. Missing times and durations are `null`; stops are never invented.

Times use `HH:mm` in Istanbul. If any part of an option falls outside the root
`date`, **all times in that option** use full ISO date-times with Istanbul offsets.
This covers midnight crossings, previous-day walking prefixes, and explicitly
dated later departures. Durations use minutes rounded to the nearest whole minute;
the planner's calculations and selection retain their original precision.

Optional `notes` contain plain English warnings and exclusion reasons, including
fixed shuttle durations and approximate bus road matching. Repeated notes are
removed. All options remain present. A failed option without usable step details
has route `"Unavailable route"` rather than an invented route description.

This is a **breaking HTTP response change**: use
`options.find(option => option.id === recommendedOptionId)`. IDs are short strings
(`"1"`, `"2"`, etc.) scoped to the current response, not persistent route IDs.
`bestOptionId`, `generatedAt`, scoring details, internal identifiers, raw type/status
codes, durations in seconds and provider diagnostics are omitted. Direct JavaScript
service calls retain their detailed result. Requests and selection rules are
unchanged; `/api/iett` is unchanged.

The following **abridged illustrative response** assumes the 07:48 bus takes
40 minutes, 08:05 takes 35 minutes, and 08:22 takes 45 minutes. With a 09:00
deadline, 08:05 wins on score; 08:22 is late. Every option has its full steps in the
actual response; only the recommended option's steps are shown here.

```json
{
  "date": "2026-10-19",
  "timezone": "Europe/Istanbul",
  "recommendedOptionId": "1",
  "options": [
    {
      "id": "1",
      "route": "Metrobus + Bus 19",
      "departure": "07:37",
      "arrival": "08:40",
      "durationMinutes": 63,
      "transfers": 1,
      "status": "Suitable",
      "steps": [
        {
          "transport": "Walk",
          "departure": "07:37",
          "arrival": "07:52",
          "durationMinutes": 15
        },
        {
          "transport": "Metrobus",
          "departure": "07:52",
          "arrival": "08:05",
          "durationMinutes": 13
        },
        {
          "transport": "Bus 19",
          "from": "UZUNÇAYIR METROBÜS",
          "to": "YEDİTEPE ÜNİVERSİTESİ KAMPÜSÜ",
          "departure": "08:05",
          "arrival": "08:40",
          "durationMinutes": 35
        }
      ]
    },
    {
      "id": "2",
      "route": "Metrobus + Bus 19",
      "departure": "07:20",
      "arrival": "08:28",
      "durationMinutes": 68,
      "transfers": 1,
      "status": "Suitable"
    },
    {
      "id": "3",
      "route": "Metrobus + Bus 19",
      "departure": "07:54",
      "arrival": "09:07",
      "durationMinutes": 73,
      "transfers": 1,
      "status": "Misses the arrival deadline",
      "notes": [
        "Estimated arrival exceeds the arrival deadline or its safety buffer."
      ]
    }
  ]
}
```

Only candidates with all connections reachable, home departure at or after the
requested `departureTime` (when supplied), arrival at or before
`effectiveArrivalTime` (when supplied), and a home departure that has not passed
when processing finishes are eligible. In both modes (`"arrive-by"` and
`"depart-after"`), eligible candidates use weighted utility scoring:

```text
score = lateDepartureMinutes * lateDeparture
      - durationMinutes * duration
      - transferCount * transfers
```

| Weight | Default | Meaning |
|---|---:|---|
| `lateDeparture` | `1` | Points gained per minute of later **home** departure. |
| `duration` | `1` | Points deducted per minute of the whole journey, including walking and WAIT steps. |
| `transfers` | `15` | Points deducted per additional vehicle boarding (`transferCount`). |

`lateDepartureMinutes` is measured relative to the earliest home departure among
**all eligible candidates across all groups**. Adding an earlier candidate can shift
all scores by the same amount, but cannot change existing pairwise score differences.
There is no min-max normalization. Higher is better; negative scores are valid.
At default weights, 10 minutes of later departure balances 10 minutes of additional
travel, and one transfer costs as much as 15 minutes of travel.

Override weights per request, for example to prioritize short journeys:

```json
{
  "arrivalTime": "09:00",
  "scoring": { "weights": { "duration": 2 } },
  "routes": {
    "walk": { "1": { "type": "WALK", "duration": 15 } }
  }
}
```

Unspecified weights use their defaults; explicit zero disables that criterion.
Weights must be finite JSON numbers from 0 through 1000, with at least one positive
weight. Unknown scoring fields/weight names or malformed values return
`400 INVALID_SCORING` before any routing provider is called. `DEFAULT_SCORING_WEIGHTS`
is exported for direct JavaScript consumers. Weights are coefficients in the units
above, not percentages that must add up to 100.

Scoring uses unrounded second-based values. Exact score ties prefer earliest
final arrival, then shortest total duration, then fewest transfers, then internal
candidate ID. The HTTP list puts eligible candidates in global score order;
ineligible candidates follow in their existing relative order. The selected
option is referenced by `recommendedOptionId`; scores are not exposed in the
compact HTTP result. Direct JavaScript results retain `score`, `rank`,
`scoreBreakdown`, and root `scoring` diagnostics.

Every supplied departure combination is evaluated, including later connections,
WAIT steps and final walking. Scoring applies **only to evaluate**; `calculate`
chooses the earliest complete arrival across step alternatives. Without an arrival
deadline, a much later service can win on score.

The home departure is calculated backward from the first scheduled vehicle. Later
connections are checked forward, with explicit WAIT steps. Pure fixed-duration
journeys start at `departureTime` whenever it is supplied, even with an arrival
deadline. When only an arrival deadline is supplied, fixed-duration journeys are
calculated backward from that deadline. Gaps within
your measured METRO/MBUS durations are not expanded into extra WAIT steps.

| HTTP status | Meaning |
| --- | --- |
| `Suitable` | Eligible for recommendation. |
| `Misses the arrival deadline` | Exceeds the deadline or requested arrival buffer. |
| `Requires leaving before your earliest allowed departure` | Starts before the requested departure bound. |
| `Required departure time has passed` | The required home departure has passed. |
| `Connection cannot be reached` | A subsequent vehicle cannot be reached with the boarding buffer. |
| `Not evaluated` | Empty option or explicitly empty departure list. |
| `Could not be calculated` | Invalid journey fields, unresolved stop, or provider failure. |

Unreachable steps have `departure`/`arrival: null`, retaining durations where
available. Incomplete journeys have no complete arrival or total duration.
`notes` explain exclusion reasons. When nothing qualifies, `recommendedOptionId`
is `null`; all alternatives remain available with HTTP `200`.
Malformed top-level requests return `400`. Errors within a route, branch, or
departure do not abort unrelated alternatives. Stop names are not spell-corrected:
for example, `KÖPRÜŞÜ KAVŞAK` fails while `KÖPRÜLÜ KAVŞAK` is the actual stop name.

The existing JSON body limit is 16 KB. More than 500 expanded candidates returns
`400 TOO_MANY_CANDIDATES` before any provider call. Independent journeys and their
scheduled steps are evaluated concurrently. By default, up to eight provider
calls run at once per planner instance, including across simultaneous requests.
Configure `JOURNEY_MAX_CONCURRENCY` (1–32) in the environment, or pass
`maxConcurrency` to `createJourneyService`. Matching provider calls are combined
before entering the queue, including calls shared by simultaneous `evaluate`
and `calculate` requests, so duplicate work does not occupy extra slots.
BUS uses the existing shared cache and reuses departure-independent route geometry,
stop matching, and section preparation. Updated IETT records invalidate that
preparation. Successful road matching is also shared for 24 hours and every returned
path is checked against the original source section. Each departure still receives its own traffic estimate; no time
approximation or candidate pruning is used. Successful RING driving estimates are cached for 60 seconds from completion
by coordinates and departure instant. Errors/fallback results are retried on the
next evaluation rather than cached as successes.

### Direct JavaScript use and custom types

```js
import { evaluateJourneys, createJourneyService, StepType } from "./src/index.js";

const input = {
  arrivalTime: "09:00",
  routes: { walk: { "1": { type: StepType.WALK, duration: 15 } } }
};

const result = await evaluateJourneys(input);
console.log(result.bestOption?.homeDepartureTime);

const planner = createJourneyService({
  calculateBusTimes: async (routeCode, options) => yourBusCalculator(routeCode, options),
  calculateDrivingTimes: async options => yourDrivingCalculator(options),
  clock: Date.now,
  maxConcurrency: 8
});
```

BUS calculators return the existing travel-time response with
`total.estimatedDurationSeconds`; driving calculators return `{ durationSeconds,
provider?, trafficDelaySeconds?, warnings? }`. Supply `ringRoute: { origin,
destination }` to configure the RING coordinates when constructing a planner.

Register extra types through `stepHandlers: { TYPE_NAME: handler }`:

| Handler member | Contract |
| --- | --- |
| `scheduled` | Whether this type requires departure(s) and anchors its timeline to them. |
| `dynamic` | Set `false` for a local calculation; otherwise the task uses the shared concurrency limit. |
| `concurrency` | Defaults to `"estimate"`. Set `"provider"` if the handler delegates to the context's BUS/driving calculators; those calls already acquire the shared limit. This avoids acquiring a second slot while holding the first. |
| `vehicle` | Whether this step counts toward vehicle changes. |
| `normalize(rawStep)` | Validate input and return normalized fields; throw `AppError` for a readable candidate error. |
| `estimate(step, context)` | Return/resolve `{ durationSeconds, durationSource, ...details }`. Scheduled steps contain `departureTime`; context provides deduplicated `calculateBusTimes` and `calculateDrivingTimes`. |

`BUS_OPTIONS` and output-only `WAIT` are reserved. Input normalization, type
handlers, timeline construction, ranking, and provider access are separate
modules, so additional transport types do not require changes to the engine.

## Calculate one journey

`POST /api/journeys/calculate` accepts **one** chosen route and calculates its
remaining timeline forward from a departure time and optional starting step.
When a step contains alternatives, all its options are calculated and the
complete journey with the earliest final arrival is selected. Its timeline is
returned at the top level, and `options` contains all the individual results.
Use `evaluate` to compare complete alternatives; use `calculate` to follow one
route, including its step alternatives. Both call the same underlying traffic
calculators directly.

```bash
curl -X POST http://localhost:3000/api/journeys/calculate \
  -H 'content-type: application/json' \
  -d '{
    "routeId": "MBUS-19",
    "startStep": 2,
    "departureTime": "2026-10-19T07:50:00+03:00",
    "route": {
      "1": { "type": "WALK", "duration": 15 },
      "2": { "type": "MBUS", "duration": 13 },
      "3": {
        "type": "BUS", "route": "19_D_D0", "line": "19",
        "startStation": "UZUNÇAYIR METROBÜS",
        "endStation": "YEDİTEPE ÜNİVERSİTESİ KAMPÜSÜ",
        "departures": ["07.48", "08.05", "08.22"]
      }
    }
  }'
```

| Field | Meaning |
| --- | --- |
| `route` | Required object containing one route's numbered steps directly, as in the example. |
| `routeId` | Optional internal label retained in direct JavaScript results; omitted from compact HTTP responses. |
| `startStep` | Optional original step key, e.g. `2` or `"2"`; defaults to the first actual key. The selected step is included in full. |
| `departureTime` | Exact time to start the selected step. Accepts clock times, ISO date-times, or `"now"`; defaults to now. |
| `date` | Optional default date for clock-only times. Otherwise inferred from the dated departure or today's Istanbul date. Explicit dates in timestamps are retained. |
| `boardingBufferMinutes` | Required time before each supplied scheduled departure; default `0`. |

`arrivalTime`, `arrivalBufferMinutes`, `routes`, `startSteps`, and the former
`optionSelections` field are not accepted
in this request. Each response option's `arrival` is the **calculated arrival**, not
an input deadline. Date-time formats and Istanbul time-zone handling match
`evaluate`, so a dated `departureTime` can be used to calculate tomorrow's trip.

The engine starts exactly at `departureTime` and includes each remaining step:

- WALK, METRO, and MBUS use your measured durations unchanged.
- A BUS/RING with a timetable uses the first departure at or after the current
  step's ready time plus its boarding buffer. WAIT steps include the gap to that
  departure. Only the chosen departure gets a traffic calculation; later services
  are not compared to optimize the trip.
- A BUS/RING with no `departure`, `departureTime`, or `departures` field gets its
  traffic estimate directly at the time that step is reached. No timetable wait
  or boarding buffer is added in this case.
- An explicitly empty `departures: []` means there is no available service.
- RING uses the same coordinates and fixed-duration fallback as `evaluate`.

Completed steps before `startStep` are excluded before normalizing their contents
or making provider calls. They add no duration, waits, transfers, or timetable
combinations. Original step keys are used internally for selection. A route with keys `"1"`, `"2"`,
and `"10"` can start at `10`; selectors refer to keys rather than list positions.

For BUS_OPTIONS, every alternative is calculated from the same ready time and
the remaining journey is calculated separately for each branch. With multiple
or nested option steps, all combinations are returned. Every branch follows the
normal first-reachable-departure rule within its own timetable.

The endpoint uses the same `date`, `timezone`, `recommendedOptionId`, and `options`
envelope as `evaluate`. Even a route without alternatives returns one option with
ID `"1"`. Departure refers to the start of the selected portion of the journey;
steps before `startStep` are excluded. Ranking uses **final arrival at the route's
destination**, then shorter duration, fewer vehicle changes, and a stable internal
ID. `Calculated` means a complete timeline was computed; past departures are not
filtered out by this endpoint.

Empty alternatives have status `"Not evaluated"`. A malformed alternative or
failed estimate affects only that branch. If none completes, `recommendedOptionId`
is `null`; unsuccessful options retain their notes and partial steps.

Up to 500 option combinations are allowed; larger requests return
`400 TOO_MANY_OPTIONS` before provider calls. Shared prefixes and equivalent
provider calculations are deduplicated across branches, and dynamic work shares
the service's configurable concurrency limit (eight calls by default).

Assuming the 08:05 bus takes 35 minutes, this is an illustrative result:

```json
{
  "date": "2026-10-19",
  "timezone": "Europe/Istanbul",
  "recommendedOptionId": "1",
  "options": [
    {
      "id": "1",
      "route": "Metrobus + Bus 19",
      "departure": "07:50",
      "arrival": "08:40",
      "durationMinutes": 50,
      "transfers": 1,
      "status": "Calculated",
      "steps": [
        {
          "transport": "Metrobus",
          "departure": "07:50",
          "arrival": "08:03",
          "durationMinutes": 13
        },
        {
          "transport": "Wait",
          "departure": "08:03",
          "arrival": "08:05",
          "durationMinutes": 2
        },
        {
          "transport": "Bus 19",
          "from": "UZUNÇAYIR METROBÜS",
          "to": "YEDİTEPE ÜNİVERSİTESİ KAMPÜSÜ",
          "departure": "08:05",
          "arrival": "08:40",
          "durationMinutes": 35
        }
      ]
    }
  ]
}
```

No reachable departure produces option status `"No reachable departure"` with an
explanatory note. A failed traffic calculation without fallback produces
`"Could not be calculated"`. Partial steps remain available; unavailable times
and the complete arrival/duration are `null`.
These partial calculation results return HTTP `200`. Malformed common steps outside alternatives,
invalid selectors, missing start keys, and unsupported fields return `400` before
provider calls. Supplied clock-only departures stay on their resolved date;
services are never automatically rolled forward to the following day.

This endpoint simulates the supplied departure instant, including past instants;
it has no current-time eligibility filter or arrival deadline. Shared traffic
caches and the per-service configurable concurrency limit apply to both endpoints.

Run `npm run benchmark:journeys` for an offline performance check. It evaluates
96 candidates with 24 distinct departures in two workloads: simulated provider
latency and repeated IETT route geometry. It prints elapsed milliseconds, provider
call counts, candidate counts, and the selected arrival. It uses fake upstream
clients and makes no network requests. Timings depend on the machine and are not
predictions of live provider latency.

Direct JavaScript callers can use `calculateJourney(input)` exported from
`src/index.js`, or `planner.calculateJourney(input)` on `createJourneyService()`.

### Example with step alternatives

A complete input and output are available in
[`examples/journey-options.request.json`](examples/journey-options.request.json)
and [`examples/journey-options.response.json`](examples/journey-options.response.json).
The response was generated with simulated provider durations of 10 minutes for
BUS 19 and 20 minutes for RING; it is an example of the API shape, not a live
traffic forecast.

```bash
curl -X POST http://localhost:3000/api/journeys/calculate \
  -H 'content-type: application/json' \
  --data-binary @examples/journey-options.request.json
```

The route starts at step 2 at 07:55, spends 15 minutes on M8, and reaches its
option step at 08:10. RING departs at 08:15 and arrives at 08:35; BUS 19 departs
at 08:20 and arrives at 08:30. The response therefore selects `recommendedOptionId: "1"`, reports arrival at
08:30, and returns both complete timelines in
`options`. Step 1 remains excluded by `startStep: 2`.

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
