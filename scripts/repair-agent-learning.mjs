#!/usr/bin/env node
/**
 * One-shot repair for `.wrongstack/agents/<role>/learned.md` buffers written by
 * the pre-fix renderer.
 *
 * Two defects are healed:
 *   1. Nested `- *How:*   - *How:* …` labels that compounded on every capture.
 *   2. `.json` anchors truncated to `.js` by the old extension alternation.
 *
 * Legacy (pre-structured) buffers are migrated to the structured format in the
 * same pass — they could not migrate on their own, because migration only
 * happened on capture and capture was blocked for exactly those oversized
 * files.
 *
 * Usage: node scripts/repair-agent-learning.mjs [--dry] [projectRoot]
 */
import { mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const args = process.argv.slice(2);
const dryRun = args.includes('--dry');
const projectRoot = path.resolve(args.find((a) => !a.startsWith('--')) ?? process.cwd());

// Imported by path rather than by package name: this script is run from a repo
// checkout (`node scripts/…`), where the workspace symlink for
// `@wrongstack/core` is not on the resolution path.
const coreDist = pathToFileURL(
  path.join(
    path.dirname(fileURLToPath(import.meta.url)),
    '..',
    'packages',
    'core',
    'dist',
    'coordination',
    'agents',
    'index.js',
  ),
).href;
const {
  enforceLearnedBudget,
  LEARNED_SOFT_LIMIT,
  parseStructuredLearnedEntriesFromContent,
  renderLearnedInstructions,
  splitLearnedEntries,
} = await import(coreDist);

const agentsDir = path.join(projectRoot, '.wrongstack', 'agents');
let roles = [];
try {
  roles = readdirSync(agentsDir).filter((name) =>
    statSync(path.join(agentsDir, name), { throwIfNoEntry: false })?.isDirectory(),
  );
} catch {
  console.error(`No agents directory at ${agentsDir}`);
  process.exit(1);
}

const runStamp = new Date().toISOString().replace(/[:.]/g, '-');
let repaired = 0;
for (const role of roles) {
  const file = path.join(agentsDir, role, 'learned.md');
  let raw;
  try {
    raw = readFileSync(file, 'utf8');
  } catch {
    continue;
  }
  const entries = parseStructuredLearnedEntriesFromContent(raw, splitLearnedEntries(raw));
  if (entries.length === 0) {
    console.log(`  ${role.padEnd(20)} no parsable directives — left untouched`);
    continue;
  }
  // `.json` anchors truncated to `.js` are recovered by re-deriving the anchor
  // from the directive text, which still holds the full path.
  const fixed = entries.map((entry) => ({
    ...entry,
    how: entry.how
      .split('\n')
      .map((line) => {
        const bare = line.replace(/`/g, '');
        if (!bare.endsWith('.js')) return line;
        const full = `${bare}on`;
        return entry.what.includes(full) ? `\`${full}\`` : line;
      })
      .join('\n'),
  }));
  const stamp = fixed[0]?.capturedAt || new Date().toISOString();
  // Converting a legacy journal to the structured form adds a Why line per
  // entry, so a file that was already oversized can grow. Apply the same
  // budget the runtime applies on capture.
  const { kept, dropped } = enforceLearnedBudget(fixed, stamp, LEARNED_SOFT_LIMIT, role);
  const next = renderLearnedInstructions(role, kept, stamp);
  if (next === raw) {
    console.log(`  ${role.padEnd(20)} already clean (${entries.length} directives)`);
    continue;
  }
  const nestedBefore = (raw.match(/How:\*\s+-\s+\*How/g) ?? []).length;
  console.log(
    `  ${role.padEnd(20)} ${entries.length} directives · ${raw.length}B → ${next.length}B` +
      (nestedBefore ? ` · ${nestedBefore} nested How label(s) removed` : '') +
      (dropped.length ? ` · ${dropped.length} over-budget entr(ies) evicted` : ''),
  );
  if (!dryRun) {
    // Never rewrite in place without keeping the original: converting a legacy
    // journal can evict entries the budget cannot fit, and those directives
    // should stay recoverable (and re-optimizable) rather than vanish.
    const archiveDir = path.join(agentsDir, role, 'archive');
    mkdirSync(archiveDir, { recursive: true });
    writeFileSync(path.join(archiveDir, `learned-pre-repair-${runStamp}.md`), raw, 'utf8');
    writeFileSync(file, next, 'utf8');
  }
  repaired++;
}

console.log(
  dryRun ? `\nDry run: ${repaired} file(s) would be rewritten.` : `\nRepaired ${repaired} file(s).`,
);
