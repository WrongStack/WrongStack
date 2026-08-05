import { describe, expect, it } from 'vitest';
import {
  changedSnapshotInputs,
  isSnapshotInput,
} from '../../../../scripts/sync-core-public-api-snapshot.mjs';

describe('Core API snapshot pre-commit synchronization', () => {
  it('detects every source scope that feeds the generated snapshots', () => {
    expect(
      changedSnapshotInputs([
        'packages/core/src/coordination/director.ts',
        'packages/cli/src/cli-main.ts',
        'apps/desktop/src/main.ts',
        'scripts/snapshot-core-public-api.mjs',
        'packages/core/package.json',
        'architecture/core-api-policy.json',
        'README.md',
      ]),
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
    expect(isSnapshotInput('architecture/core-public-api-snapshot.json')).toBe(false);
    expect(isSnapshotInput('packages/core/README.md')).toBe(false);
    expect(isSnapshotInput('website/src/main.tsx')).toBe(false);
  });

  it('keeps deleted source paths in the synchronization scope', () => {
    expect(changedSnapshotInputs(['packages/core/src/legacy.ts'])).toEqual([
      'packages/core/src/legacy.ts',
    ]);
  });
});
