import assert from "node:assert/strict";
import test from "node:test";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const sourceRoot = fileURLToPath(new URL("../src/", import.meta.url));

async function sourceFiles(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  return (await Promise.all(entries.map(entry => entry.isDirectory()
    ? sourceFiles(path.join(directory, entry.name))
    : entry.name.endsWith(".js") ? [path.join(directory, entry.name)] : []))).flat();
}

const files = await sourceFiles(sourceRoot);
const graph = new Map(await Promise.all(files.map(async file => {
  const source = await readFile(file, "utf8");
  const imports = [...source.matchAll(/(?:import\s+(?:[\s\S]*?\s+from\s+)?|export\s+[^;]*?\s+from\s+)["']([^"']+)["']/g)];
  return [file, imports.map(match => match[1]).filter(value => value.startsWith("."))
    .map(value => path.resolve(path.dirname(file), value))];
})));

test("routing, journeys and shared modules do not depend on application services or API clients", () => {
  for (const [file, dependencies] of graph) {
    const directory = path.relative(sourceRoot, file).split(path.sep)[0];
    if (!["routing", "journeys", "shared"].includes(directory)) continue;
    for (const dependency of dependencies) {
      const target = path.relative(sourceRoot, dependency).split(path.sep)[0];
      assert.ok(["routing", "journeys", "shared"].includes(target),
        `${path.relative(sourceRoot, file)} depends on ${path.relative(sourceRoot, dependency)}`);
    }
  }
});

test("local module imports resolve and contain no cycles", () => {
  const visited = new Set();
  const active = new Set();
  function visit(file, chain = []) {
    assert.ok(graph.has(file), `Missing module: ${file}`);
    assert.ok(!active.has(file), `Import cycle: ${[...chain, file].map(item => path.relative(sourceRoot, item)).join(" -> ")}`);
    if (visited.has(file)) return;
    active.add(file);
    for (const dependency of graph.get(file)) visit(dependency, [...chain, file]);
    active.delete(file);
    visited.add(file);
  }
  for (const file of files) visit(file);
});
