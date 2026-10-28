import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { createWriteStream } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { archiveRecord, archiveXml } from "./fixtures/iett-archive.js";

test("three full archive days remain lossless within a 256 MiB V8 heap", { timeout: 30_000 }, async t => {
  const folder = await mkdtemp(join(tmpdir(), "iett-archive-memory-test-"));
  t.after(() => rm(folder, { recursive: true, force: true }));
  const file = join(folder, "day.xml");
  const count = 55_532;
  const hash = createHash("sha256");
  const [header, footer] = archiveXml([]).split("[]");
  await pipeline(Readable.from((async function* () {
    yield `${header}[`;
    let batch = [];
    for (let index = 0; index < count; index++) {
      const json = JSON.stringify(archiveRecord({ ID: 177_000_000 + index,
        FUTURE_FIELD: { text: "İETT & <Şişli> 🚍", unknown: [null, false, 12] } }));
      hash.update(json);
      batch.push(`${index ? "," : ""}${json.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;")}`);
      if (batch.length === 500) { yield batch.join(""); batch = []; }
    }
    if (batch.length) yield batch.join("");
    yield `]${footer}`;
  })()), createWriteStream(file));
  const expectedDigest = hash.digest("hex");
  const script = `
    import { createReadStream } from 'node:fs';
    import { Readable } from 'node:stream';
    import { createHash } from 'node:crypto';
    import { IettArchiveClient } from './src/clients/iett-archive-client.js';
    const client = new IettArchiveClient({ delayMs: 0,
      fetchImpl: async () => new Response(Readable.toWeb(createReadStream(process.argv[1]))) });
    const results = [];
    for (let day = 0; day < 3; day++) {
      const records = await client.fetchDay('2026-10-25');
      const hash = createHash('sha256');
      for (const record of records) hash.update(JSON.stringify(record));
      results.push({ count: records.length, digest: hash.digest('hex') });
    }
    console.log(JSON.stringify(results));
  `;
  const { stdout } = await promisify(execFile)(process.execPath,
    ["--max-old-space-size=256", "--input-type=module", "-e", script, file], { timeout: 25_000 });
  assert.deepEqual(JSON.parse(stdout), Array(3).fill({ count, digest: expectedDigest }));
});
