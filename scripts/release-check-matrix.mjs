/**
 * release:check gate-matrix runner.
 *
 * Why this exists
 * ---------------
 * `pnpm release:check` used to be a single `&&` chain: the first failing
 * gate aborted everything after it, so one broken gate blinded the release
 * to every later problem — fixing gate 3 meant discovering gate 9's failure
 * only after another full 20-minute re-run. This runner executes EVERY
 * gate (except those whose prerequisites failed), captures per-gate status,
 * duration, and full output, and reports one matrix with failure tails.
 *
 * Semantics
 * ---------
 * - Gates run in the same order as the historical `&&` chain.
 * - A gate whose `prereq` failed is reported as SKIP (running it would be
 *   guaranteed-fail noise: most gates consume workspace `dist/` built by
 *   the `build` gate).
 * - Full stdout+stderr per gate lands in `.reports/release-check-matrix/
 *   <id>.log` (gitignored). The console report shows the last
 *   `--tail N` lines (default 25) of each FAIL.
 * - Exit codes: 0 = all gates PASS (or SKIP-with-reason); 1 = one or more
 *   FAIL; 2 = usage error.
 *
 * Flags
 * -----
 *   --list            print the gate plan (id, command, prereq) and exit
 *   --only a,b,...    run only the named gate ids (comma separated)
 *   --tail N          failure-tail length in the report (default 25)
 *
 * The runner deliberately does not parse or interpret gate output — it only
 * propagates exit codes. Gate semantics stay owned by each gate script.
 */
import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';

const LOG_DIR = path.resolve('.reports/release-check-matrix');

/**
 * Gate order matches the historical release:check chain exactly (see git
 * history of package.json "release:check" before this runner landed).
 * `prereq: 'build'` marks gates that consume workspace dist/ output —
 * they are skipped when the build gate fails rather than run to a
 * guaranteed failure.
 */
const GATES = [
  { id: 'audit', label: 'Dependency audit', cmd: 'pnpm audit --audit-level=moderate' },
  {
    id: 'build',
    label: 'Production build (esbuild + tsc declarations)',
    cmd: 'pnpm build',
  },
  {
    id: 'dist-hidden',
    label: 'No hidden files in published trees',
    cmd: 'pnpm check:dist-hidden',
    prereq: 'build',
  },
  {
    id: 'providers-catalog',
    label: 'Provider catalog snapshot',
    cmd: 'pnpm providers:catalog:check',
    prereq: 'build',
  },
  {
    id: 'plugin-manifests',
    label: 'Plugin projection snapshots',
    cmd: 'pnpm plugins:manifest:check',
    prereq: 'build',
  },
  {
    id: 'package-contracts',
    label: 'Publishable package contracts',
    cmd: 'node scripts/check-package-contracts.mjs',
    prereq: 'build',
  },
  {
    id: 'build-manifest-write',
    label: 'Write build lineage manifest',
    cmd: 'pnpm write:build-manifest',
    prereq: 'build',
  },
  {
    id: 'build-manifest-verify',
    label: 'Verify build lineage manifest',
    cmd: 'pnpm check:build-manifest',
    prereq: 'build-manifest-write',
  },
  {
    id: 'architecture',
    label: 'Architecture health + freshness gate',
    cmd: 'pnpm check:architecture',
    prereq: 'build',
  },
  {
    id: 'test-inventory',
    label: 'Runtime test inventory',
    cmd: 'pnpm check:test-inventory',
    prereq: 'build',
  },
  {
    id: 'test-skips',
    label: 'Test skip budget',
    cmd: 'pnpm check:test-skips',
    prereq: 'build',
  },
  {
    id: 'node-pty',
    label: 'Windows node-pty install',
    cmd: 'pnpm check:node-pty',
  },
  { id: 'rulebook', label: 'TechStack rulebook schema', cmd: 'pnpm check:rulebook' },
  { id: 'i18n', label: 'i18n completeness', cmd: 'pnpm lint:i18n' },
  {
    id: 'typecheck',
    label: 'Workspace typecheck',
    cmd: 'pnpm typecheck:only',
    prereq: 'build',
  },
  {
    id: 'test-types',
    label: 'Test-type ratchet',
    cmd: 'pnpm check:test-types',
    prereq: 'typecheck',
  },
  {
    id: 'coverage',
    label: 'Coverage ratchets (root + scripts)',
    cmd: 'pnpm test:coverage',
    prereq: 'build',
  },
];

function fail(msg) {
  console.error(`release-check-matrix: ${msg}`);
  process.exit(2);
}

const args = process.argv.slice(2);
let tail = 25;
let listOnly = false;
let only = null;
for (let i = 0; i < args.length; i++) {
  const a = args[i];
  if (a === '--list') listOnly = true;
  else if (a === '--tail') {
    const v = Number.parseInt(args[++i] ?? '', 10);
    if (Number.isNaN(v) || v < 0) fail(`--tail expects a non-negative integer (got ${args[i]})`);
    tail = v;
  } else if (a === '--only') {
    const raw = args[++i];
    if (!raw) fail('--only expects a comma-separated gate id list');
    const ids = raw.split(',').map((s) => s.trim()).filter(Boolean);
    const known = new Set(GATES.map((g) => g.id));
    for (const id of ids) if (!known.has(id)) fail(`unknown gate id "${id}" (use --list)`);
    only = new Set(ids);
  } else fail(`unknown flag "${a}" (supported: --list, --only <ids>, --tail <n>)`);
}

if (listOnly) {
  console.log('release:check gate matrix — plan');
  for (const g of GATES) {
    console.log(`  ${g.id.padEnd(22)} ${g.prereq ? `[after ${g.prereq}] ` : '[standalone]   '} ${g.cmd}`);
  }
  process.exit(0);
}

const selected = only ? GATES.filter((g) => only.has(g.id)) : GATES;
const results = new Map(); // id -> { status, ms, code }
mkdirSync(LOG_DIR, { recursive: true });

console.log(`release:check gate matrix — running ${selected.length} gate(s)\n`);
let anyFail = false;

for (const gate of selected) {
  // Prereq handling: skip (with reason) when an earlier gate failed, or when
  // a prereq outside the selected subset was never run at all.
  const prereq = gate.prereq;
  let skipReason = null;
  if (prereq) {
    if (only && !only.has(prereq)) skipReason = `prereq "${prereq}" not in --only subset`;
    else {
      const pre = results.get(prereq);
      if (pre?.status === 'fail') skipReason = `prereq "${prereq}" FAILED`;
      else if (pre?.status === 'skip') skipReason = `prereq "${prereq}" skipped (${pre.reason})`;
    }
  }

  if (skipReason) {
    results.set(gate.id, { status: 'skip', reason: skipReason });
    console.log(`[SKIP] ${gate.id} — ${skipReason}`);
    continue;
  }

  const logFile = path.join(LOG_DIR, `${gate.id}.log`);
  console.log(`[RUN ] ${gate.id} — ${gate.label}`);
  const t0 = Date.now();
  // shell: true resolves pnpm.cmd / pnpm on Windows the same way a package.json
  // script line would; output is captured (not streamed) so the matrix stays
  // readable and each gate's full log lands in its file.
  const r = spawnSync(gate.cmd, {
    shell: true,
    encoding: 'utf8',
    env: { ...process.env },
    maxBuffer: 256 * 1024 * 1024,
  });
  const ms = Date.now() - t0;
  const output = `${r.stdout ?? ''}\n${r.stderr ?? ''}`;
  writeFileSync(logFile, `$ ${gate.cmd}\n${output}`);

  const code = r.status;
  if (code === 0) {
    results.set(gate.id, { status: 'pass', ms });
    console.log(`[PASS] ${gate.id} (${(ms / 1000).toFixed(1)}s)`);
  } else {
    anyFail = true;
    const why = code === null ? 'spawn error / killed' : `exit ${code}`;
    results.set(gate.id, { status: 'fail', ms, code, why });
    console.log(`[FAIL] ${gate.id} — ${why} (${(ms / 1000).toFixed(1)}s) → ${path.relative('.', logFile)}`);
  }
}

// ── Matrix report ────────────────────────────────────────────────────────
console.log('\n═══ release:check gate matrix ═══');
for (const g of selected) {
  const res = results.get(g.id);
  const tag = res.status.toUpperCase();
  const detail =
    res.status === 'pass'
      ? `${(res.ms / 1000).toFixed(1)}s`
      : res.status === 'skip'
        ? res.reason
        : `${res.why} · ${(res.ms / 1000).toFixed(1)}s`;
  console.log(`  ${tag.padEnd(5)} ${g.id.padEnd(22)} ${detail}`);
}

const failed = selected.filter((g) => results.get(g.id)?.status === 'fail');
if (failed.length > 0 && tail > 0) {
  console.log(`\n── failure tails (last ${tail} lines each) ──`);
  for (const g of failed) {
    // The gate's full output is already on disk in its log file — read the
    // tail back from there rather than keeping every gate's buffer alive.
    const lines = readFileSync(path.join(LOG_DIR, `${g.id}.log`), 'utf8')
      .split(/\r?\n/)
      .filter((l) => l.length > 0);
    console.log(`\n▸ ${g.id}`);
    for (const l of lines.slice(-tail)) console.log(`  ${l}`);
  }
}

const skipped = selected.filter((g) => results.get(g.id)?.status === 'skip');
console.log(
  `\n${failed.length} failed · ${skipped.length} skipped · ${selected.length - failed.length - skipped.length} passed`,
);
if (failed.length > 0) {
  console.log('release:check: FAILED');
  process.exit(1);
}
console.log('release:check: all gates passed');
process.exit(0);
