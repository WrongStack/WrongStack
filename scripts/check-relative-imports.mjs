#!/usr/bin/env node
/**
 * check-relative-imports.mjs
 *
 * Fails CI when a TypeScript file imports a path that climbs one directory
 * and descends back into a directory of the SAME name as the file's
 * immediate parent. That is the precise signature of a leftover relative
 * path after a file was moved into a subdirectory:
 *
 *   // packages/core/src/coordination/collab-pause.ts
 *   import './collab-bus.js';                  // ✓ correct
 *   import '../coordination/collab-bus.js';    // ✗ climbs out and back in
 *
 * It does NOT flag legitimate cross-area siblings:
 *
 *   // packages/core/src/coordination/foo.ts
 *   import '../session-catalog/foo.js';        // ✓ sibling area under src/
 *   import '../utils/pid.js';                  // ✓ sibling utility under src/
 *
 * Nor does it flag the vitest `tests/ -> ../src/` convention.
 *
 * Wired into `pnpm lint:imports` and the `lint` job of `.github/workflows/ci.yml`.
 */
import { execSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join, relative } from 'node:path';

const REPO_ROOT = process.cwd();

/** Match `from '../<segment>/...'` only. */
const BAD_IMPORT = /from\s+['"]\.\.\/([a-zA-Z0-9_-]+)\//g;

/**
 * Directories where this gate's premise does not apply (cross-area
 * siblings are common and intentional).
 */
const ALLOWLIST_DIR_PREFIXES = ['apps/desktop/', 'apps/wrongstack/', 'scripts/'];

/**
 * Allow specific known-good `../<sibling>/` imports that happen to match
 * the pattern but are correct. Empty by default; populate with rationale
 * comments if a true positive is found to be unavoidable.
 */
const ALLOWLIST_IMPORTS = new Set([
  // e.g. '../wiring/foo' — add with comment if a layout genuinely needs it
]);

function listTsFiles() {
  const out = execSync('git ls-files -z --cached --others --exclude-standard', {
    cwd: REPO_ROOT,
    encoding: 'buffer',
  });
  return out
    .toString('utf8')
    .split('\0')
    .filter((p) => p.endsWith('.ts') || p.endsWith('.tsx'))
    .filter((p) => !p.startsWith('node_modules/'))
    .filter((p) => !p.includes('/node_modules/'))
    .filter((p) => !p.includes('/dist/'))
    .filter((p) => !p.startsWith('.reports/'))
    .filter((p) => !p.includes('/.reports/'));
}

function isAllowlisted(relPath) {
  if (ALLOWLIST_DIR_PREFIXES.some((p) => relPath.startsWith(p))) return true;
  return false;
}

function shouldFlag(relPath, segment) {
  // The smell: file is at .../<parent>/<file>.ts and imports '../<parent>/...'
  const parts = relPath.split('/');
  // Drop the filename (last element).
  const dirParts = parts.slice(0, -1);
  if (dirParts.length === 0) return false;
  const parent = dirParts[dirParts.length - 1];
  return parent === segment;
}

function main() {
  const files = listTsFiles();
  const offenders = [];

  for (const file of files) {
    if (isAllowlisted(file)) continue;

    const abs = join(REPO_ROOT, file);
    let content;
    try {
      content = readFileSync(abs, 'utf8');
    } catch {
      continue;
    }

    let m;
    BAD_IMPORT.lastIndex = 0;
    while ((m = BAD_IMPORT.exec(content)) !== null) {
      const segment = m[1];
      const importPath = `../${segment}/`;
      if (ALLOWLIST_IMPORTS.has(importPath)) continue;

      if (!shouldFlag(file, segment)) continue;

      // Only flag real import / export-from statements, not string
      // literals (e.g. expect().toContain("from '../foo'")) or comments
      // (e.g. doc-block examples). The line must start with an import-
      // shaped keyword after stripping leading whitespace, and the
      // entire `from` clause must sit outside any quoted region on the
      // same line.
      const upToMatch = content.slice(0, m.index);
      const lineStart = upToMatch.lastIndexOf('\n') + 1;
      const lineEnd = content.indexOf('\n', m.index);
      const line = lineEnd === -1 ? content.slice(lineStart) : content.slice(lineStart, lineEnd);
      const stripped = line.trimStart();
      if (!stripped.startsWith('import') && !stripped.startsWith('export')) {
        continue;
      }
      // Naive string-region check: count unescaped quotes before the
      // match on this line; if odd, the match is inside a string.
      const beforeOnLine = content.slice(lineStart, m.index);
      const quoteCount = (beforeOnLine.match(/['"`]/g) || []).length;
      if (quoteCount % 2 === 1) continue;

      const lineNumber = upToMatch.split('\n').length;
      offenders.push({
        file: relative(REPO_ROOT, abs),
        line: lineNumber,
        segment,
      });
    }
  }

  if (offenders.length === 0) {
    console.log(`check-relative-imports: 0 offenders across ${files.length} files.`);
    process.exit(0);
  }

  console.error(`check-relative-imports: ${offenders.length} offender(s):`);
  for (const o of offenders) {
    console.error(`  ${o.file}:${o.line}  ../${o.segment}/`);
  }
  console.error('');
  console.error(
    'Each offender imports a path that climbs out of its parent directory\n' +
      'and back into a sibling of the same name — the signature of a leftover\n' +
      'relative path after a file was moved into a subdirectory.\n' +
      'Fix the path (usually by removing the redundant `../<parent>`),\n' +
      'or, if the layout really requires it, add an entry to ALLOWLIST_IMPORTS\n' +
      'in scripts/check-relative-imports.mjs with a justification comment.',
  );
  process.exit(1);
}

main();
