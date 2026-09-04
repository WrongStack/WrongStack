#!/usr/bin/env node
/**
 * Fail if `docs/feature-matrix.md` has drifted from the plugin sources.
 *
 * `packages/plugins/PLUGIN_CATALOG.md` is generated from source, but it does
 * NOT carry tool ids — the feature matrix is the only place that maps a
 * plugin to the tool names an operator actually types. That makes it a
 * hand-written projection of generated state, which is exactly the shape
 * that drifts silently: the doc's own header has asked for same-commit
 * updates since 2026-07-06, and by 2026-09-04 it had accumulated
 *
 *   - 19 of 64 rows naming tools that do not exist (`error_lens_status` for
 *     the real `error_lens_history`, `test_generate` for
 *     `generate_unit_tests`, and so on — every one of them a name that
 *     fails at the call site),
 *   - 3 plugins claiming to mutate files while writing none,
 *   - 1 plugin (`gitignore-guard`) missing from the matrix entirely.
 *
 * None of that is catchable by a typecheck or a test: the matrix is prose.
 * This check makes it catchable.
 *
 * Verified here:
 *   1. every plugin exported from `generated-plugin-exports.ts` has a row;
 *   2. every row points at a directory that exists;
 *   3. every tool id a row claims is a real `name: '...'` in that plugin.
 *
 *   node scripts/check-feature-matrix.mjs
 */
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = fileURLToPath(new URL('..', import.meta.url));
const MATRIX = join(repoRoot, 'docs/feature-matrix.md');
const PLUGIN_SRC = join(repoRoot, 'packages/plugins/src');
const EXPORTS = join(PLUGIN_SRC, 'generated-plugin-exports.ts');

/** Row shape: `| 7 | [`name`](../packages/plugins/src/dir) | cat | hooks | tools |` */
const ROW_RE =
  /^\| *\d+ *\| \[`([a-z0-9-]+)`\]\(\.\.\/packages\/plugins\/src\/([a-z0-9-]+)\)[^|]*\|[^|]*\|[^|]*\|([^|]*)\|/gm;

/** Tool ids are the snake_case backticked cells in the tools column. */
const TOOL_RE = /`([a-z0-9_]+)`/g;

/** Collect every `name: 'x'` literal in a plugin's non-test sources. */
function declaredNames(dir) {
  const names = new Set();
  const walk = (d) => {
    for (const entry of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, entry.name);
      if (entry.isDirectory()) walk(p);
      else if (entry.name.endsWith('.ts') && !entry.name.endsWith('.test.ts')) {
        for (const m of readFileSync(p, 'utf-8').matchAll(/name:\s*'([a-z0-9_]+)'/g)) {
          names.add(m[1]);
        }
      }
    }
  };
  walk(dir);
  return names;
}

const matrix = readFileSync(MATRIX, 'utf-8');
const exportedDirs = new Set(
  [...readFileSync(EXPORTS, 'utf-8').matchAll(/from '\.\/([a-z0-9-]+)\/index\.js'/g)].map(
    (m) => m[1],
  ),
);

const problems = [];
const listed = new Set();

for (const [, plugin, dir, toolsCell] of matrix.matchAll(ROW_RE)) {
  listed.add(dir);
  const pluginDir = join(PLUGIN_SRC, dir);
  if (!existsSync(pluginDir)) {
    problems.push(`${plugin}: row links packages/plugins/src/${dir}, which does not exist`);
    continue;
  }
  const actual = declaredNames(pluginDir);
  for (const [, tool] of toolsCell.matchAll(TOOL_RE)) {
    if (!actual.has(tool)) {
      const real = [...actual].filter((n) => n !== plugin).join(', ') || '(none)';
      problems.push(`${plugin}: matrix claims tool \`${tool}\`; the plugin declares: ${real}`);
    }
  }
}

for (const dir of exportedDirs) {
  if (!listed.has(dir)) problems.push(`${dir}: exported as a plugin but has no matrix row`);
}
for (const dir of listed) {
  if (!exportedDirs.has(dir))
    problems.push(`${dir}: has a matrix row but is not an exported plugin`);
}

if (problems.length > 0) {
  console.error(
    `\n[check-feature-matrix] ❌ ${problems.length} drift(s) in docs/feature-matrix.md:\n`,
  );
  for (const p of problems) console.error(`  ${p}`);
  console.error(
    '\n  The matrix is a hand-written projection of packages/plugins/src.',
    '\n  Update it in the same commit as the plugin change.\n',
  );
  process.exit(1);
}

console.log(
  `check-feature-matrix: ${listed.size} plugin rows match packages/plugins/src (tool ids verified).`,
);
