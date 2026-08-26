/**
 * Ratchet: `packages/core/src/index.ts` relative-import count must stay at or
 * below `architecture/core-api-policy.json#maxBarrelRelativeImports`.
 *
 * Reviewer learned directive: "declared-but-not-enforced drift hazard" — the
 * maxBarrelRelativeImports rule is *declared* in the policy file, but unless
 * something reads it on every CI run, nothing prevents a fresh
 * `export { ... } from './...'` block from re-bloating the barrel. This test
 * reads the policy file, counts the actual relative imports in the barrel,
 * and fails if the count exceeds the ceiling.
 *
 * Lowering the ceiling is the intended migration path: every canonical
 * subpath migration (`./utils`, `./types/...`) should allow shrinking it.
 * Never raise it to admit new root consumers.
 */

import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const REPO_ROOT = path.resolve(fileURLToPath(new URL('../../../..', import.meta.url)));
const BARREL = path.resolve(REPO_ROOT, 'packages/core/src/index.ts');
const POLICY = path.resolve(REPO_ROOT, 'architecture/core-api-policy.json');

// Match the relative import shape used in the barrel: `from './foo.js'`,
// `from './foo/bar.js'`, or `export * from './foo.js'`. Bare imports like
// `from 'foo'` (node_modules) and deep subpath imports via `@wrongstack/core/x`
// (already routed to source by vite aliases) are intentionally excluded.
const RELATIVE_IMPORT_RE = /from\s+['"]\.\/[^'"]+['"]/g;

interface CoreApiPolicy {
  schemaVersion: number;
  maxRootImportFiles: number;
  maxBarrelRelativeImports?: number;
  rootEntryPolicy: string;
  canonicalObservabilityImport: string;
  reviewedAt: string;
  removalGate: string;
  barrelRatchetNote?: string;
}

async function loadPolicy(): Promise<CoreApiPolicy> {
  const text = await fs.readFile(POLICY, 'utf8');
  return JSON.parse(text) as CoreApiPolicy;
}

async function countRelativeImports(absPath: string): Promise<number> {
  const text = await fs.readFile(absPath, 'utf8');
  const matches = text.match(RELATIVE_IMPORT_RE);
  return matches?.length ?? 0;
}

describe('core barrel relative-imports ratchet', () => {
  it('policy file declares maxBarrelRelativeImports', async () => {
    const policy = await loadPolicy();
    expect(policy.maxBarrelRelativeImports).toBeDefined();
    expect(typeof policy.maxBarrelRelativeImports).toBe('number');
    expect(policy.maxBarrelRelativeImports).toBeGreaterThan(0);
  });

  it('core barrel relative-import count is at or below the policy ceiling', async () => {
    const policy = await loadPolicy();
    const ceiling = policy.maxBarrelRelativeImports;
    if (ceiling === undefined) {
      throw new Error('policy.maxBarrelRelativeImports is missing — see core-api-policy.json');
    }
    const count = await countRelativeImports(BARREL);
    expect(
      count,
      `packages/core/src/index.ts has ${count} relative imports (ceiling: ${ceiling}). ` +
        'Move consumers to canonical subpath imports (e.g. @wrongstack/core/utils) and shrink the barrel.',
    ).toBeLessThanOrEqual(ceiling);
  });

  it('barrel stays the only compatibility entry — no parallel barrels under packages/core/src/**/index.ts in the public exports map', async () => {
    const policy = await loadPolicy();
    expect(policy.rootEntryPolicy).toBe('compatibility-only');
  });
});
