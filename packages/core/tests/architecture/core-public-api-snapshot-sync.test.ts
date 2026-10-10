import { describe, expect, it } from 'vitest';
import {
  changedSnapshotInputs,
  isSnapshotInput,
  type ReadSource,
} from '../../../../scripts/sync-core-public-api-snapshot.mjs';

/**
 * `isSnapshotInput` reads file CONTENT to decide whether a non-core source can
 * influence the generated snapshots (only files importing `@wrongstack/core`
 * reach the usage census). Without an injected reader these assertions would
 * consult the real working tree, so they would silently change meaning
 * whenever an unrelated file's imports changed — and in the shared checkout
 * they would measure whoever's edits happened to be present.
 *
 * Every case below is therefore pinned against an explicit fixture.
 */
const FIXTURES: Record<string, string> = {
  'packages/core/src/coordination/director.ts': "export { x } from '@wrongstack/core/kernel';",
  'packages/cli/src/cli-main.ts': "import { y } from '@wrongstack/core/kernel';",
  'apps/desktop/src/main.ts': "import '@wrongstack/core/observability';",
  'scripts/snapshot-core-public-api.mjs':
    "import { loadPolicy } from './lib/architecture-health.mjs';",
  // Snapshot-neutral: a real source file that never references @wrongstack/core.
  'packages/tools/src/unrelated.ts': "import path from 'node:path';",
};
const readSource: ReadSource = (file) => {
  const content = FIXTURES[file];
  if (content === undefined) throw new Error(`no fixture for ${file}`);
  return content;
};

describe('Core API snapshot pre-commit synchronization', () => {
  it('detects every source scope that feeds the generated snapshots', () => {
    expect(
      changedSnapshotInputs(
        [
          'packages/core/src/coordination/director.ts',
          'packages/cli/src/cli-main.ts',
          'apps/desktop/src/main.ts',
          'scripts/snapshot-core-public-api.mjs',
          'packages/core/package.json',
          'architecture/core-api-policy.json',
          'README.md',
        ],
        readSource,
      ),
    ).toEqual([
      'apps/desktop/src/main.ts',
      'architecture/core-api-policy.json',
      'packages/cli/src/cli-main.ts',
      'packages/core/package.json',
      'packages/core/src/coordination/director.ts',
      'scripts/snapshot-core-public-api.mjs',
    ]);
  });

  it('does not treat generated output and non-source files as snapshot inputs', () => {
    expect(isSnapshotInput('architecture/core-public-api-snapshot.json', readSource)).toBe(false);
    expect(isSnapshotInput('packages/core/README.md', readSource)).toBe(false);
    expect(isSnapshotInput('website/src/main.tsx', readSource)).toBe(false);
  });

  it('keeps deleted source paths in the synchronization scope', () => {
    // A DELETED packages/core/src path cannot be read; fail-closed keeps it in.
    expect(() => readSource('packages/core/src/legacy.ts')).toThrow();
    expect(changedSnapshotInputs(['packages/core/src/legacy.ts'], readSource)).toEqual([
      'packages/core/src/legacy.ts',
    ]);
  });

  it('excludes snapshot-neutral sources outside packages/core', () => {
    expect(isSnapshotInput('packages/tools/src/unrelated.ts', readSource)).toBe(false);
    expect(changedSnapshotInputs(['packages/tools/src/unrelated.ts'], readSource)).toEqual([]);
  });

  it('fails closed when a candidate file cannot be read', () => {
    const throwing: ReadSource = () => {
      throw new Error('EACCES');
    };
    expect(isSnapshotInput('packages/tools/src/whatever.ts', throwing)).toBe(true);
  });
});
