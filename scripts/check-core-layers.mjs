#!/usr/bin/env bun
/**
 * check-core-layers.mjs
 *
 * Ratchets the dependency DIRECTION between the top-level source areas of
 * `packages/core/src`. Every area is assigned a layer in
 * `architecture/core-layers.json`; an import from a lower layer into a higher
 * one (e.g. `types/` -> `coordination/`, `kernel/` -> `core/`) is an upward
 * edge. Upward edges are what keep `types`, `utils` and `kernel` from being
 * extracted into a leaf package: a type-only import still drags the whole
 * higher area into the declaration graph.
 *
 * Existing upward edges are recorded per `file -> target file` in the
 * baseline. A NEW upward edge fails. A RESOLVED edge also fails until the
 * baseline is regenerated in the same change, so the ratchet only moves down
 * and the recorded debt never overstates reality.
 *
 *   bun scripts/check-core-layers.mjs            # gate
 *   bun scripts/check-core-layers.mjs --write    # accept current edges
 *   bun scripts/check-core-layers.mjs --summary  # per-area upward edge counts
 */
import { readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const coreSrc = path.join(repoRoot, 'packages/core/src');
const configPath = path.join(repoRoot, 'architecture/core-layers.json');
const registryPath = path.join(repoRoot, 'architecture/registry.json');

const args = new Set(process.argv.slice(2));
for (const arg of args) {
  if (!['--write', '--summary'].includes(arg)) {
    console.error(`Unknown argument: ${arg}`);
    process.exit(2);
  }
}

const config = JSON.parse(readFileSync(configPath, 'utf8'));
const registry = JSON.parse(readFileSync(registryPath, 'utf8'));

/** Root-level files (boot.ts, public-*.ts, index.ts) are the composition root. */
const ROOT_AREA = '<root>';
const layerOf = new Map(
  Object.entries(config.layers).flatMap(([name, def]) =>
    def.areas.map((area) => [area, { name, rank: def.rank }]),
  ),
);

const errors = [];

const areas = readdirSync(coreSrc).filter((entry) =>
  statSync(path.join(coreSrc, entry)).isDirectory(),
);
for (const area of areas) {
  if (!layerOf.has(area)) errors.push(`core area "${area}" has no layer in core-layers.json`);
}
for (const area of Object.keys(registry.coreAreas ?? {})) {
  if (!layerOf.has(area)) errors.push(`registry core area "${area}" has no layer`);
}
for (const area of layerOf.keys()) {
  if (area !== ROOT_AREA && !areas.includes(area)) {
    errors.push(`core-layers.json assigns a layer to missing area "${area}"`);
  }
}

function* walk(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) yield* walk(full);
    else if (/\.tsx?$/.test(entry.name) && !/\.(test|spec)\.tsx?$/.test(entry.name)) yield full;
  }
}

/**
 * Static `import`/`export ... from`, plus `import('...')` with a relative
 * literal. An `import('x').Name` member access is a type query (type-only);
 * any other `import('x')` is a runtime dynamic import.
 */
const IMPORT_RE =
  /(?:^|\n)\s*(import|export)\s+(type\s+)?[^'"]*?\sfrom\s+['"](\.{1,2}\/[^'"]+)['"]|import\(\s*['"](\.{1,2}\/[^'"]+)['"]\s*\)(\.(?!then\b)[A-Za-z_$])?/g;

/** Block comments and whole-line `//` comments, so `{@link import('...')}` is not an edge. */
const stripComments = (source) =>
  source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

const areaOf = (rel) => (rel.includes('/') ? rel.split('/')[0] : ROOT_AREA);
const toPosix = (p) => p.split(path.sep).join('/');

const current = {};
for (const file of walk(coreSrc)) {
  const rel = toPosix(path.relative(coreSrc, file));
  const fromArea = areaOf(rel);
  const fromLayer = layerOf.get(fromArea);
  if (!fromLayer) continue;
  const source = stripComments(readFileSync(file, 'utf8'));
  for (const match of source.matchAll(IMPORT_RE)) {
    const spec = match[3] ?? match[4];
    const target = toPosix(path.normalize(path.join(path.dirname(rel), spec)));
    if (target.startsWith('..')) continue;
    const toArea = areaOf(target);
    if (toArea === fromArea) continue;
    const toLayer = layerOf.get(toArea);
    if (!toLayer || toLayer.rank <= fromLayer.rank) continue;
    const typeOnly = Boolean(match[2] ?? match[5]);
    const key = `${rel} -> ${target.replace(/\.js$/, '')}`;
    // A file can import the same target as type and as value; value wins.
    current[key] = current[key] === 'value' || !typeOnly ? 'value' : 'type';
  }
}

const sorted = Object.fromEntries(Object.entries(current).sort(([a], [b]) => a.localeCompare(b)));

if (args.has('--summary')) {
  const byArea = {};
  for (const [key, kind] of Object.entries(sorted)) {
    const area = areaOf(key.split(' -> ')[0]);
    byArea[area] ??= { type: 0, value: 0 };
    byArea[area][kind] += 1;
  }
  for (const [area, counts] of Object.entries(byArea).sort(
    (a, b) => b[1].type + b[1].value - a[1].type - a[1].value,
  )) {
    console.log(`${area.padEnd(16)} type=${counts.type} value=${counts.value}`);
  }
}

if (args.has('--write')) {
  config.upwardEdges = sorted;
  writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`, 'utf8');
  console.log(`check-core-layers: baseline written (${Object.keys(sorted).length} upward edges).`);
  process.exit(errors.length > 0 ? 1 : 0);
}

const baseline = config.upwardEdges ?? {};
const added = Object.keys(sorted).filter((key) => !(key in baseline));
const resolved = Object.keys(baseline).filter((key) => !(key in sorted));
for (const key of added) errors.push(`new upward import (${sorted[key]}): ${key}`);
for (const key of resolved) errors.push(`resolved upward import still in baseline: ${key}`);

if (errors.length > 0) {
  console.error(`check-core-layers: ${errors.length} problem(s):`);
  for (const message of errors) console.error(`  ${message}`);
  console.error(
    '\nLower layers must not import higher ones (see architecture/core-layers.json).\n' +
      'Move the shared contract down, or invert the dependency. When an edge is\n' +
      'resolved, regenerate the baseline in the same change: `bun run check:core-layers:sync`.',
  );
  process.exit(1);
}
console.log(`check-core-layers: ${Object.keys(sorted).length} upward edges, all baselined.`);
