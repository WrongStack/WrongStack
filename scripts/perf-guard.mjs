#!/usr/bin/env node
/**
 * perf-guard.mjs — the pawl on the performance ratchet.
 *
 * Re-measures every probe in `architecture/perf-baseline.json`, compares each
 * against its recorded baseline, and:
 *
 *   - FAILS (exit 1) when a metric regressed past its threshold, or when a
 *     baselined metric produced no measurement at all;
 *   - ratchets the baseline down for improvements, but only with `--write`;
 *   - changes nothing for deltas inside the band. A guard that quietly
 *     re-records a slightly worse number every run is how a "guarded" project
 *     drifts 40% slower without a single red check.
 *
 * Usage:
 *   node scripts/perf-guard.mjs                 # measure + report + gate
 *   node scripts/perf-guard.mjs --write         # …and tighten improvements
 *   node scripts/perf-guard.mjs --write --adopt # …and adopt new probes
 *   node scripts/perf-guard.mjs --from res.json # take id→value from a file
 *                                               # instead of running probes
 *   node scripts/perf-guard.mjs --only cli.     # id prefix filter
 *   node scripts/perf-guard.mjs --any-machine   # compare across machines anyway
 *   node scripts/perf-guard.mjs --json          # machine-readable report
 *
 * Probes run through the shared engine in `@wrongstack/core/performance`, so
 * the CLI, the WebUI round, and CI all apply the identical noise rule.
 */
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const BASELINE_PATH = path.join(repoRoot, 'architecture', 'perf-baseline.json');

const argv = process.argv.slice(2);
const has = (flag) => argv.includes(flag);
const flagValue = (flag) => {
  const index = argv.indexOf(flag);
  return index === -1 ? undefined : argv[index + 1];
};

const WRITE = has('--write');
const ADOPT = has('--adopt');
const JSON_OUT = has('--json');
const ONLY = flagValue('--only');
const FROM = flagValue('--from');

function die(message) {
  console.error(`[perf-guard] ${message}`);
  process.exit(2);
}

// `pathToFileURL`, not a bare path: on Windows a dynamic import of `D:\…`
// is rejected as an unsupported URL scheme, which reads as "the build is
// missing" and sends the user off to rebuild something that is already there.
const perf = await import(
  pathToFileURL(path.join(repoRoot, 'packages', 'core', 'dist', 'performance', 'index.js')).href
).catch((error) =>
  die(
    `could not load @wrongstack/core/performance from dist (${error.message}). Run \`pnpm build\` ` +
      '(or at least `pnpm --filter @wrongstack/core build`) first — the guard measures the built ' +
      'artifacts, which is what users actually run.',
  ),
);

const {
  applyRatchet,
  evaluateGuard,
  formatGuardReport,
  guardFailed,
  measure,
  parseBaselineFile,
  resolveExtractor,
  describeMachine,
} = perf;

if (!fs.existsSync(BASELINE_PATH)) {
  die(
    `no baseline at ${path.relative(repoRoot, BASELINE_PATH)}. ` +
      'Create one with a probe list, then run with --write --adopt to fill in the numbers.',
  );
}

let baseline;
try {
  baseline = parseBaselineFile(fs.readFileSync(BASELINE_PATH, 'utf8'));
} catch (error) {
  die(error.message);
}

const selected = baseline.entries.filter((entry) => (ONLY ? entry.id.startsWith(ONLY) : true));
if (selected.length === 0) die(ONLY ? `no probe id starts with "${ONLY}"` : 'baseline has no entries');

/** id → measured value for this run. */
const current = {};

if (FROM) {
  // External harness mode: someone else produced the numbers, the guard only
  // adjudicates them. Accepts a flat {id: value} object.
  const raw = JSON.parse(fs.readFileSync(path.resolve(repoRoot, FROM), 'utf8'));
  for (const [id, value] of Object.entries(raw)) {
    if (typeof value === 'number' && Number.isFinite(value)) current[id] = value;
  }
} else {
  for (const entry of selected) {
    if (!entry.command) {
      // No probe command and no --from: the entry is simply not measurable in
      // this run. evaluateGuard reports it as `missing`, which is the honest
      // outcome — better than skipping it and showing green.
      continue;
    }
    if (!JSON_OUT) process.stderr.write(`[perf-guard] measuring ${entry.id}…\n`);
    try {
      const measurement = await measure({
        command: entry.command,
        cwd: repoRoot,
        metric: entry.metric,
        runs: entry.runs ?? baseline.runs ?? 5,
        warmup: baseline.warmup ?? 1,
        ...(entry.timeoutMs === undefined ? {} : { timeoutMs: entry.timeoutMs }),
        extract: resolveExtractor(entry.extract ?? 'wall'),
      });
      current[entry.id] = measurement.median;
      if (!JSON_OUT && measurement.notes.length > 0) {
        process.stderr.write(`[perf-guard]   note: ${measurement.notes.join('; ')}\n`);
      }
    } catch (error) {
      // A probe that cannot run is reported as missing, not swallowed.
      if (!JSON_OUT) process.stderr.write(`[perf-guard]   FAILED: ${error.message}\n`);
    }
  }
}

// The machine is part of the comparison, not decoration: a baseline recorded
// elsewhere is not evidence here, in either direction. `--any-machine` opts out
// for the case where the hardware genuinely is equivalent.
const currentMachine = describeMachine();
const results = evaluateGuard(
  { ...baseline, entries: selected },
  current,
  has('--any-machine') ? {} : { currentMachine },
);
const drifted = results.filter((r) => r.verdict === 'machine-drift');
const failed = guardFailed(results);

if (JSON_OUT) {
  console.log(JSON.stringify({ failed, machine: currentMachine, results }, null, 2));
} else {
  console.log('');
  for (const line of formatGuardReport(results)) console.log(`  ${line}`);
  console.log('');
  if (drifted.length > 0) {
    // One log per line: no escape sequences to get wrong, and the block reads
    // the same in a terminal as it does here.
    console.log(
      `  ${drifted.length} probe(s) were baselined on another machine and were not compared.`,
    );
    console.log(`  This machine: ${currentMachine}`);
    console.log('  Re-record them here with --write, run on the baseline machine, or pass');
    console.log('  --any-machine if the hardware is genuinely equivalent.');
    console.log('');
  }
}

if (WRITE) {
  let commit;
  try {
    commit = execFileSync('git', ['rev-parse', '--short', 'HEAD'], {
      cwd: repoRoot,
      encoding: 'utf8',
      windowsHide: true,
    }).trim();
  } catch {
    /* not a git checkout, or git is unavailable — the entry just omits it */
  }
  const { file, tightened, recorded, adopted } = applyRatchet(baseline, results, {
    ...(commit === undefined ? {} : { commit }),
    machine: describeMachine(),
    adoptNew: ADOPT,
  });
  if (tightened.length > 0 || recorded.length > 0 || adopted.length > 0) {
    fs.writeFileSync(BASELINE_PATH, `${JSON.stringify(file, null, 2)}\n`);
    if (recorded.length > 0) console.log(`  recorded:  ${recorded.join(', ')}`);
    if (tightened.length > 0) console.log(`  ratcheted: ${tightened.join(', ')}`);
    if (adopted.length > 0) console.log(`  adopted:   ${adopted.join(', ')}`);
    console.log('');
  } else if (!JSON_OUT) {
    console.log('  baseline unchanged — nothing improved past the threshold.\n');
  }
}

if (failed) {
  console.error(
    '[perf-guard] FAILED. A regression here is a real slowdown unless you can show the\n' +
      '            machine was loaded — re-run on an idle machine before overriding it.\n',
  );
  process.exit(1);
}
