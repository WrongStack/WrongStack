/**
 * File-size gate for source files.
 *
 * Scans `packages/` and `apps/` recursively for `.ts` files that
 * exceed a soft cap (default 350 lines) and prints a sorted report.
 *
 * Rationale: large files correlate with poor cohesion and harder code
 * review. 350 lines is the current soft cap (dropped from 400 in
 * 2026-06-10 after the TUI/Director hook extractions landed). Files
 * over the cap are now flagged for review at PR time. The 4 files
 * >2000 lines (tui/app.tsx, webui/server/index.ts, cli/webui-server.ts,
 * cli/cli-main.ts) are now all tracked, with sequenced plans under
 * `docs/archive/work-items/issues/`. See the preserved historical notes for
 * the original extraction plans; they are not active work tracking.
 *
 * This script **never fails CI** — it's a review nudge. New files over
 * the cap should be flagged in PRs but not block merging. Combine with
 * the package's own refactor planning to decide when to split.
 *
 * Usage:
 *   node scripts/check-file-size.mjs           # default cap (350)
 *   node scripts/check-file-size.mjs --cap 300
 *   node scripts/check-file-size.mjs --strict # exit 1 if any file over cap
 */

import { readFileSync } from 'node:fs';
import { readdir } from 'node:fs/promises';
import { extname, join, relative } from 'node:path';

// 2026-06-10: cap dropped from 400 → 350 to prevent regression after the
// TUI app.tsx → 6 hook extractions and director.ts → director-construction
// extraction. New files should be ≤ 350 unless there's a strong reason
// (e.g. a generated file or a tightly-coupled module that resists
// decomposition).
const DEFAULT_CAP = 350;
const SOURCE_EXTS = new Set(['.ts', '.tsx']);
const ROOTS = ['packages', 'apps'];
const IGNORE = new Set(['node_modules', 'dist', 'coverage', '.git']);

// Parse args
const args = process.argv.slice(2);
let cap = DEFAULT_CAP;
let strict = false;
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--cap' && i + 1 < args.length) {
    const n = Number(args[i + 1]);
    if (!Number.isFinite(n) || n < 1) {
      console.error(`Invalid --cap value: ${args[i + 1]}`);
      process.exit(2);
    }
    cap = n;
    i++;
  } else if (args[i] === '--strict') {
    strict = true;
  } else {
    console.error(`Unknown arg: ${args[i]}`);
    process.exit(2);
  }
}

async function walk(dir, files) {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return files; // skip unreadable dirs
  }
  for (const e of entries) {
    if (IGNORE.has(e.name)) continue;
    const full = join(dir, e.name);
    if (e.isDirectory()) {
      await walk(full, files);
    } else if (SOURCE_EXTS.has(extname(e.name))) {
      files.push(full);
    }
  }
  return files;
}

async function main() {
  // Collect source files.
  const fileLists = await Promise.all(ROOTS.map((r) => walk(r, [])));
  const files = fileLists.flat();

  const offenders = [];
  for (const file of files) {
    const text = readFileSync(file, 'utf8');
    const lines = text.split('\n').length;
    if (lines > cap) {
      offenders.push({ file, lines });
    }
  }

  // Sort: largest first.
  offenders.sort((a, b) => b.lines - a.lines);

  if (offenders.length === 0) {
    console.log(`✅ All source files under ${cap} lines.`);
    return;
  }

  console.log(`⚠️  ${offenders.length} source file(s) exceed the soft cap of ${cap} lines:\n`);
  for (const o of offenders) {
    const rel = relative(process.cwd(), o.file).replaceAll('\\', '/');
    const headroom = o.lines - cap;
    console.log(`   ${String(o.lines).padStart(5)}  +${String(headroom).padStart(4)}  ${rel}`);
  }
  console.log(`
📋 Recommended actions:
   - Files 500–800 lines: review in next refactor pass; split if cohesion is loose.
   - Files 800+ lines: prioritize for decomposition (god class smell).
   - Always prefer splitting along cohesive boundaries (data, transport, scheduling,
     observability) over arbitrary line splits.

This check never fails CI on its own (advisory only).
${strict ? '\n🚨 --strict mode: exiting with code 1.' : ''}
`);

  if (strict) process.exit(1);
}

main().catch((err) => {
  console.error('check-file-size.mjs failed:', err);
  process.exit(1);
});
