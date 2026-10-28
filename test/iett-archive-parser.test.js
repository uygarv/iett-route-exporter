import assert from "node:assert/strict";
import test from "node:test";
import { readArchiveResponse, parseArchiveResponse } from "../src/clients/iett-archive-parser.js";
import { archiveXml, archiveRecord } from "./fixtures/iett-archive.js";

function chunkedResponse(xml, size = 7) {
  const bytes = typeof xml === "string" ? new TextEncoder().encode(xml) : xml;
  let offset = 0;
  const response = new Response(new ReadableStream({ pull(controller) {
    if (offset === bytes.length) { controller.close(); return; }
    controller.enqueue(bytes.subarray(offset, offset + size));
    offset = Math.min(offset + size, bytes.length);
  } }));
  response.text = () => { throw new Error("Streaming responses must never be buffered with text()."); };
  return response;
}

test("streaming SOAP preserves all values across UTF-8, tag and entity chunk boundaries", async () => {
  const records = [archiveRecord({ DTBITISZAMANI: null, FUTURE_FIELD: {
    text: 'İETT Şişli 🚍 & < > " \\ \'', list: [null, 1, false, { nested: true }]
  } }), JSON.parse('{"__proto__":{"preserved":true},"constructor":"source-value"}')];
  const xml = archiveXml(records);
  for (const size of [1, 2, 3, 7, 31, 65536]) {
    assert.deepEqual(await readArchiveResponse(chunkedResponse(xml, size)), records);
  }
  assert.deepEqual(await readArchiveResponse(chunkedResponse(archiveXml([]))), []);
});

test("CDATA, alternate namespace prefixes, comments and numeric entities remain lossless", async () => {
  const records = [archiveRecord({ FUTURE_FIELD: "İETT & <value> 🚍", SGOREVDURUM: "X" })];
  const json = JSON.stringify(records);
  const cdata = archiveXml().replace(/(?<=<GetIettArsivGorev_jsonResult>)[\s\S]*?(?=<\/GetIettArsivGorev_jsonResult>)/,
    () => `<![CDATA[${json}]]>`);
  const alternate = archiveXml(records).replaceAll("soap:", "env:").replace("xmlns:soap", "xmlns:env");
  const entities = archiveXml(records).replaceAll("&amp;", "&#38;").replaceAll("&lt;", "&#x3c;")
    .replaceAll("&gt;", "&#62;").replace('"X"', '"<!--split-->X"');
  for (const xml of [cdata, alternate, entities]) {
    assert.deepEqual(parseArchiveResponse(xml), records);
    assert.deepEqual(await readArchiveResponse(chunkedResponse(xml, 1)), records);
  }
});

test("large JSON text and CDATA values survive SAX text-buffer flushes", async () => {
  const records = [archiveRecord({ FUTURE_FIELD: "İETT & 🚍".repeat(20_000) })];
  const plain = archiveXml(records);
  const cdata = archiveXml().replace(/(?<=<GetIettArsivGorev_jsonResult>)[\s\S]*?(?=<\/GetIettArsivGorev_jsonResult>)/,
    () => `<![CDATA[${JSON.stringify(records)}]]>`);
  for (const xml of [plain, cdata]) {
    assert.deepEqual(parseArchiveResponse(xml), records);
    assert.deepEqual(await readArchiveResponse(chunkedResponse(xml, 8192)), records);
  }
});

test("streamed and synchronous XML validation reject DTDs, broken documents and unknown entities", async () => {
  const documents = [
    "<broken>",
    archiveXml().slice(0, -4),
    archiveXml().replace("</soap:Body>", "</soap:Wrong>"),
    archiveXml().replace("<?xml version=\"1.0\" encoding=\"utf-8\"?>", '<!DOCTYPE soap:Envelope [<!ENTITY x "expanded">]>'),
    archiveXml().replace('"19"', '"&unknown;"'),
    `${archiveXml()}unexpected`,
    `${archiveXml()}<extra/>`
  ];
  for (const xml of documents) {
    assert.throws(() => parseArchiveResponse(xml), { code: "IETT_ARCHIVE_INVALID_XML" });
    await assert.rejects(readArchiveResponse(chunkedResponse(xml, 1)), { code: "IETT_ARCHIVE_INVALID_XML" });
  }
});

test("streaming rejects malformed UTF-8 without replacing source characters", async () => {
  const bytes = new TextEncoder().encode(archiveXml());
  const invalid = new Uint8Array([...bytes.subarray(0, 100), 0xff, ...bytes.subarray(100)]);
  await assert.rejects(readArchiveResponse(chunkedResponse(invalid, 1)), { code: "IETT_ARCHIVE_INVALID_XML" });
  await assert.rejects(readArchiveResponse(chunkedResponse(new Uint8Array([...bytes, 0xc4]), 1)), { code: "IETT_ARCHIVE_INVALID_XML" });
});

test("SOAP faults and invalid result shapes retain their original error codes", async () => {
  const result = "GetIettArsivGorev_jsonResult";
  for (const [xml, code] of [
    ['<s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/"><s:Body><s:Fault><faultstring>Error</faultstring></s:Fault></s:Body></s:Envelope>', "IETT_ARCHIVE_SOAP_FAULT"],
    [archiveXml({ error: "not an array" }), "IETT_ARCHIVE_INVALID_JSON"],
    [archiveXml(null), "IETT_ARCHIVE_INVALID_JSON"],
    [archiveXml().replaceAll(result, "UnexpectedResult"), "IETT_ARCHIVE_INVALID_JSON"],
    [archiveXml().replace(`<${result}>`, `<${result}><nested/>`), "IETT_ARCHIVE_INVALID_JSON"],
    [archiveXml().replace(`</${result}>`, `</${result}><${result}>[]</${result}>`), "IETT_ARCHIVE_INVALID_JSON"]
  ]) {
    assert.throws(() => parseArchiveResponse(xml), { code });
    await assert.rejects(readArchiveResponse(chunkedResponse(xml, 3)), { code });
  }
});

test("malformed streamed XML cancels the unread response body", async () => {
  let cancelled = false;
  const response = new Response(new ReadableStream({ start(controller) {
    controller.enqueue(new TextEncoder().encode("<a></wrong>"));
  }, cancel() { cancelled = true; } }));
  await assert.rejects(readArchiveResponse(response), { code: "IETT_ARCHIVE_INVALID_XML" });
  assert.equal(cancelled, true);
});
