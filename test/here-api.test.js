import test from "node:test";
import assert from "node:assert/strict";
import { createApp } from "../src/app.js";
import { createIettService } from "../src/services/iett-service.js";
import { HereClient } from "../src/clients/here-client.js";
import { MockHereClient, routeData, length } from "../test-support/here.js";

test("travel-times selects HERE through the HTTP body and keeps TomTom as default", async () => {
  const here = new MockHereClient();
  let tomTomCalls = 0;
  const service = createIettService({ client: { getRoutePin: async () => routeData() }, hereClient: here,
    tomTomClient: { async calculateRoute(payload) {
      tomTomCalls++;
      return { routes: [{ legs: payload.legs.map(l => ({ path: l.path, summary: {
        lengthInMeters: length(l.path.coordinates), travelDurationInSeconds: 300,
        trafficDelayDurationInSeconds: 0, departureDateTime: "2026-10-21T05:06:00Z", arrivalDateTime: "2026-10-21T05:11:00Z"
      } })) }] };
    } } });
  const server = createApp({ service }).listen(0, "127.0.0.1");
  await new Promise(resolve => server.once("listening", resolve));
  try {
    const post = body => fetch(`http://127.0.0.1:${server.address().port}/api/iett/routes/19_D_D0/travel-times`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body)
    });
    const body = { departureTime: "2026-10-21T08:06:00+03:00" };
    for (const [provider, expected] of [[undefined, "tomtom-orbis"], ["here", "here"], ["tomtom", "tomtom-orbis"]]) {
      const response = await post({ ...body, ...(provider ? { provider } : {}) });
      assert.equal(response.status, 200);
      const result = await response.json();
      assert.equal(result.provider, expected);
      assert.equal(result.segments.length, 3);
    }
    assert.equal(tomTomCalls, 1);
    assert.equal(here.calls.length, 1);
    const invalid = await post({ provider: "invalid" });
    assert.equal(invalid.status, 400);
    assert.equal((await invalid.json()).error.code, "INVALID_PROVIDER");
    assert.equal(here.calls.length, 1);
  } finally { await new Promise(resolve => server.close(resolve)); }
});

test("missing HERE credentials are reported only when HERE is selected", async () => {
  const service = createIettService({ client: { getRoutePin: async () => routeData() }, hereClient: new HereClient({ apiKey: "" }) });
  await assert.rejects(service.calculateIettRouteTimes("19_D_D0", { provider: "here" }),
    e => e.status === 503 && e.code === "ROUTING_PROVIDER_NOT_CONFIGURED" && /HERE_API_KEY/.test(e.message));
});
