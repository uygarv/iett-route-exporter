import test from "node:test";
import assert from "node:assert/strict";
import { decodeFlexiblePolyline } from "../src/routing/flexible-polyline.js";
import { encodePolyline } from "../test-support/here.js";

test("decodes the published HERE flexible-polyline example in GeoJSON order", () => {
  assert.deepEqual(decodeFlexiblePolyline("BFoz5xJ67i1B1B7PzIhaxL7Y").coordinates,
    [[8.69821, 50.10228], [8.69567, 50.10201], [8.6915, 50.10063], [8.68752, 50.09878]]);
});
test("supports third dimensions and rejects corrupt, truncated and out-of-range polylines", () => {
  const p = [[29, 41], [29.001, 41.001]];
  assert.deepEqual(decodeFlexiblePolyline(encodePolyline(p, 6, true)).coordinates, p);
  for (const invalid of [null, "", "A", "BG?", "BG_", "BFAA", "BFoz5xJ67i1B1B", encodePolyline([[181, 41], [182, 41]])]) {
    assert.throws(() => decodeFlexiblePolyline(invalid));
  }
});
