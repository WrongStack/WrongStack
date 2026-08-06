#!/usr/bin/env node

import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import {
  buildArchitectureHealth,
  loadArchitectureInputs,
  renderArchitectureHealthMarkdown,
} from './lib/architecture-health.mjs';

const args = new Set(process.argv.slice(2));
const supported = new Set([
  '--json',
  '--print-hotspot-baseline',
  '--report-only',
  '--write',
  '--write-hotspot-baseline',
]);
for (const arg of args) {
  if (!supported.has(arg)) {
    console.error(`Unknown argument: ${arg}`);
    process.exit(2);
  }
}

const repoRoot = process.cwd();
const { registry, exceptions, hotspots, testOnlyExports } =
  await loadArchitectureInputs(repoRoot);
const report = await buildArchitectureHealth({
  repoRoot,
  registry,
  exceptions,
  hotspots,
  testOnlyExports,
});

const hotspotBaseline = {
  schemaVersion: 1,
  thresholdLines: hotspots.thresholdLines,
  files: Object.fromEntries(
    report.hotspotCandidates.map((item) => [
      item.file,
      { lines: item.lines, relativeImports: item.relativeImports },
    ]),
  ),
};

/**
 * Both ratchets refresh together. `check:architecture:sync` is the one command
 * that re-baselines, and a flag that silently refreshed only half of them would
 * leave the other half failing with no obvious way to accept the new state.
 */
const testOnlyExportFiles = {};
for (const item of report.testOnlyExports) {
  if (!testOnlyExportFiles[item.file]) testOnlyExportFiles[item.file] = [];
  testOnlyExportFiles[item.file].push(item.name);
}
const testOnlyExportBaseline = { schemaVersion: 1, files: testOnlyExportFiles };

if (args.has('--write-hotspot-baseline')) {
  await writeFile(
    path.join(repoRoot, 'architecture/hotspots.json'),
    `${JSON.stringify(hotspotBaseline, null, 2)}\n`,
    'utf8',
  );
  await writeFile(
    path.join(repoRoot, 'architecture/test-only-exports.json'),
    `${JSON.stringify(testOnlyExportBaseline, null, 2)}\n`,
    'utf8',
  );
}

if (args.has('--write')) {
  const reportDir = path.join(repoRoot, 'docs/reports');
  await mkdir(reportDir, { recursive: true });
  await writeFile(
    path.join(reportDir, 'architecture-health-current.json'),
    `${JSON.stringify(report, null, 2)}\n`,
    'utf8',
  );
  await writeFile(
    path.join(reportDir, 'architecture-health-current.md'),
    renderArchitectureHealthMarkdown(report),
    'utf8',
  );
}

if (args.has('--print-hotspot-baseline')) {
  console.log(
    JSON.stringify(
      hotspotBaseline,
      null,
      2,
    ),
  );
} else if (args.has('--json')) {
  console.log(JSON.stringify(report, null, 2));
} else {
  console.log(renderArchitectureHealthMarkdown(report));
}

if (
  report.errors.length > 0 &&
  !args.has('--report-only') &&
  !args.has('--print-hotspot-baseline') &&
  !args.has('--write-hotspot-baseline')
) process.exitCode = 1;
