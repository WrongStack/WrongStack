/**
 * Apps/desktop must import @wrongstack/core through canonical subpaths
 * (e.g. `@wrongstack/core/utils`, `@wrongstack/core/storage`), never via
 * the bare `@wrongstack/core` barrel.
 *
 * The bare barrel is `compatibility-only` per
 * `architecture/core-api-policy.json#rootEntryPolicy`. Admitting a new
 * root consumer inflates the public surface of `@wrongstack/core` and
 * makes future barrel splits harder. The desktop app is a published
 * consumer; its coupling to the barrel is also the most likely source of
 * accidental client-side bundling of Node-only code if a regression ever
 * loosens the subpath contract.
 *
 * This test fails if any file in apps/desktop imports `@wrongstack/core`
 * without an explicit subpath.
 */

import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const REPO_ROOT = path.resolve(fileURLToPath(new URL('../../..', import.meta.url)));
const APPS_DIR = path.resolve(REPO_ROOT, 'apps/desktop');

const BARE_IMPORT_RE =
  /(?:from\s+['"]|import\s+['"]|import\s*\(\s*['"])@wrongstack\/core(?:['"][^/]|\s*['"]\s*\))/g;

async function walk(dir: string): Promise<string[]> {
  const entries = await fs.readdir(dir, { withFileTypes: true });
  const out: string[] = [];
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules' || entry.name === 'dist') continue;
      out.push(...(await walk(full)));
      continue;
    }
    if (/\.(ts|tsx)$/.test(entry.name)) out.push(full);
  }
  return out;
}

describe('apps/desktop core-import discipline', () => {
  it('no source file imports the bare @wrongstack/core barrel', async () => {
    const files = await walk(path.join(APPS_DIR, 'src'));
    const violations: string[] = [];
    for (const file of files) {
      const text = await fs.readFile(file, 'utf8');
      const matches = text.match(BARE_IMPORT_RE);
      if (matches && matches.length > 0) {
        violations.push(
          `${path.relative(REPO_ROOT, file)}: ${matches.length} bare @wrongstack/core import(s) — use a canonical subpath (e.g. @wrongstack/core/utils)`,
        );
      }
    }
    expect(violations, violations.join('\n')).toEqual([]);
  });

  it('every @wrongstack/core/* subpath used is exported from packages/core', async () => {
    const files = await walk(path.join(APPS_DIR, 'src'));
    const corePkg = JSON.parse(
      await fs.readFile(path.join(REPO_ROOT, 'packages/core/package.json'), 'utf8'),
    ) as { exports: Record<string, unknown> };
    const declaredExports = new Set(Object.keys(corePkg.exports));

    const usedSubpaths = new Set<string>();
    const subpathImportRe = /@wrongstack\/core\/([A-Za-z0-9_\-./]+)/g;
    for (const file of files) {
      const text = await fs.readFile(file, 'utf8');
      for (const match of text.matchAll(subpathImportRe)) {
        usedSubpaths.add(`./${match[1]}`);
      }
    }

    const unknown: string[] = [];
    for (const sub of usedSubpaths) {
      // Allow trailing wildcard (./types/*) — match the longest declared
      // prefix.
      const exact = declaredExports.has(sub);
      if (exact) continue;
      const wildcardMatch = [...declaredExports].some((decl) => {
        if (!decl.includes('*')) return false;
        const prefix = decl.replace(/\*/g, '');
        return sub.startsWith(prefix) || sub === prefix.replace(/\/$/, '');
      });
      if (!wildcardMatch) unknown.push(sub);
    }

    expect(unknown, `unknown subpaths: ${unknown.join(', ')}`).toEqual([]);
  });
});
