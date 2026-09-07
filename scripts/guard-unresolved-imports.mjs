#!/usr/bin/env node
/**
 * Pre-commit guard: every relative import in a staged TypeScript file must
 * resolve to a file that will exist in the commit (i.e. is in the git index).
 *
 * Catches the "import committed, file forgotten" class of breakage: a new
 * module is created on disk, another file imports it, the importer is staged
 * and committed — but the new module stays untracked. Local builds pass
 * (the file exists on disk); CI fails at Build with esbuild
 * "Could not resolve". This burned every CI run after 9290b3b14 shipped an
 * import of ./security/permission-policy-schema.js without the module.
 *
 *   node scripts/guard-unresolved-imports.mjs [--verbose]
 *
 * Only staged .ts/.tsx/.mts/.cts files are scanned, and specifiers are read
 * from the STAGED blob (git show :path), not the working tree. Bare and
 * aliased specifiers (@wrongstack/*, node:*, npm packages) are ignored —
 * those are the package manager's problem, not the index's.
 *
 * A specifier is flagged ONLY when it resolves to a file that exists on
 * DISK but is missing from the index — the silent case local builds hide.
 * Specifiers that resolve nowhere at all (test-fixture strings, template
 * placeholders, type-only imports in untypechecked tests) are ignored:
 * they either aren't real imports or already fail loudly in local builds.
 *
 * Targets that git itself ignores (dist/, build/ — compiler output produced
 * by `pnpm build`) are ignored too. They are absent from the index BY DESIGN,
 * not by forgetfulness, so flagging them only trains people to --no-verify,
 * which skips every other pre-commit guard as collateral.
 */
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';

const VERBOSE = process.argv.includes('--verbose') || process.argv.includes('-v');
const TS_EXTS = new Set(['.ts', '.tsx', '.mts', '.cts']);

function log(...args) {
  if (VERBOSE) console.error('[guard-imports]', ...args);
}

function git(args, input) {
  return execFileSync('git', args, {
    encoding: 'utf-8',
    input,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
}

/**
 * Subset of `paths` that git ignores — build output, not forgotten sources.
 * One batched call; check-ignore exits 1 when nothing matches, which is a
 * normal answer here, not a failure.
 */
function ignoredPaths(paths) {
  if (paths.length === 0) return new Set();
  try {
    const out = git(['check-ignore', '-z', '--stdin'], paths.join('\0'));
    return new Set(out.split('\0').filter(Boolean));
  } catch {
    return new Set();
  }
}

function getStagedTsFiles() {
  try {
    return git(['diff', '--cached', '--name-only', '--diff-filter=ACMR'])
      .trim()
      .split('\n')
      .filter(Boolean)
      .filter((f) => TS_EXTS.has(path.posix.extname(f)));
  } catch {
    return [];
  }
}

/** Set of every path in the index — what the commit will contain. */
function getIndexPaths() {
  const out = git(['ls-files', '-z']);
  return new Set(out.split('\0').filter(Boolean));
}

/** Extract relative specifiers from import/export/require/dynamic-import. */
function relativeSpecifiers(source) {
  const specs = [];
  const re =
    /(?:\bfrom\s*|\bimport\s*\(\s*|\brequire\s*\(\s*|\bimport\s+)(['"])(\.{1,2}\/[^'"]+)\1/g;
  for (const match of source.matchAll(re)) {
    specs.push(match[2]);
  }
  return specs;
}

/**
 * Candidate index paths a NodeNext-style relative specifier may resolve to.
 * `./foo.js` in TS source maps to foo.ts/foo.tsx on disk (and foo.js for
 * checked-in JS); likewise .mjs->.mts, .cjs->.cts. Extensionless specifiers
 * and directory imports get the usual ladder.
 */
function candidatesFor(resolved) {
  const out = [resolved];
  const swap = { '.js': ['.ts', '.tsx', '.d.ts'], '.mjs': ['.mts'], '.cjs': ['.cts'] };
  const ext = path.posix.extname(resolved);
  if (swap[ext]) {
    const stem = resolved.slice(0, -ext.length);
    for (const e of swap[ext]) out.push(stem + e);
  } else if (!ext || !['.ts', '.tsx', '.mts', '.cts', '.json', '.css'].includes(ext)) {
    for (const e of ['.ts', '.tsx', '.js', '.mts', '.d.ts']) out.push(resolved + e);
    for (const e of ['.ts', '.tsx', '.js']) out.push(resolved + '/index' + e);
  }
  return out;
}

function main() {
  const staged = getStagedTsFiles();
  log('Staged TS files: ' + staged.length);
  if (staged.length === 0) {
    log('Nothing to check.');
    return 0;
  }
  const index = getIndexPaths();
  const findings = [];

  for (const file of staged) {
    let source;
    try {
      source = git(['show', ':' + file]);
    } catch {
      continue; // racy unstage — nothing to validate
    }
    const dir = path.posix.dirname(file);
    for (const spec of relativeSpecifiers(source)) {
      const resolved = path.posix.normalize(path.posix.join(dir, spec));
      const candidates = candidatesFor(resolved);
      if (candidates.some((c) => index.has(c))) continue; // will be in the commit
      const onDisk = candidates.find((c) => existsSync(c));
      if (onDisk) findings.push({ file, spec, onDisk });
    }
  }

  const ignored = ignoredPaths([...new Set(findings.map((f) => f.onDisk))]);
  const flagged = findings.filter((f) => !ignored.has(f.onDisk));
  if (ignored.size > 0) log('Skipped ' + ignored.size + ' git-ignored build-output target(s).');

  if (flagged.length > 0) {
    console.error('');
    console.error('============================================================');
    console.error('  BLOCKED  --  UNRESOLVED RELATIVE IMPORT IN STAGED FILE');
    console.error('============================================================');
    console.error('  These imports resolve to files that exist on disk but are');
    console.error('  NOT tracked/staged. The commit builds locally but breaks CI');
    console.error('  (esbuild "Could not resolve"). Stage the missing file too:');
    console.error('');
    for (const { file, spec, onDisk } of flagged.slice(0, 20)) {
      console.error('  ' + file);
      console.error("    -> imports '" + spec + "'  (git add " + onDisk + ')');
    }
    if (flagged.length > 20) console.error('  ... and ' + (flagged.length - 20) + ' more.');
    console.error('');
    console.error('  If the target genuinely ships outside git, add it to');
    console.error('  .gitignore (git-ignored targets are skipped), or bypass');
    console.error('  once with: git commit --no-verify');
    console.error('============================================================');
    return 1;
  }

  log('All relative imports resolve within the index.');
  return 0;
}

process.exit(main());
