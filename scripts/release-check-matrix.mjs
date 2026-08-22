/**
 * release:check gate-matrix runner.
 *
 * Why this exists
 * ---------------
 * `pnpm release:check` used to be a single `&&` chain: the first failing
 * gate aborted everything after it, so one broken gate blinded the release
 * to every later problem — fixing gate 3 meant discovering gate 9's failure
 * only after another full 20-minute re-run. This runner executes EVERY
 * gate (except those whose prerequisites failed), streams and records each
 * gate's full output, captures per-gate status and duration, and reports one
 * matrix with failure tails.
 *
 * Semantics
 * ---------
 * - Gates run in the same order as the historical `&&` chain.
 * - A gate whose `prereq` failed is reported as SKIP (running it would be
 *   guaranteed-fail noise: most gates consume workspace `dist/` built by
 *   the `build` gate).
 * - Full stdout+stderr is streamed live to the terminal and also lands in
 *   `.reports/release-check-matrix/<id>.log` (gitignored). The final console
 *   report repeats detected diagnostics plus the last `--tail N` lines
 *   (default 25) of each FAIL.
 * - Exit codes: 0 = all gates PASS (or SKIP-with-reason); 1 = one or more
 *   FAIL; 2 = usage error.
 *
 * Flags
 * -----
 *   --list            print the gate plan (id, command, prereq) and exit
 *   --only a,b,...    run only the named gate ids (comma separated)
 *   --tail N          failure-tail length in the report (default 25)
 *   --profile name    `release` (default, `pnpm release:check`) or `local`
 *                     (`pnpm ci:local` / pre-push). Local is the GitHub CI
 *                     subset that is practical on a laptop: lint, build,
 *                     typecheck, tests, and the snapshot/architecture gates.
 *                     It omits coverage (45m), e2e (Playwright), and audit
 *                     (network). Override the hook with
 *                     WRONGSTACK_PRE_PUSH_PROFILE=release for the full matrix.
 *
 * The runner deliberately does not parse or interpret gate output — it only
 * propagates exit codes. Gate semantics stay owned by each gate script.
 */
import { spawn } from 'node:child_process';
import { createWriteStream, mkdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';

const LOG_DIRS = {
  release: path.resolve('.reports/release-check-matrix'),
  local: path.resolve('.reports/local-ci'),
};
const ANSI_ESCAPE = /\x1b\[[0-?]*[ -/]*[@-~]/g;
const FAILED_TESTS_HEADER = /Failed Tests? \d+/i;
const FAILURE_SUMMARY = /^\s*(?:Test Files|Tests)\s+\d+\s+failed\b/i;
const DIAGNOSTIC_LINE =
  /(?:AssertionError:|TypeError:|ReferenceError:|SyntaxError:|Error:|\bFAIL\b|\bfatal:|coverage threshold|stale architecture evidence|new diagnostics?:|unparsed failures?:)/i;

function stripAnsi(line) {
  return line.replace(ANSI_ESCAPE, '');
}

/**
 * Pull the actionable block out of noisy test output. Vitest writes its
 * failure details to stderr while progress and summaries go to stdout;
 * spawnSync exposes those as separate buffers, so a blind tail of the joined
 * output can contain only later warnings. Keep matching deliberately generic
 * enough for non-Vitest gates while preferring Vitest's explicit failure block.
 */
function failureDiagnosticLines(lines) {
  const plain = lines.map(stripAnsi);
  const selected = new Set();
  const addRange = (from, to) => {
    for (let i = Math.max(0, from); i <= Math.min(lines.length - 1, to); i++) selected.add(i);
  };

  const failedTestsIndex = plain.findIndex((line) => FAILED_TESTS_HEADER.test(line));
  if (failedTestsIndex >= 0) {
    let end = Math.min(lines.length - 1, failedTestsIndex + 60);
    for (let i = failedTestsIndex + 1; i <= end; i++) {
      if (/^\$\s/.test(plain[i]) || /^=== Coverage:/.test(plain[i])) {
        end = i - 1;
        break;
      }
    }
    addRange(failedTestsIndex, end);
  } else {
    const anchors = [];
    for (let i = 0; i < plain.length; i++) {
      if (FAILURE_SUMMARY.test(plain[i]) || DIAGNOSTIC_LINE.test(plain[i])) anchors.push(i);
    }
    // The last diagnostics are normally the final cause rather than an
    // expected error emitted by a negative-path test early in a long run.
    for (const index of anchors.slice(-3)) addRange(index - 2, index + 5);
  }

  // Test summaries are valuable even when the detailed assertion is on the
  // other captured stream.
  for (let i = 0; i < plain.length; i++) {
    if (FAILURE_SUMMARY.test(plain[i])) addRange(i, i + 3);
  }

  return [...selected]
    .sort((a, b) => a - b)
    .map((index) => lines[index])
    .filter((line, index, excerpt) => line.length > 0 || excerpt[index - 1]?.length > 0);
}

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

/**
 * Gates that belong on a laptop pre-push / `pnpm ci:local` but not on the
 * historical release:check chain. Coverage already runs the test suite, so
 * adding a bare `pnpm test` to `release` would double the wall time.
 */
const LOCAL_ONLY_GATES = [
  { id: 'lint', label: 'Biome lint', cmd: 'pnpm lint' },
  {
    id: 'test',
    label: 'Vitest + WebUI tests',
    cmd: 'pnpm test',
    prereq: 'build',
  },
  {
    id: 'hqdash',
    label: 'HQ dashboard tests',
    cmd: 'pnpm --filter @wrongstack/cli test:hqdash',
    prereq: 'build',
  },
  {
    id: 'status-bar',
    label: 'TUI status-bar overflow',
    cmd: 'pnpm --filter @wrongstack/tui test:status-bar',
    prereq: 'build',
  },
];

const PROFILES = {
  release: GATES.map((g) => g.id),
  // Mirrors .github/workflows/ci.yml jobs that a laptop can actually run:
  // lint, typecheck, build, manifests, tests. Omits coverage, e2e, and the
  // artifact-lineage write/verify pair (those exist to shuttle dist/ between
  // GitHub jobs).
  local: [
    'lint',
    'build',
    'dist-hidden',
    'providers-catalog',
    'plugin-manifests',
    'package-contracts',
    'architecture',
    'test-inventory',
    'test-skips',
    'node-pty',
    'rulebook',
    'i18n',
    'typecheck',
    'test-types',
    'test',
    'hqdash',
    'status-bar',
  ],
};

function gatesForProfile(profile) {
  const ids = PROFILES[profile];
  if (!ids) fail(`unknown --profile "${profile}" (supported: ${Object.keys(PROFILES).join(', ')})`);
  const byId = new Map([...GATES, ...LOCAL_ONLY_GATES].map((g) => [g.id, g]));
  return ids.map((id) => {
    const gate = byId.get(id);
    if (!gate) fail(`profile "${profile}" references unknown gate id "${id}"`);
    return gate;
  });
}

function fail(msg) {
  console.error(`release-check-matrix: ${msg}`);
  process.exit(2);
}

/**
 * Run a gate with a live terminal view while retaining the complete logfile.
 * Keeping stdout and stderr as distinct pipes preserves their terminal
 * destinations; both are tee'd into the same per-gate diagnostic log.
 */
async function runGate(command, logFile) {
  const log = createWriteStream(logFile, { encoding: 'utf8' });
  log.write(`$ ${command}\n`);

  const child = spawn(command, {
    shell: true,
    env: { ...process.env },
    stdio: ['inherit', 'pipe', 'pipe'],
  });
  let spawnError = null;

  child.stdout.on('data', (chunk) => {
    process.stdout.write(chunk);
    log.write(chunk);
  });
  child.stderr.on('data', (chunk) => {
    process.stderr.write(chunk);
    log.write(chunk);
  });

  const { code, signal } = await new Promise((resolve) => {
    child.once('error', (error) => {
      spawnError = error;
      const message = `release-check-matrix: failed to spawn ${command}: ${error.message}\n`;
      process.stderr.write(message);
      log.write(message);
    });
    child.once('close', (code, signal) => resolve({ code, signal }));
  });
  await new Promise((resolve) => log.end(resolve));

  return { status: code, signal, error: spawnError };
}

const args = process.argv.slice(2);
let tail = 25;
let listOnly = false;
let only = null;
let profile = 'release';
for (let i = 0; i < args.length; i++) {
  const a = args[i];
  if (a === '--list') listOnly = true;
  else if (a === '--tail') {
    const v = Number.parseInt(args[++i] ?? '', 10);
    if (Number.isNaN(v) || v < 0) fail(`--tail expects a non-negative integer (got ${args[i]})`);
    tail = v;
  } else if (a === '--profile') {
    const raw = args[++i];
    if (!raw) fail('--profile expects a name (release | local)');
    profile = raw;
  } else if (a === '--only') {
    const raw = args[++i];
    if (!raw) fail('--only expects a comma-separated gate id list');
    only = new Set(
      raw
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean),
    );
  } else fail(`unknown flag "${a}" (supported: --list, --only <ids>, --tail <n>, --profile <name>)`);
}

const profileGates = gatesForProfile(profile);
const known = new Set(profileGates.map((g) => g.id));
if (only) {
  for (const id of only) {
    if (!known.has(id)) fail(`unknown gate id "${id}" for --profile ${profile} (use --list)`);
  }
}

const title = profile === 'local' ? 'local CI' : 'release:check';
const LOG_DIR = LOG_DIRS[profile] ?? LOG_DIRS.release;

if (listOnly) {
  console.log(`${title} gate matrix — plan (--profile ${profile})`);
  for (const g of profileGates) {
    console.log(
      `  ${g.id.padEnd(22)} ${g.prereq ? `[after ${g.prereq}] ` : '[standalone]   '} ${g.cmd}`,
    );
  }
  process.exit(0);
}

const selected = only ? profileGates.filter((g) => only.has(g.id)) : profileGates;
const results = new Map(); // id -> { status, ms, code }
mkdirSync(LOG_DIR, { recursive: true });

console.log(`${title} gate matrix — running ${selected.length} gate(s)\n`);

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
  // shell: true inside runGate resolves pnpm.cmd / pnpm on Windows the same
  // way a package.json script line would. Output is shown live and tee'd to
  // the per-gate logfile without a fixed-size capture buffer.
  const r = await runGate(gate.cmd, logFile);
  const ms = Date.now() - t0;

  const code = r.status;
  if (code === 0) {
    results.set(gate.id, { status: 'pass', ms });
    console.log(`[PASS] ${gate.id} (${(ms / 1000).toFixed(1)}s)`);
  } else {
    const why =
      code === null
        ? r.error
          ? `spawn error: ${r.error.message}`
          : `killed${r.signal ? ` by ${r.signal}` : ''}`
        : `exit ${code}`;
    results.set(gate.id, { status: 'fail', ms, code, why });
    console.log(
      `[FAIL] ${gate.id} — ${why} (${(ms / 1000).toFixed(1)}s) → ${path.relative('.', logFile)}`,
    );
  }
}

// ── Matrix report ────────────────────────────────────────────────────────
console.log(`\n═══ ${title} gate matrix ═══`);
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
  console.log('\n── failure diagnostics ──');
  for (const g of failed) {
    const lines = readFileSync(path.join(LOG_DIR, `${g.id}.log`), 'utf8')
      .split(/\r?\n/)
      .filter((l) => l.length > 0);
    console.log(`\n▸ ${g.id}`);
    const diagnostics = failureDiagnosticLines(lines);
    if (diagnostics.length > 0) {
      for (const l of diagnostics) console.log(`  ${l}`);
      console.log(`  -- last ${tail} log lines --`);
    }
    for (const l of lines.slice(-tail)) console.log(`  ${l}`);
  }
}

const skipped = selected.filter((g) => results.get(g.id)?.status === 'skip');
console.log(
  `\n${failed.length} failed · ${skipped.length} skipped · ${selected.length - failed.length - skipped.length} passed`,
);
if (failed.length > 0) {
  console.log(`${title}: FAILED`);
  process.exit(1);
}
console.log(`${title}: all gates passed`);
process.exit(0);
