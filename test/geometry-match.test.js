import assert from "node:assert/strict";
import test from "node:test";
import { createGeometryMatcher, compareGeometryMatches } from "../src/routing/geometry-match.js";
import { buildRouteGeometry } from "../src/routing/geometry.js";

const point = (x, y) => [29 + x / (111_195 * Math.cos(41 * Math.PI / 180)), 41 + y / 111_195];
const path = points => ({ type: "LineString", coordinates: points.map(([x, y]) => point(x, y)) });
const length = p => buildRouteGeometry(`LINESTRING (${p.coordinates.map(c => c.join(" ")).join(",")})`).totalLength;
const evaluate = (a, b, options, stops) => createGeometryMatcher(options).evaluate(a, b, length(b), stops);

test("bounded local deviations are approximate, with measured distance and intervals", () => {
  const a = path([[0, 0], [10_000, 0]]);
  const b = path([[0, 0], [4_000, 0], [4_150, 120], [4_300, 0], [10_000, 0]]);
  const match = evaluate(a, b, undefined, [0, 4_000, 4_300, length(a)]);
  assert.equal(match.valid, true, JSON.stringify(match.reasons));
  assert.equal(match.quality, "approximate");
  assert.ok(match.returnedToReferenceMaxMeters > 100);
  assert.ok(match.deviations.returned.length);
  assert.ok(match.returnedLongestDeviationMeters < 400);
  assert.ok(match.returnedOutsideCorridorMeters / length(b) < .08);
});

test("the maximum continuous deviation rejects a long parallel path even on a much longer route", () => {
  const a = path([[0, 0], [30_000, 0]]);
  const b = path([[0, 0], [14_000, 0], [14_050, 60], [15_050, 60], [15_100, 0], [30_000, 0]]);
  const match = evaluate(a, b);
  assert.equal(match.valid, false);
  assert.ok(match.reasons.includes("RETURNED_CONTINUOUS_DEVIATION"));
  assert.ok(match.returnedLongestDeviationMeters > 1_000);
});

test("reversed loop order is rejected even though both paths cover the same streets", () => {
  const a = path([[0, 0], [1_000, 0], [1_000, 500], [0, 500], [0, 0], [2_000, 0]]);
  const b = path([[0, 0], [0, 500], [1_000, 500], [1_000, 0], [0, 0], [2_000, 0]]);
  const match = evaluate(a, b);
  assert.equal(match.valid, false);
  assert.ok(match.orderedMaximumDeviationMeters > 150);
  assert.ok(match.reasons.some(reason => reason.includes("ORDER_MISMATCH")));
});

test("an omitted out-and-back is rejected despite a small nearest-road offset", () => {
  const a = path([[0, 0], [5_000, 0], [5_000, 30], [4_500, 30], [4_500, 0], [10_000, 0]]);
  const b = path([[0, 0], [10_000, 0]]);
  const match = evaluate(a, b);
  assert.equal(match.valid, false);
  assert.ok(match.reasons.some(reason => reason.includes("ORDER_MISMATCH") || reason.includes("LOCAL_SHORTCUT")));
});

test("a 24 metre interval cannot be replaced by an 889 metre detour", () => {
  const a = path([[0, 0], [24, 0]]), b = path([[0, 0], [0, 432.5], [24, 432.5], [24, 0]]);
  const match = evaluate(a, b);
  assert.equal(match.valid, false);
  assert.ok(match.reasons.includes("LENGTH_MISMATCH"));
});

test("policy changes are configurable and cached metrics are independent of caller mutations", () => {
  const a = path([[0, 0], [10_000, 0]]), b = path([[0, 0], [4_000, 0], [4_150, 120], [4_300, 0], [10_000, 0]]);
  const matcher = createGeometryMatcher();
  const first = matcher.evaluate(a, b, length(b));
  first.deviations.returned[0].maximumDeviationMeters = 99_999;
  const second = matcher.evaluate(a, b, length(b));
  assert.ok(second.deviations.returned[0].maximumDeviationMeters < 150);
  assert.equal(evaluate(a, b, { policy: { approximateMaxMeters: 100 } }).valid, false);
  assert.ok(compareGeometryMatches(second, evaluate(a, path([[0, 0], [4_000, 0], [4_150, 500], [4_300, 0], [10_000, 0]]))) < 0);
  matcher.clear();
  assert.deepEqual(matcher.evaluate(a, b, length(b)), second);
});
