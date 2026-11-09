import { execFileSync } from 'node:child_process';
import { realpathSync } from 'node:fs';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { assertSafePath, WorktreeManager } from '../src/index.js';

let root: string;
const exists = (p: string) =>
  fs.stat(p).then(
    () => true,
    () => false,
  );
const lowerDrive = (p: string) => (p[0] ?? '').toLowerCase() + p.slice(1);

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(realpathSync.native(os.tmpdir()), 'worktree-case-'));
  const git = (...args: string[]) => execFileSync('git', args, { cwd: root });
  git('init', '-q', '-b', 'main');
  git('config', 'user.email', 't@e.com');
  git('config', 'user.name', 't');
  await fs.writeFile(path.join(root, 'a.txt'), 'a');
  git('add', '-A');
  git('commit', '-q', '-m', 'init');
});

afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true }).catch(() => undefined);
});

// git prints worktree paths with an upper-case drive letter whatever case the
// caller passed; a project root opened as `c:\…` saw no managed checkout, so
// its leftovers were never swept and adopt() refused a live Goal checkout.
describe.runIf(process.platform === 'win32')(
  'managed checkouts under a lower-case drive (F851)',
  () => {
    it('lists, adopts and sweeps them', async () => {
      const projectRoot = lowerDrive(root);
      const upperRoot = (root[0] ?? '').toUpperCase() + root.slice(1);
      assertSafePath(path.join(upperRoot, '.wrongstack', 'worktrees', 'goal-1'), projectRoot);
      const handle = await new WorktreeManager({ projectRoot }).allocate('goal:1', {
        slugHint: 'goal-1',
      });
      expect((await new WorktreeManager({ projectRoot }).listManaged()).worktrees).toHaveLength(1);
      const upperHandleDir = (handle.dir[0] ?? '').toUpperCase() + handle.dir.slice(1);
      const adopted = await new WorktreeManager({ projectRoot }).adopt('goal:1', {
        dir: upperHandleDir,
        branch: handle.branch,
        baseBranch: handle.baseBranch,
      });
      expect(adopted.status).toBe('active');
      expect(await new WorktreeManager({ projectRoot }).cleanupAllManaged()).toEqual({
        removed: 1,
      });
      expect(await exists(handle.dir)).toBe(false);
    });
  },
);
