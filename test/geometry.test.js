import assert from "node:assert/strict";
import test from "node:test";
import {
  buildRouteGeometry,
  findClosestRoutePosition,
  pointAlongRoute,
  resampleRoute
} from "../src/routing/geometry.js";
import { selectWaypoints } from "../src/routing/waypoints.js";
import { coordinateForRouteMatch } from "../src/routing/stop-projection.js";

test("parses lng-lat WKT, joins segments, and preserves boundaries", () => {
  const geometry = buildRouteGeometry(
    "LINESTRING (29 41, 29.001 41)|LINESTRING (29.001 41, 29.001 41.001)"
  );

  assert.deepEqual(geometry.points[0], { lat: 41, lng: 29 });
  assert.equal(geometry.rawPointCount, 4);
  assert.equal(geometry.points.length, 3);
  assert.equal(geometry.boundaryDistances.length, 1);
  assert.ok(geometry.boundaryDistances[0] > 80);
});

test("does not use a bare LINESTRING boundary as a waypoint", () => {
  const geometry = buildRouteGeometry(
    "LINESTRING (29 41, 29.01 41)|LINESTRING (29.01 41, 29.02 41)"
  );
  const selection = selectWaypoints(geometry, { maxWaypoints: 5 });
  const boundary = selection.candidates.find(candidate => {
    return candidate.roles.length === 1
      && candidate.roles.includes("segment-boundary");
  });

  assert.ok(boundary);
  assert.equal(boundary.boundaryOnly, true);
  assert.equal(boundary.selected, false);
  assert.equal(boundary.rejectionReason, "boundary-only");
});

test("does not use a weak bend as a standalone turn waypoint", () => {
  const geometry = buildRouteGeometry(
    "LINESTRING (29 41, 29.012 41, 29.022 41.003)"
  );
  const selection = selectWaypoints(geometry, { maxWaypoints: 5 });
  const weakTurn = selection.candidates.find(candidate => candidate.weakTurnOnly);

  assert.ok(weakTurn);
  assert.equal(weakTurn.selected, false);
  assert.equal(weakTurn.rejectionReason, "weak-turn");
});

test("rejects malformed and disconnected IETT geometry", () => {
  assert.throws(
    () => buildRouteGeometry("POINT (29 41)"),
    error => error.code === "IETT_INVALID_GEOMETRY"
  );

  assert.throws(
    () => buildRouteGeometry(
      "LINESTRING (29 41, 29.001 41)|LINESTRING (30 41, 30.001 41)"
    ),
    error => error.code === "IETT_DISCONNECTED_GEOMETRY"
  );
});

test("resamples and interpolates by metres", () => {
  const geometry = buildRouteGeometry("LINESTRING (29 41, 29.012 41)");
  const samples = resampleRoute(geometry, 30);
  const middle = pointAlongRoute(geometry, geometry.totalLength / 2);

  assert.ok(samples.length > 30);
  assert.ok(Math.abs(middle.lng - 29.006) < 0.0001);
  assert.equal(samples.at(-1).distanceAlongRoute, geometry.totalLength);
});

test("does not create waypoint positions on gaps between LINESTRING segments", () => {
  const geometry = buildRouteGeometry(
    "LINESTRING (29 41, 29.001 41)|LINESTRING (29.002 41, 29.003 41)"
  );
  const gapStart = geometry.cumulativeDistances[1];
  const gapEnd = geometry.cumulativeDistances[2];
  const gapMiddle = pointAlongRoute(geometry, (gapStart + gapEnd) / 2);
  const gapCoordinate = { lat: 41, lng: 29.0015 };
  const gapMatch = findClosestRoutePosition(geometry, gapCoordinate);
  const selection = selectWaypoints(geometry, {
    maxWaypoints: 1,
    stationConstraints: [{
      ...gapCoordinate,
      distanceAlongRoute: (gapStart + gapEnd) / 2,
      stationName: "GAP STOP",
      stationIndex: 1,
      distanceToRoute: gapMatch.distanceToRoute,
      projectedToRoute: false
    }]
  });

  assert.ok(
    gapMiddle.distanceAlongRoute === gapStart
      || gapMiddle.distanceAlongRoute === gapEnd
  );
  assert.ok(gapMatch.distanceToRoute > 30);
  const gapStation = selection.candidates.find(candidate => {
    return candidate.stationName === "GAP STOP";
  });

  assert.ok(gapStation);
  assert.equal(gapStation.rejectionReason, "weak-station");

  for (const candidate of selection.candidates) {
    const match = findClosestRoutePosition(geometry, candidate);
    assert.ok(match.distanceToRoute < 0.01);
  }
});

test("shifts an important turn forward and uses fewer than nine points on simple routes", () => {
  const turning = buildRouteGeometry(
    "LINESTRING (29 41, 29.01 41, 29.01 41.01, 29.02 41.01)"
  );
  const cornerDistance = pointAlongRoute(turning, 840).distanceAlongRoute;
  const turnSelection = selectWaypoints(turning, { maxWaypoints: 9 });
  const turnWaypoint = turnSelection.waypoints.find(point => point.reason.includes("post-turn"));

  assert.ok(turnWaypoint);
  assert.ok(turnWaypoint.distanceAlongRoute > cornerDistance + 50);

  const straight = buildRouteGeometry("LINESTRING (29 40.7, 29 40.97)");
  const straightSelection = selectWaypoints(straight, { maxWaypoints: 9 });

  assert.ok(straightSelection.waypoints.length >= 2);
  assert.ok(straightSelection.waypoints.length <= 3);
});

test("finds route progress and detects a repeated route location", () => {
  const straight = buildRouteGeometry("LINESTRING (29 41, 29.02 41)");
  const match = findClosestRoutePosition(straight, { lat: 41.0001, lng: 29.01 });

  assert.ok(match.distanceToRoute < 20);
  assert.ok(match.distanceAlongRoute > straight.totalLength * 0.45);
  assert.ok(match.distanceAlongRoute < straight.totalLength * 0.55);
  assert.equal(match.ambiguous, false);

  const loop = buildRouteGeometry(
    "LINESTRING (29 41, 29.01 41, 29.01 41.01, 29 41.01, 29 41, 28.99 41)"
  );
  const ambiguous = findClosestRoutePosition(loop, { lat: 41, lng: 29 });

  assert.equal(ambiguous.ambiguous, true);
});

test("always projects stop coordinates onto the IETT route", () => {
  const coordinate = { lat: 41.001, lng: 29.01 };
  const routeMatch = {
    lat: 41,
    lng: 29.01,
    distanceToRoute: 0
  };

  assert.deepEqual(coordinateForRouteMatch(coordinate, routeMatch), {
    lat: routeMatch.lat,
    lng: routeMatch.lng
  });
});

test("keeps nearby stops distinct in the candidate pool", () => {
  const geometry = buildRouteGeometry("LINESTRING (29 41, 29.024 41)");
  const first = pointAlongRoute(geometry, 900);
  const second = pointAlongRoute(geometry, 940);
  const selection = selectWaypoints(geometry, {
    maxWaypoints: 4,
    stationConstraints: [
      {
        ...first,
        stationName: "CLOSE STOP 1",
        stationIndex: 1,
        distanceToRoute: 0,
        projectedToRoute: false
      },
      {
        ...second,
        stationName: "CLOSE STOP 2",
        stationIndex: 2,
        distanceToRoute: 0,
        projectedToRoute: false
      }
    ]
  });
  const stationCandidates = selection.candidates.filter(candidate => candidate.stationName);

  assert.deepEqual(stationCandidates.map(candidate => candidate.stationName), [
    "CLOSE STOP 1",
    "CLOSE STOP 2"
  ]);
});

test("skips redundant straight-road stops in favor of a later turn stop", () => {
  const geometry = buildRouteGeometry(
    "LINESTRING (29 41, 29.01 41, 29.01 41.01)"
  );
  const cornerDistance = geometry.cumulativeDistances[1];
  const station = (stationName, stationIndex, distanceAlongRoute) => ({
    ...pointAlongRoute(geometry, distanceAlongRoute),
    stationName,
    stationIndex,
    distanceToRoute: 0,
    projectedToRoute: false
  });
  const selection = selectWaypoints(geometry, {
    maxWaypoints: 3,
    stationConstraints: [
      station("FLAT A", 1, 400),
      station("FLAT B", 2, 526),
      station("TURN STOP", 3, cornerDistance + 100)
    ]
  });
  const selectedStationNames = selection.waypoints
    .map(waypoint => waypoint.stationName)
    .filter(Boolean);

  assert.ok(selectedStationNames.includes("TURN STOP"));
  assert.equal(
    selectedStationNames.filter(name => name === "FLAT A" || name === "FLAT B").length,
    0
  );
  assert.ok(selection.waypoints.some(waypoint => {
    return waypoint.stationName === "TURN STOP" && waypoint.roles.includes("post-turn");
  }));
});

test("protects strong turns before weak straight-road stations", () => {
  const geometry = buildRouteGeometry(
    "LINESTRING (29 41, 29.01 41, 29.01 41.01, 29.02 41.01, 29.02 41.02)"
  );
  const weakStation = pointAlongRoute(geometry, 400);
  const selection = selectWaypoints(geometry, {
    maxWaypoints: 2,
    stationConstraints: [{
      ...weakStation,
      stationName: "WEAK STRAIGHT STOP",
      stationIndex: 1,
      distanceToRoute: 0,
      projectedToRoute: false
    }]
  });
  const strongTurns = selection.waypoints.filter(waypoint => {
    return waypoint.roles.includes("post-turn") && waypoint.turnAngle >= 55;
  });
  const weakCandidate = selection.candidates.find(candidate => {
    return candidate.stationName === "WEAK STRAIGHT STOP";
  });

  assert.equal(strongTurns.length, 2);
  assert.equal(weakCandidate.selected, false);
  assert.equal(weakCandidate.rejectionReason, "weak-station");
});

test("rejects coverage and boundary points inside a turn decision zone", () => {
  const geometry = buildRouteGeometry(
    "LINESTRING (29 41, 29.01143 41) | LINESTRING (29.01143 41, 29.01143 41.01)"
  );
  const selection = selectWaypoints(geometry, {
    maxWaypoints: 2
  });
  const strongTurn = selection.candidates.find(candidate => {
    return candidate.roles.includes("post-turn") && candidate.turnAngle >= 55;
  });
  const unsafeCandidates = selection.candidates.filter(candidate => {
    return !candidate.roles.includes("post-turn")
      && candidate.nearTurnDecisionPoint;
  });

  assert.ok(strongTurn);
  assert.ok(unsafeCandidates.length > 0);
  assert.equal(strongTurn.selected, true);

  for (const candidate of unsafeCandidates) {
    assert.equal(candidate.selected, false);
    assert.equal(candidate.rejectionReason, "junction-proximity");
    const offset = candidate.distanceAlongRoute
      - candidate.nearestTurnSourceDistance;

    assert.ok(offset > -100);
    assert.ok(offset < 30);
  }
});
