import assert from "node:assert/strict";
import test from "node:test";
import { readIettProxyPolicy } from "../src/clients/iett-fetch.js";

test("each IETT client selects its own proxy policy while source-only configuration stays compatible", () => {
  for (const [scope, setting] of [["client", "IETT_CLIENT_USE_PROXY"], ["archive", "IETT_ARCHIVE_USE_PROXY"]]) {
    assert.equal(readIettProxyPolicy(scope, { env: {} }), false);
    assert.equal(readIettProxyPolicy(scope, { env: { IBB_PROXY_SOURCE_URL: " " } }), false);
    assert.equal(readIettProxyPolicy(scope, { env: { IBB_PROXY_SOURCE_URL: "https://source.example/list" } }), true);
    for (const value of ["false", "FALSE", " False "]) {
      assert.equal(readIettProxyPolicy(scope, { env: { [setting]: value, IBB_PROXY_SOURCE_URL: "invalid URL" } }), false);
    }
    for (const value of [undefined, "", "true", "TRUE", " True "]) {
      assert.equal(readIettProxyPolicy(scope, { env: { [setting]: value, IBB_PROXY_SOURCE_URL: "https://source.example/list" } }), true);
    }
  }
  const env = { IETT_CLIENT_USE_PROXY: "false", IETT_ARCHIVE_USE_PROXY: "true", IBB_PROXY_SOURCE_URL: "https://source.example/" };
  assert.equal(readIettProxyPolicy("client", { env }), false);
  assert.equal(readIettProxyPolicy("archive", { env }), true);
});

test("enabled proxy policies reject missing/invalid sources and misspelled flags without exposing secrets", () => {
  for (const [scope, setting] of [["client", "IETT_CLIENT_USE_PROXY"], ["archive", "IETT_ARCHIVE_USE_PROXY"]]) {
    for (const value of ["flase", "yes", "1", "http://private:secret@proxy.example/"]) {
      assert.throws(() => readIettProxyPolicy(scope, { env: { [setting]: value } }), error => {
        assert.equal(error.code, "IBB_PROXY_CONFIGURATION_ERROR");
        assert.equal(error.status, 503);
        assert.doesNotMatch(error.message, /private|secret/);
        return true;
      });
    }
    for (const source of [undefined, "", "invalid", "socks5://proxy.example", "https://private:secret@proxy.example/"]) {
      assert.throws(() => readIettProxyPolicy(scope, { env: { [setting]: "true", IBB_PROXY_SOURCE_URL: source } }), error => {
        assert.equal(error.code, "IBB_PROXY_CONFIGURATION_ERROR");
        assert.equal(error.status, 503);
        assert.doesNotMatch(error.message, /private|secret/);
        return true;
      });
    }
  }
});

test("programmatic proxy selection overrides environment flags", () => {
  const env = { IETT_CLIENT_USE_PROXY: "false", IETT_ARCHIVE_USE_PROXY: "true", IBB_PROXY_SOURCE_URL: "https://source.example/" };
  assert.equal(readIettProxyPolicy("client", { useProxy: true, env }), true);
  assert.equal(readIettProxyPolicy("archive", { useProxy: false, env }), false);
  assert.equal(readIettProxyPolicy("client", { useProxy: false, env: { IETT_CLIENT_USE_PROXY: "invalid", IBB_PROXY_SOURCE_URL: "invalid" } }), false);
  assert.throws(() => readIettProxyPolicy("client", { useProxy: "false", env }), TypeError);
  assert.throws(() => readIettProxyPolicy("unknown", { env }), TypeError);
});
