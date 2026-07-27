#!/usr/bin/env node

/**
 * One-time SAGE memory maintenance: recover-then-purge.
 * ---------------------------------------------------------------------------
 * Cleans up the fallout from the 2026-07 mass-deletion regression, where an
 * unsupervised consolidator/custodian soft-deleted the entire memory store
 * (e.g. 861/861 records status=deleted). Because JSONL deletion is a soft
 * tombstone, those records still sit in memories.jsonl forever.
 *
 * This script runs the two safe, ordered steps:
 *
 *   1. BACKFILL  — by default select a refined, canonical-deduplicated subset
 *      of durable/high-signal deleted memory, then create fresh ACTIVE versions
 *      linked to the originals via `supersedes`.
 *      The original tombstone stays deleted (immutable audit trail). This is
 *      how genuinely-useful memories come back.  [store.backfillRecoverable]
 *
 *   2. PURGE     — physically compact out of the JSONL log every tombstone that
 *      is still status=deleted, older than --purge-days, NOT permanent, and NOT
 *      referenced by a recovered memory's supersedes chain. This is the only
 *      step that drops records.  [store.hygiene({ purgeDeletedAfterDays })]
 *
 * SAFETY
 *   • Dry-run by DEFAULT. Nothing is written unless you pass --apply.
 *   • Backfill never deletes; purge never touches active/permanent/recovered.
 *   • A timestamped backup of memories.jsonl is written before any --apply write.
 *
 * REQUIREMENT
 *   The purge step needs the `purgeDeletedAfterDays` hygiene option, which ships
 *   in @wrongstack/sage >= the build that added it. Build first:
 *       pnpm --filter @wrongstack/sage build
 *   The script verifies the option is present and aborts with guidance if not.
 *
 * USAGE
 *   node scripts/sage-maintenance.mjs [options]
 *
 *   --project <path>     Project root containing .wrongstack/ (default: cwd)
 *   --purge-days <N>     Purge tombstones deleted more than N days ago (default: 30)
 *   --apply              Actually write changes (default: dry-run)
 *   --all-recoverable    Disable refined selection and restore every eligible tombstone
 *   --no-backfill        Skip the recovery step (purge only)
 *   --no-purge           Skip the purge step (backfill only)
 *   -h, --help           Show this help
 *
 * EXAMPLES
 *   node scripts/sage-maintenance.mjs                 # dry-run report, cwd
 *   node scripts/sage-maintenance.mjs --apply         # recover + purge >30d
 *   node scripts/sage-maintenance.mjs --purge-days 90 --apply
 *   node scripts/sage-maintenance.mjs --no-purge --apply   # recover only
 */

import * as fs from 'node:fs';
import { createRequire } from 'node:module';
import * as path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ── Arg parsing ────────────────────────────────────────────────────────────
function parseArgs(argv) {
  const opts = {
    project: process.cwd(),
    purgeDays: 30,
    apply: false,
    backfill: true,
    refined: true,
    purge: true,
    help: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    switch (a) {
      case '--project':
        opts.project = argv[++i];
        break;
      case '--purge-days':
        opts.purgeDays = Number(argv[++i]);
        break;
      case '--apply':
        opts.apply = true;
        break;
      case '--all-recoverable':
        opts.refined = false;
        break;
      case '--no-backfill':
        opts.backfill = false;
        break;
      case '--no-purge':
        opts.purge = false;
        break;
      case '-h':
      case '--help':
        opts.help = true;
        break;
      default:
        console.error(`Unknown argument: ${a}`);
        process.exit(2);
    }
  }
  return opts;
}

function printHelp() {
  // The leading banner comment doubles as the help text.
  const src = fs.readFileSync(new URL(import.meta.url), 'utf8');
  const banner = src.slice(src.indexOf('/**'), src.indexOf('*/') + 2);
  console.log(banner.replace(/^\/\*\*?|\*\/$/g, '').replace(/^ \* ?/gm, ''));
}

// ── Resolve the built SAGE store ───────────────────────────────────────────
async function loadSageModule() {
  // Repo root is one level up from scripts/. The package builds to dist/index.js.
  const repoRoot = path.resolve(__dirname, '..');
  const distPath = path.join(repoRoot, 'packages', 'sage', 'dist', 'index.js');
  const candidates = [
    // 1) Resolve by package name (works when workspace symlinks are on the path).
    () => require('@wrongstack/sage'),
    // 2) Fall back to the built dist by absolute file URL.
    async () => await import(pathToFileURL(distPath).href),
  ];
  let lastErr;
  for (const load of candidates) {
    try {
      const mod = await load();
      if (mod?.SqliteSageStore) return mod;
      lastErr = new Error('SqliteSageStore export missing');
    } catch (err) {
      lastErr = err;
    }
  }
  console.error(
    '\nCould not load @wrongstack/sage from dist.\n' +
      'Build it first:\n    pnpm --filter @wrongstack/sage build\n\n' +
      `Underlying error: ${lastErr?.message ?? lastErr}`,
  );
  process.exit(1);
}

function num(n) {
  return typeof n === 'number' && Number.isFinite(n) ? n : 0;
}

function canonicalMemoryText(text) {
  return String(text ?? '')
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[.!?,;:]+$/u, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Pick useful long-lived records without blindly re-activating task chatter.
 * The policy intentionally combines metadata quality with entity grounding:
 * durable kinds survive at medium+ importance; facts need high importance;
 * anchored records get a lower threshold because retrieval has a stable key.
 */
function selectRefinedRecoveryIds(memoriesLog) {
  const latest = new Map();
  for (const line of fs.readFileSync(memoriesLog, 'utf8').split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      const record = JSON.parse(line);
      if (record?.recordType === 'memory' && record.memory?.id) {
        latest.set(record.memory.id, record.memory);
      }
    } catch {
      // The store will audit malformed records. Recovery selection ignores them.
    }
  }

  const durableKinds = new Set([
    'decision',
    'convention',
    'preference',
    'warning',
    'anti_pattern',
    'workflow',
    'bug_root_cause',
    'file_note',
    'symbol_note',
    'command_note',
  ]);
  const activeText = new Set(
    [...latest.values()]
      .filter((memory) => memory.status === 'active')
      .map((memory) => canonicalMemoryText(memory.text)),
  );
  const selectedByText = new Map();
  for (const memory of latest.values()) {
    if (memory.status !== 'deleted') continue;
    if (['summary', 'memory_review'].includes(memory.kind)) continue;
    if ((memory.persistence ?? 'long_lived') === 'short_lived') continue;
    if (!memory.text?.trim()) continue;
    const importance = Number(memory.importance) || 0;
    const confidence = Number(memory.confidence) || 0;
    const anchored = (memory.anchors?.length ?? 0) > 0;
    const highSignal =
      memory.persistence === 'permanent' ||
      (durableKinds.has(memory.kind) && importance >= 0.55 && confidence >= 0.75) ||
      (memory.kind === 'fact' && importance >= 0.8 && confidence >= 0.8) ||
      (anchored && importance >= 0.4 && confidence >= 0.7);
    if (!highSignal) continue;

    const key = canonicalMemoryText(memory.text);
    if (!key || activeText.has(key)) continue;
    const existing = selectedByText.get(key);
    if (
      !existing ||
      importance > existing.importance ||
      (importance === existing.importance && confidence > existing.confidence) ||
      (importance === existing.importance &&
        confidence === existing.confidence &&
        memory.updatedAt > existing.updatedAt)
    ) {
      selectedByText.set(key, memory);
    }
  }
  return [...selectedByText.values()].map((memory) => memory.id);
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help) {
    printHelp();
    return;
  }

  if (!Number.isFinite(opts.purgeDays) || opts.purgeDays <= 0) {
    console.error('--purge-days must be a positive number.');
    process.exit(2);
  }

  const projectRoot = path.resolve(opts.project);
  const memoriesLog = path.join(projectRoot, '.wrongstack', 'memories', 'memories.jsonl');
  if (!fs.existsSync(memoriesLog)) {
    console.error(
      `No JSONL memory store found at:\n  ${memoriesLog}\n` +
        'Point --project at a directory containing .wrongstack/memories/memories.jsonl.',
    );
    process.exit(1);
  }

  const sageModule = await loadSageModule();
  if (sageModule.SageProjectServerConnection) {
    const server = new sageModule.SageProjectServerConnection(projectRoot);
    const running = await server.status();
    server.close();
    if (running) {
      console.error(
        `SAGE project server is running (pid ${running.pid}).\n` +
          'Stop every WrongStack host for this project before using the offline maintenance tool.',
      );
      process.exit(1);
    }
  }
  const SageStore = sageModule.SqliteSageStore;
  const store = new SageStore({ projectRoot });

  const mode = opts.apply ? 'APPLY (writes enabled)' : 'DRY-RUN (no writes)';
  console.log('══════════════════════════════════════════════════════════════');
  console.log(' SAGE memory maintenance — recover then purge');
  console.log('══════════════════════════════════════════════════════════════');
  console.log(`  Project:    ${projectRoot}`);
  console.log(`  Store:      ${memoriesLog}`);
  console.log(`  Mode:       ${mode}`);
  console.log(`  Purge days: ${opts.purgeDays}`);
  console.log(`  Steps:      ${opts.backfill ? 'backfill' : '-'} → ${opts.purge ? 'purge' : '-'}`);
  console.log(
    `  Recovery:   ${opts.refined ? 'refined + canonical-deduplicated' : 'ALL recoverable'}`,
  );
  console.log('');

  // ── Initial state ────────────────────────────────────────────────────────
  const statsBefore = await store.stats();
  const byStatus = statsBefore.byStatus ?? {};
  console.log('Current store state:');
  console.log(`  total:      ${statsBefore.total}`);
  console.log(`  active:     ${num(byStatus.active)}`);
  console.log(`  deleted:    ${num(byStatus.deleted)}`);
  console.log(`  archived:   ${num(byStatus.archived)}`);
  console.log(`  superseded: ${num(byStatus.superseded)}`);
  console.log('');

  if (num(byStatus.deleted) === 0) {
    console.log('No deleted memories — nothing to do. ✅');
    return;
  }

  // ── Backup before any write ──────────────────────────────────────────────
  if (opts.apply) {
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const backup = `${memoriesLog}.backup-${stamp}`;
    fs.copyFileSync(memoriesLog, backup);
    console.log(`Backup written: ${backup}\n`);
  }

  // ── Step 1: backfill recoverable ─────────────────────────────────────────
  if (opts.backfill) {
    const refinedIds = opts.refined ? selectRefinedRecoveryIds(memoriesLog) : undefined;
    const report = await store.backfillRecoverable({
      dryRun: !opts.apply,
      ...(refinedIds ? { filter: { ids: refinedIds } } : {}),
    });
    console.log('Step 1 — BACKFILL (recover recoverable deleted memories):');
    if (refinedIds) console.log(`  refined set: ${refinedIds.length}`);
    console.log(`  examined:    ${report.examined}`);
    console.log(`  recoverable: ${report.recoverable}`);
    console.log(`  recovered:   ${report.recovered}${opts.apply ? '' : ' (would recover)'}`);
    console.log(`  skipped:     ${report.skipped}`);
    if (report.byReason && Object.keys(report.byReason).length > 0) {
      console.log(`  skip reasons: ${JSON.stringify(report.byReason)}`);
    }
    console.log('');
  } else {
    console.log('Step 1 — BACKFILL: skipped (--no-backfill)\n');
  }

  // ── Step 2: purge old tombstones ─────────────────────────────────────────
  if (opts.purge) {
    if (!opts.apply) {
      // Dry-run: we can't safely execute hygiene's write path, so estimate how
      // many tombstones WOULD be purged using the same predicate the store uses.
      const estimate = await estimatePurge(memoriesLog, opts.purgeDays);
      console.log('Step 2 — PURGE (physically drop old, unreferenced tombstones):');
      console.log(
        `  eligible:  ${estimate.eligible} (deleted > ${opts.purgeDays}d, non-permanent, not recovered)`,
      );
      console.log(
        `  protected: ${estimate.permanent} permanent, ${estimate.referenced} recovered/referenced, ${estimate.tooRecent} too recent`,
      );
      console.log('  (would purge on --apply)\n');
    } else {
      let report;
      try {
        report = await store.hygiene({ verify: false, purgeDeletedAfterDays: opts.purgeDays });
      } catch (err) {
        console.error(`Purge failed: ${err.message}`);
        process.exit(1);
      }
      if (typeof report.purgedDeleted !== 'number') {
        console.error(
          '\nThis build of @wrongstack/sage does not support purgeDeletedAfterDays.\n' +
            'Rebuild it:  pnpm --filter @wrongstack/sage build\n',
        );
        process.exit(1);
      }
      console.log('Step 2 — PURGE (physically drop old, unreferenced tombstones):');
      console.log(`  purged:    ${report.purgedDeleted}`);
      console.log('');
    }
  } else {
    console.log('Step 2 — PURGE: skipped (--no-purge)\n');
  }

  // ── Final state ──────────────────────────────────────────────────────────
  const statsAfter = await store.stats();
  const afterStatus = statsAfter.byStatus ?? {};
  console.log('Resulting store state:');
  console.log(`  total:   ${statsAfter.total}`);
  console.log(`  active:  ${num(afterStatus.active)}`);
  console.log(`  deleted: ${num(afterStatus.deleted)}`);
  console.log('');
  if (!opts.apply) {
    console.log('Dry-run complete — no changes were written. Re-run with --apply to execute.');
  } else {
    console.log('Maintenance complete. ✅');
  }
}

/**
 * Dry-run estimator that mirrors purgeDeletedRecordsUnlocked's predicate by
 * reading memories.jsonl directly (so we don't need to execute the store's
 * write path). Latest-record-per-id, deleted + old + non-permanent + not
 * referenced by a live memory's supersedes chain.
 */
async function estimatePurge(memoriesLog, purgeDays) {
  const cutoffMs = Date.now() - purgeDays * 86_400_000;
  const lines = fs.readFileSync(memoriesLog, 'utf8').split('\n').filter(Boolean);
  const latest = new Map();
  for (const line of lines) {
    let rec;
    try {
      rec = JSON.parse(line);
    } catch {
      continue;
    }
    if (rec?.recordType !== 'memory' || !rec.memory?.id) continue;
    const m = rec.memory;
    const cur = latest.get(m.id);
    if (!cur || m.revision > cur.revision) latest.set(m.id, m);
    else if (m.revision === cur.revision && cur.status === 'deleted' && m.status !== 'deleted') {
      latest.set(m.id, m);
    }
  }

  const referenced = new Set();
  for (const m of latest.values()) {
    if (m.status === 'deleted') continue;
    for (const id of m.supersedes ?? []) referenced.add(id);
  }

  let eligible = 0,
    permanent = 0,
    referencedCount = 0,
    tooRecent = 0;
  for (const [id, m] of latest) {
    if (m.status !== 'deleted') continue;
    if ((m.persistence ?? 'long_lived') === 'permanent') {
      permanent++;
      continue;
    }
    if (referenced.has(id)) {
      referencedCount++;
      continue;
    }
    const deletedAtMs = Date.parse(m.updatedAt);
    if (Number.isNaN(deletedAtMs) || deletedAtMs > cutoffMs) {
      tooRecent++;
      continue;
    }
    eligible++;
  }
  return { eligible, permanent, referenced: referencedCount, tooRecent };
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
