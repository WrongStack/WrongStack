#!/usr/bin/env bun

import { existsSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

/**
 * Repository root, resolved from THIS FILE's own location.
 *
 * It used to be `process.cwd()`, which made the measured tree depend on where
 * the command happened to be invoked. `.githooks/pre-commit` runs this script
 * with the repo root as cwd, so the hook itself looked correct — but any run
 * from a subdirectory (or a wrapper/tool that chdirs first) measured that
 * subdirectory instead. That is how an architecture-evidence commit absorbed a
 * teammate's UNTRACKED `packages/tui` file: the regenerated
 * `architecture/test-only-exports.json` and the `docs/reports/*` pair recorded
 * working-tree state that was never committed. Anchoring to `import.meta.url`
 * makes the measurement a property of the script, not of the shell.
 */
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

import {
  buildArchitectureHealth,
  committedEvidenceMatchesReport,
  evaluateReportFreshness,
  FRESHNESS_REPORT_FILES,
  loadArchitectureInputs,
  renderArchitectureHealthMarkdown,
} from './lib/architecture-health.mjs';

const args = new Set(process.argv.slice(2));
const baselineScopeArg = [...args].find((arg) => arg.startsWith('--baseline-files='));
const baselineScope = baselineScopeArg
  ? new Set(baselineScopeArg.slice('--baseline-files='.length).split(','))
  : undefined;
if (
  baselineScope &&
  (!args.has('--write-hotspot-baseline') ||
    [...baselineScope].some(
      (file) =>
        !/^(?:packages|apps)\/.+\.tsx?$/.test(file) ||
        file.split('/').includes('..') ||
        !existsSync(path.join(process.cwd(), file)),
    ))
) {
  console.error(
    '--baseline-files requires --write-hotspot-baseline and existing package/app source paths.',
  );
  process.exit(2);
}
const supported = new Set([
  '--json',
  '--print-hotspot-baseline',
  '--report-only',
  '--strict-hotspots',
  '--write',
  '--write-hotspot-baseline',
]);
for (const arg of args) {
  if (!supported.has(arg) && arg !== baselineScopeArg) {
    console.error(`Unknown argument: ${arg}`);
    process.exit(2);
  }
}

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
  // A shared checkout may contain unrelated drift. Refresh only measurements
  // explicitly owned by this maintenance operation; never fabricate counts.
  if (baselineScope) {
    const mergeScope = (previous, current) =>
      Object.fromEntries(
        [
          ...Object.entries(previous).filter(([file]) => !baselineScope.has(file)),
          ...Object.entries(current).filter(([file]) => baselineScope.has(file)),
        ].sort(([a], [b]) => a.localeCompare(b)),
      );
    hotspotBaseline.files = mergeScope(hotspots.files, hotspotBaseline.files);
    testOnlyExportBaseline.files = mergeScope(testOnlyExports.files, testOnlyExportBaseline.files);
  }
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

// ── --strict-hotspots: hard-stop on hotspot ratchet drift ────────────────
// Composes with any other flag, including --report-only: this is the only
// exit path that fails on hotspot drift when the caller explicitly asked
// for stricter enforcement (e.g. `pnpm release:prepare`, where a drifted
// architecture/hotspots.json would otherwise ship to npm).
//
// --write-hotspot-baseline is the sanctioned refresh op and is intentionally
// exempt: when the maintenance flag is set, the caller has accepted the new
// baseline and the drift is by definition the intended next state.
if (args.has('--strict-hotspots') && !args.has('--write-hotspot-baseline')) {
  // buildArchitectureHealth reports hotspot ratchet drift via report.errors,
  // so the strict check can simply re-read that same signal. We do not
  // re-run validateHotspotBaseline separately because the report already
  // contains its output; recomputing would re-measure the filesystem for no
  // additional information.
  const hotspotErrors = report.errors.filter((message) =>
    /(?:new \d+-line hotspot|hotspot (?:grew|shrunk)|relative import fan-out|stale hotspot baseline)/.test(
      message,
    ),
  );
  if (hotspotErrors.length > 0) {
    if (!args.has('--json')) {
      console.error(`❌ Hotspot ratchet drift (${hotspotErrors.length}):`);
      for (const message of hotspotErrors) console.error(`   ${message}`);
      console.error('Regenerate the ratchet in the same change: `bun check:architecture:sync`.');
    }
    process.exitCode = 1;
  } else if (!args.has('--json') && !args.has('--report-only')) {
    console.log('✓ Hotspot ratchet matches current source (--strict-hotspots).');
  }
}
