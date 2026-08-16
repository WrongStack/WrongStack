import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

// Module-relative so the suite passes from any vitest root (the package
// `test` script runs vitest with --root ../.. from the package directory).
const REPO_ROOT = path.resolve(fileURLToPath(new URL('../../../..', import.meta.url)));

describe('Core types public boundary', () => {
  it('does not re-export implementation modules from outside src/types', async () => {
    const entry = path.join(REPO_ROOT, 'packages/core/src/types/index.ts');
    const source = await fs.readFile(entry, 'utf8');
    const violations = source
      .split(/\r?\n/u)
      .filter((line) => /^export\s+(?:type\s+)?\*\s+from\s+['"]\.\.\//u.test(line));

    expect(violations).toEqual([]);
  });

  it('counts module references rather than fixture strings in the API usage snapshot', async () => {
    const snapshotPath = path.join(REPO_ROOT, 'architecture/core-public-api-usage.json');
    const snapshot = JSON.parse(await fs.readFile(snapshotPath, 'utf8')) as {
      usages: Array<{ specifier: string; file: string }>;
    };
    const rootFiles = snapshot.usages
      .filter((usage) => usage.specifier === '@wrongstack/core')
      .map((usage) => usage.file);

    expect(rootFiles).not.toContain('packages/techstack/tests/fixture-parity.test.ts');
    expect(rootFiles).not.toContain('packages/techstack/tests/npm-adapter.test.ts');
    expect(rootFiles).not.toContain('packages/techstack/vitest.config.ts');
    expect(rootFiles).not.toContain('packages/core/src/index.ts');
    expect(rootFiles).not.toContain('packages/core/src/notifications/index.ts');
    expect(rootFiles).not.toContain('packages/core/src/plugin/api.ts');
  });
});
