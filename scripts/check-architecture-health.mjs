#!/usr/bin/env node

import { existsSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import {
  buildArchitectureHealth,
  committedEvidenceMatchesReport,
  evaluateReportFreshness,
  FRESHNESS_REPORT_FILES,
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
const { registry, exceptions, hotspots, testOnlyExports } = await loadArchitectureInputs(repoRoot);
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
  console.log(JSON.stringify(hotspotBaseline, null, 2));
} else if (args.has('--json')) {
  console.log(JSON.stringify(report, null, 2));
} else {
  console.log(renderArchitectureHealthMarkdown(report));
}

// ── Committed-evidence freshness gate ────────────────────────────────────
// The report pair under docs/reports/ is committed evidence; when a watched
// source root got a newer commit than the evidence, the run fails in bare
// check mode (the mode `pnpm check:architecture` and `release:check` use).
// Maintenance flags skip it: --write regenerates the evidence (and would
// embed the staleness it is fixing), --write-hotspot-baseline and
// --print-hotspot-baseline refresh unrelated ratchets, --report-only is the
// advisory rendering mode.
const maintenanceMode =
  args.has('--write') ||
  args.has('--report-only') ||
  args.has('--print-hotspot-baseline') ||
  args.has('--write-hotspot-baseline');
if (!maintenanceMode) {
  // History alone cannot prove freshness: a DELETED report file still has a
  // git history (its deletion commit is the newest one), so the pair must
  // exist on disk before any "fresh" verdict is trusted.
  const pairMissing = FRESHNESS_REPORT_FILES.filter(
    (file) => !existsSync(path.join(repoRoot, file)),
  );
  const freshness = pairMissing.length
    ? {
        status: 'stale',
        reason: 'committed-evidence-missing',
        detail: `Missing on disk: ${pairMissing.join(', ')}.`,
      }
    : committedEvidenceMatchesReport(repoRoot, report)
      ? { status: 'fresh', reason: 'evidence-matches-measurements' }
      : evaluateReportFreshness(repoRoot);
  if (freshness.status === 'stale') {
    console.error(
      `❌ Stale architecture evidence: ${freshness.reason} — ${freshness.detail ?? ''}`,
    );
    console.error(
      'Regenerate and commit the evidence in the same change: `pnpm report:architecture`.',
    );
    process.exitCode = 1;
  } else if (freshness.status === 'skipped') {
    console.warn(`⚠️ Report freshness check skipped: ${freshness.detail ?? 'no git history'}`);
  }
}

if (
  report.errors.length > 0 &&
  !args.has('--report-only') &&
  !args.has('--print-hotspot-baseline') &&
  !args.has('--write-hotspot-baseline')
)
  process.exitCode = 1;
