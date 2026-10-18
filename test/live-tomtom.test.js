import assert from "node:assert/strict";
import test from "node:test";
import { calculateIettRouteTimes } from "../src/index.js";

test("live TomTom smoke test for 256_D_D0", {
  skip: !process.env.TOMTOM_API_KEY,
  timeout: 30_000
}, async () => {
  const result = await calculateIettRouteTimes("256_D_D0", {
    dwellTimeSeconds: 20
  });

  assert.equal(result.provider, "tomtom-orbis");
  assert.ok(result.segments.length > 0);
  assert.ok(result.total.estimatedDurationSeconds > 0);
});
