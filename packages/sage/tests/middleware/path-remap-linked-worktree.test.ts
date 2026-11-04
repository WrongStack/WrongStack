import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  createSagePathRemapMiddleware,
  isLinkedWorktreeRoot,
} from '../../src/middleware/path-remap.js';

const SURFACE_CAPABILITY_ID = 'wrongstack.memory.surface.v1';

function git(cwd: string, ...args: string[]): void {
  execFileSync('git', args, {
    cwd,
    stdio: 'ignore',
    env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1' },
  });
}

/**
 * A linked worktree shares its main checkout's memory. A rename there exists
 * only on the worktree's branch, so it must not rewrite the shared anchors:
 * the main checkout still has the old path.
 */
describe('sage path-remap middleware in a linked worktree', () => {
  let tmp: string;
  let main: string;
  let linked: string;

  beforeAll(() => {
    tmp = mkdtempSync(path.join(tmpdir(), 'remap-wt-'));
    main = path.join(tmp, 'main');
    linked = path.join(tmp, 'linked');
    mkdirSync(main);
    git(main, 'init', '-q');
    git(
      main,
      '-c',
      'user.email=t@t',
      '-c',
      'user.name=t',
      'commit',
      '-q',
      '--allow-empty',
      '-m',
      'init',
    );
    git(main, 'worktree', 'add', '-q', linked);
  });

  afterAll(() => {
    rmSync(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });

  function harness(projectRoot: string) {
    const anchors = [{ type: 'file', path: 'README.md' }];
    const row = { id: 'm1', text: 'see README.md', status: 'active', anchors, revision: 1 };
    const updates: unknown[] = [];
    const surface = {
      listSage: async () => [{ ...row, anchors: [...row.anchors] }],
      updateSage: async (id: string, patch: { anchors?: typeof anchors }) => {
        updates.push({ id, patch });
        if (patch.anchors) row.anchors = patch.anchors;
        return row;
      },
    };
    const memory = {
      getCapability: (c: { id: string }) => (c.id === SURFACE_CAPABILITY_ID ? surface : undefined),
    } as never;
    const mw = createSagePathRemapMiddleware({ memory, maxPerHour: 50 });
    const run = (command: string) =>
      mw.handler(
        {
          toolUse: { id: 't', name: 'bash', input: { command } },
          result: { content: '', is_error: false },
          ctx: { projectRoot, cwd: projectRoot },
        } as never,
        async (p) => p,
      );
    return { row, updates, run };
  }

  it('tells a linked worktree from its main checkout', () => {
    expect(isLinkedWorktreeRoot(linked)).toBe(true);
    expect(isLinkedWorktreeRoot(main)).toBe(false);
  });

  it('leaves the shared anchors alone after a rename in the linked worktree', async () => {
    const h = harness(linked);
    await h.run('git mv README.md GUIDE.md');
    expect(h.updates).toEqual([]);
    expect(h.row.anchors[0]?.path).toBe('README.md');
  });

  it('still follows a rename in the main checkout', async () => {
    const h = harness(main);
    await h.run('git mv README.md GUIDE.md');
    expect(h.row.anchors[0]?.path).toBe('GUIDE.md');
  });
});
