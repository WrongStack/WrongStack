#!/usr/bin/env node
/**
 * Rank a V8 `.cpuprofile` by SELF time per function.
 *
 * `pnpm profile:memory` covers the heap side (`--heap-prof`, snapshots), but a
 * CPU profile captured with `node --cpu-prof` had no reader here — and the
 * default call-tree view answers "what called what" rather than "where did the
 * CPU actually go". Self time is the question worth asking first: it is the
 * only column that points at the function to change.
 *
 * Capture, then read:
 *
 *   node --cpu-prof --cpu-prof-dir=.reports --cpu-prof-name=run.cpuprofile <entry>
 *   node scripts/analyze-cpuprofile.mjs .reports/run.cpuprofile
 *
 * Reading the output: frames from `node:internal/*` and `(native)` are process
 * startup and runtime overhead. A short-lived harness is usually dominated by
 * module compilation, which says the workload under test is cheap — not that
 * the loader is slow.
 */
import { readFileSync } from 'node:fs';

const USAGE = `Usage: node scripts/analyze-cpuprofile.mjs <file.cpuprofile> [options]

Options:
  --top <n>       Rows to print (default: 25)
  --min-pct <n>   Hide frames below this share of sampled CPU (default: 0)
  --all           Include node:internal / native frames (default: shown)
  --product-only  Show only frames from this repo's code
  --help          Show this help
`;

function fail(message, status = 2) {
  process.stderr.write(`${message}\n\n${USAGE}`);
  process.exit(status);
}

export function parseArgs(argv) {
  const options = { file: undefined, top: 25, minPct: 0, productOnly: false, help: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--help' || arg === '-h') {
      options.help = true;
      continue;
    }
    if (arg === '--product-only') {
      options.productOnly = true;
      continue;
    }
    if (arg === '--all') {
      options.productOnly = false;
      continue;
    }
    if (arg === '--top' || arg === '--min-pct') {
      const raw = argv[++i];
      const value = Number(raw);
      if (!Number.isFinite(value) || value < 0) {
        fail(`Invalid value for ${arg}: ${raw ?? '(missing)'}`);
      }
      if (arg === '--top') options.top = Math.max(1, Math.floor(value));
      else options.minPct = value;
      continue;
    }
    if (arg.startsWith('-')) fail(`Unknown argument: ${arg}`);
    if (options.file !== undefined) fail(`Unexpected extra argument: ${arg}`);
    options.file = arg;
  }
  return options;
}

/**
 * Aggregate self time per function.
 *
 * `timeDeltas[i]` is the interval that ELAPSED BEFORE `samples[i]` was taken,
 * so it belongs to the node that sample points at — that is the definition of
 * self time. Summing by node and then folding nodes onto their call frame
 * merges the same function appearing under different callers.
 */
export function selfTimeByFunction(profile) {
  const selfByNode = new Map();
  const samples = profile.samples ?? [];
  const deltas = profile.timeDeltas ?? [];
  for (let i = 0; i < samples.length; i++) {
    const id = samples[i];
    selfByNode.set(id, (selfByNode.get(id) ?? 0) + (deltas[i] ?? 0));
  }

  const byFunction = new Map();
  let totalUs = 0;
  for (const node of profile.nodes ?? []) {
    const self = selfByNode.get(node.id) ?? 0;
    if (self <= 0) continue;
    totalUs += self;
    const frame = node.callFrame ?? {};
    const url = String(frame.url ?? '').replace(/^file:\/\/\/?/, '');
    const isRuntime = url === '' || url.startsWith('node:');
    const short = url === '' ? '(native)' : url.split(/[\\/]/).slice(-2).join('/');
    const key = `${frame.functionName || '(anonymous)'} @ ${short}:${(frame.lineNumber ?? -1) + 1}`;
    const existing = byFunction.get(key);
    if (existing) existing.selfUs += self;
    else byFunction.set(key, { key, selfUs: self, isRuntime });
  }
  return { rows: [...byFunction.values()].sort((a, b) => b.selfUs - a.selfUs), totalUs };
}

export function render(profile, options) {
  const { rows, totalUs } = selfTimeByFunction(profile);
  const visible = rows
    .filter((row) => (options.productOnly ? !row.isRuntime : true))
    .filter((row) => (row.selfUs / totalUs) * 100 >= options.minPct)
    .slice(0, options.top);

  const lines = [];
  lines.push(
    `\nTotal sampled CPU: ${(totalUs / 1000).toFixed(1)} ms across ${(profile.samples ?? []).length} samples`,
  );
  lines.push('');
  lines.push(`${'self ms'.padStart(9)}  ${'%'.padStart(6)}  function`);
  lines.push('-'.repeat(100));
  for (const row of visible) {
    lines.push(
      `${(row.selfUs / 1000).toFixed(2).padStart(9)}  ` +
        `${((row.selfUs / totalUs) * 100).toFixed(1).padStart(5)}%  ${row.key}`,
    );
  }
  lines.push('');
  return lines.join('\n');
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    process.stdout.write(USAGE);
    return;
  }
  if (!options.file) fail('A .cpuprofile path is required.');
  let profile;
  try {
    profile = JSON.parse(readFileSync(options.file, 'utf8'));
  } catch (error) {
    fail(`Invalid profile at ${options.file}: ${error instanceof Error ? error.message : error}`);
  }
  if (!Array.isArray(profile.nodes) || !Array.isArray(profile.samples)) {
    fail(`Invalid profile at ${options.file}: missing nodes/samples (is this a .cpuprofile?)`);
  }
  process.stdout.write(render(profile, options));
}

if (
  import.meta.url === `file://${process.argv[1]}` ||
  process.argv[1]?.endsWith('analyze-cpuprofile.mjs')
) {
  main();
}
