import sax from "sax";
import { AppError } from "../shared/errors.js";
import { readIbbResponse } from "./ibb-fetch.js";

const RESULT_PATH = ["Envelope", "Body", "GetIettArsivGorev_jsonResponse", "GetIettArsivGorev_jsonResult"];
const CHUNK_SIZE = 64 * 1024;

function invalidXml() {
  return new AppError(502, "IETT_ARCHIVE_INVALID_XML", "IETT returned invalid archive XML.");
}

function invalidJson() {
  return new AppError(502, "IETT_ARCHIVE_INVALID_JSON", "IETT returned invalid archive JSON.");
}

function createArchiveParser() {
  // SAX emits bounded text chunks instead of building an XML object tree.
  // Keep position tracking enabled: sax uses it to flush large text buffers.
  const parser = sax.parser(true, { xmlns: true, strictEntities: true });
  const stack = [];
  let parts = [];
  let resultCount = 0;
  let rootCount = 0;
  let structuredResult = false;
  let fault = false;
  const inResult = () => RESULT_PATH.every((name, i) => stack[i] === name);
  parser.onerror = () => { throw invalidXml(); };
  parser.ondoctype = () => { throw invalidXml(); };
  parser.onsgmldeclaration = () => { throw invalidXml(); };
  parser.onopentag = tag => {
    if (!stack.length && ++rootCount > 1) throw invalidXml();
    stack.push(tag.local);
    if (stack.length === RESULT_PATH.length && inResult()) resultCount++;
    if (stack.length > RESULT_PATH.length && inResult()) structuredResult = true;
    if (stack.length === 3 && stack[0] === "Envelope" && stack[1] === "Body" && stack[2] === "Fault") fault = true;
  };
  parser.onclosetag = () => { stack.pop(); };
  parser.ontext = parser.oncdata = text => {
    if (stack.length === RESULT_PATH.length && inResult()) parts.push(text);
  };
  return {
    write(text) {
      // A caller may supply an entire document or a very large network chunk.
      for (let offset = 0; offset < text.length; offset += CHUNK_SIZE) {
        parser.write(text.slice(offset, offset + CHUNK_SIZE));
      }
    },
    finish() {
      parser.close();
      if (fault) throw new AppError(502, "IETT_ARCHIVE_SOAP_FAULT", "IETT returned an archive SOAP fault.");
      if (resultCount !== 1 || structuredResult) throw invalidJson();
      const json = parts.join("");
      parts = null;
      let records;
      try { records = JSON.parse(json); }
      catch { throw invalidJson(); }
      if (!Array.isArray(records)) throw invalidJson();
      return records;
    }
  };
}

export function parseArchiveResponse(xml) {
  const parser = createArchiveParser();
  parser.write(xml);
  return parser.finish();
}

export async function readArchiveResponse(response, { signal, onChunk = () => {} } = {}) {
  // Small injected test clients may provide only text(); production fetch
  // responses always use the incremental UTF-8/ReadableStream path below.
  if (!response.body) return parseArchiveResponse(await readIbbResponse(response, "text"));
  return readIbbResponse(response, async () => {
    const parser = createArchiveParser();
    const decoder = new TextDecoder("utf-8", { fatal: true });
    for await (const bytes of response.body) {
      onChunk(bytes.byteLength);
      signal?.throwIfAborted();
      let text;
      try { text = decoder.decode(bytes, { stream: true }); }
      catch { throw invalidXml(); }
      parser.write(text);
    }
    signal?.throwIfAborted();
    try { parser.write(decoder.decode()); }
    catch (error) {
      if (error instanceof AppError) throw error;
      throw invalidXml();
    }
    return parser.finish();
  });
}
