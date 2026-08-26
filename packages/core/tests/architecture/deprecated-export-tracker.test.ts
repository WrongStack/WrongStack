/**
 * Migration tracker for `LegacySessionRegistry`.
 *
 * The `@deprecated Test/migration adapter` line in
 * `packages/core/src/storage/index.ts` declares an intent: drop this alias
 * once the only known consumer (webui-server's standalone-session-identity
 * test) migrates to a canonical subpath import.
 *
 * This test fails if the alias lingers past the planned migration:
 *   - the alias MUST still be exported while consumers depend on it;
 *   - the consumer list MUST be empty (no source file imports it) before
 *     removal is safe;
 *   - the snapshot in architecture/core-public-api-snapshot.json MUST list
 *     the alias so the next regen catches a removal as a change.
 *
 * When this test fails with "no consumers remain — safe to remove", the
 * removal is one PR: delete the export, update the consumer, run
 * architecture-health regen.
 */

import type { Dirent } from 'node:fs';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const REPO_ROOT = path.resolve(fileURLToPath(new URL('../../../..', import.meta.url)));
const STORAGE_INDEX = path.resolve(REPO_ROOT, 'packages/core/src/storage/index.ts');
const SNAPSHOT = path.resolve(REPO_ROOT, 'architecture/core-public-api-snapshot.json');

const CONSUMER_FILES = ['packages/webui-server/tests/standalone-session-identity.test.ts'];

async function grepRepoForConsumer(): Promise<string[]> {
  const consumers: string[] = [];
  const needle = 'LegacySessionRegistry';
  const stack = [path.resolve(REPO_ROOT, 'packages'), path.resolve(REPO_ROOT, 'apps')];
  while (stack.length > 0) {
    const dir = stack.pop();
    if (!dir) continue;
    let entries: Dirent<string>[];
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (entry.name === 'node_modules' || entry.name === 'dist') continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        stack.push(full);
        continue;
      }
      if (!/\.(ts|tsx)$/.test(entry.name)) continue;
      const text = await fs.readFile(full, 'utf8');
      if (text.includes(needle)) {
        consumers.push(path.relative(REPO_ROOT, full));
      }
    }
  }
  return consumers;
}

describe('LegacySessionRegistry migration', () => {
  it('alias is still exported from packages/core/src/storage/index.ts', async () => {
    const text = await fs.readFile(STORAGE_INDEX, 'utf8');
    expect(text).toMatch(/SessionRegistry as LegacySessionRegistry/);
    expect(text).toMatch(/@deprecated/);
  });

  it('architecture/core-public-api-snapshot.json lists the alias so regen detects removal', async () => {
    const text = await fs.readFile(SNAPSHOT, 'utf8');
    expect(text).toMatch(/SessionRegistry as LegacySessionRegistry/);
  });

  it('known consumers (allowlist) match the actual repo', async () => {
    const actual = (await grepRepoForConsumer()).sort();
    const expected = [...CONSUMER_FILES].sort();
    // Normalise Windows backslashes that path.relative may emit on win32
    const normalisedActual = actual.map((f) => f.replaceAll('\\', '/'));
    // Exclude sites that are not "consumers" of the alias:
    //   - the declaration site (the alias is being defined, not consumed)
    //   - this test itself (the test references the name to assert on it)
    const actualConsumers = normalisedActual.filter(
      (f) =>
        f !== 'packages/core/src/storage/index.ts' &&
        f !== 'packages/core/tests/architecture/deprecated-export-tracker.test.ts',
    );
    expect(actualConsumers).toEqual(expected);
  });
});
