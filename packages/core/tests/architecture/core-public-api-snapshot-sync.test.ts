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
  'packages/core/src/core/agent-loop.ts': "export { x } from '@wrongstack/core/kernel';",
  'packages/cli/src/cli-main.ts': "import { y } from '@wrongstack/core/kernel';",
  'apps/wrongstack/src/main.ts': "import '@wrongstack/core/observability';",
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
  it('verifies unchanged staged evidence without consuming peer edits, and rejects actual drift', () => {
    const root = mkdtempSync(path.join(tmpdir(), 'core-api-index-'));
    const repository = path.resolve(import.meta.dirname, '../../../..');
    const put = (file: string, source: string) => {
      const target = path.join(root, file);
      mkdirSync(path.dirname(target), { recursive: true });
      writeFileSync(target, source);
    };
    const git = (...args: string[]) =>
      execFileSync('git', args, { cwd: root, encoding: 'utf8', windowsHide: true });
    try {
      const biome = path.join(repository, 'node_modules/@biomejs/biome/bin/biome');
      put(
        'package.json',
        JSON.stringify({
          name: 'fixture',
          private: true,
          type: 'module',
          scripts: {
            biome: `"${process.execPath.replaceAll('\\', '/')}" "${biome.replaceAll('\\', '/')}"`,
          },
        }),
      );
      put('.gitignore', '.temp_files/\nnode_modules/\n');
      put('architecture/core-api-policy.json', '{"maxRootImportFiles":0}\n');
      put(
        'packages/core/package.json',
        JSON.stringify({
          name: '@fixture/core',
          version: '0.0.0',
          exports: { './kernel': { import: './dist/kernel/index.js' } },
        }),
      );
      const core = 'packages/core/src/kernel/index.ts';
      const coreSource = 'export interface Context {}\n';
      put(core, coreSource);
      const specifier = ['@wrongstack', 'core', 'kernel'].join('/');
      const client = 'packages/client/src/index.ts';
      const clientSource = `import type { Context } from '${specifier}';\nexport const value = 1;\n`;
      put(client, clientSource);
      mkdirSync(path.join(root, 'scripts'), { recursive: true });
      cpSync(path.join(repository, 'scripts/lib'), path.join(root, 'scripts/lib'), {
        recursive: true,
      });
      for (const file of [
        'snapshot-core-public-api.mjs',
        'sync-core-public-api-snapshot.mjs',
        'sync-staged-architecture-evidence.mjs',
      ]) {
        cpSync(path.join(repository, 'scripts', file), path.join(root, 'scripts', file));
      }
      git('init', '--quiet');
      git('config', 'user.name', 'Core Snapshot Fixture');
      git('config', 'user.email', 'fixture@example.invalid');
      git('config', 'commit.gpgSign', 'false');
      execFileSync(process.execPath, ['scripts/snapshot-core-public-api.mjs', '--write'], {
        cwd: root,
        encoding: 'utf8',
        windowsHide: true,
        timeout: 30_000,
      });
      git('add', '.');
      git('commit', '--quiet', '-m', 'baseline');
      put(
        '.githooks/pre-commit',
        '#!/bin/sh\nexec bun scripts/sync-core-public-api-snapshot.mjs\n',
      );
      chmodSync(path.join(root, '.githooks/pre-commit'), 0o755);
      git('config', 'core.hooksPath', '.githooks');
      const snapshot = 'architecture/core-public-api-snapshot.json';
      const baseline = readFileSync(path.join(root, snapshot), 'utf8');
      const changedClient = clientSource.replace('value = 1', 'value = 2');
      put(client, changedClient);
      git('add', client);
      const peer = `${coreSource}export const unfinished = 1;\n`;
      put(core, peer);
      put('packages/client/src/untracked.ts', clientSource);
      const peerDraft = `${baseline}\n`;
      put(snapshot, peerDraft);
      const commit = () =>
        spawnSync('git', ['commit', '--quiet', '-m', 'staged client'], {
          cwd: root,
          encoding: 'utf8',
          windowsHide: true,
          timeout: 30_000,
        });
      const valid = commit();
      expect(valid.status, valid.stderr).toBe(0);
      expect(git('show', `:${client}`)).toBe(changedClient);
      expect(git('show', `:${snapshot}`)).toBe(baseline);
      expect(readFileSync(path.join(root, core), 'utf8')).toBe(peer);
      expect(readFileSync(path.join(root, snapshot), 'utf8')).toBe(peerDraft);
      expect(git('status', '--porcelain')).toContain('?? packages/client/src/untracked.ts');

      // Now the staged API itself really changed. A peer still has unfinished
      // inputs, so verification must fail instead of writing or admitting drift.
      git('add', core);
      const stale = commit();
      expect(stale.status).not.toBe(0);
      expect(stale.stderr).toContain('stale');
      expect(git('show', `:${snapshot}`)).toBe(baseline);
      expect(readFileSync(path.join(root, snapshot), 'utf8')).toBe(peerDraft);
    } finally {
      rmSync(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
    }
  }, 60_000);

  it('detects every source scope that feeds the generated snapshots', () => {
    expect(
      changedSnapshotInputs(
        [
          'packages/core/src/core/agent-loop.ts',
          'packages/cli/src/cli-main.ts',
          'apps/wrongstack/src/main.ts',
          'scripts/snapshot-core-public-api.mjs',
          'packages/core/package.json',
          'architecture/core-api-policy.json',
          'README.md',
        ],
        readSource,
      ),
    ).toEqual([
      'apps/wrongstack/src/main.ts',
      'architecture/core-api-policy.json',
      'packages/cli/src/cli-main.ts',
      'packages/core/package.json',
      'packages/core/src/core/agent-loop.ts',
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

import { execFileSync, spawnSync } from 'node:child_process';
import {
  chmodSync,
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
