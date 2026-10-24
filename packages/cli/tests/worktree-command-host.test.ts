import { execFile } from 'node:child_process';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { promisify } from 'node:util';
import { EventBus } from '@wrongstack/contracts/kernel';
import { GoalRunLeaseBusyError } from '@wrongstack/goal';
import { WorktreeManager } from '@wrongstack/core/worktree';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { removeProjectFixtureDirectory } from '../../core/tests/helpers/project-server-harness.js';
import { createWorktreeCommandHost } from '../src/worktree-command-host.js';

const execFileAsync = promisify(execFile);

describe('createWorktreeCommandHost', () => {
  let projectRoot: string;

  beforeEach(async () => {
    projectRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'wt-cmd-'));
    await execFileAsync('git', ['init', '-q'], { cwd: projectRoot });
    await execFileAsync('git', ['config', 'user.email', 't@t'], { cwd: projectRoot });
    await execFileAsync('git', ['config', 'user.name', 't'], { cwd: projectRoot });
    await fs.writeFile(path.join(projectRoot, '.gitignore'), '.wrongstack/\n', 'utf8');
    await fs.writeFile(path.join(projectRoot, 'a.txt'), 'a\n', 'utf8');
    await execFileAsync('git', ['add', '.'], { cwd: projectRoot });
    await execFileAsync('git', ['commit', '-q', '-m', 'init'], { cwd: projectRoot });
  });

  afterEach(async () => {
    await removeProjectFixtureDirectory(projectRoot, { maxRetries: 5, retryDelay: 50 });
  });

  function makeHost(over: { goalActive?: boolean; leaseBusy?: boolean } = {}) {
    const events = new EventBus();
    const releaseLease = vi.fn(async () => {});
    const acquireGoalRunLease = vi.fn(async () => {
      if (over.leaseBusy) throw new GoalRunLeaseBusyError('webui:1234');
      return releaseLease;
    });
    const host = createWorktreeCommandHost({
      projectRoot,
      events,
      isGoalRunActive: () => over.goalActive ?? false,
      acquireGoalRunLease,
    });
    return { host, events, acquireGoalRunLease, releaseLease };
  }

  it('refuses to clean while a run in this process owns a worktree, then allows it', async () => {
    const { host, events, releaseLease } = makeHost();
    // The manager emits on the shared bus exactly as a Goal/fleet run would.
    const wm = new WorktreeManager({ projectRoot, events });
    const h = await wm.allocate('task-1', { slugHint: 'busy' });
    await fs.writeFile(path.join(h.dir, 'wip.txt'), 'in progress\n', 'utf8');

    expect(await host.onWorktree('clean')).toContain('in use by running tasks');
    expect(await fs.readFile(path.join(h.dir, 'wip.txt'), 'utf8')).toBe('in progress\n');
    expect(await host.onWorktree('merge', h.branch)).toContain('belongs to a running task');

    await wm.release(h, { keep: true });
    expect(await host.onWorktree('clean')).toBe('🧹 Removed 1 worktree(s) and 1 branch(es).');
    expect(releaseLease).toHaveBeenCalledOnce();
    expect((await wm.listManaged()).worktrees).toEqual([]);
    host.dispose();
  }, 60_000);

  it('refuses to clean while a Goal run is active here or holds the lease elsewhere', async () => {
    const wm = new WorktreeManager({ projectRoot });
    await wm.allocate('orphan', { slugHint: 'kept' });

    const active = makeHost({ goalActive: true });
    expect(await active.host.onWorktree('clean')).toContain('A Goal run is active');
    expect(active.acquireGoalRunLease).not.toHaveBeenCalled();

    const busy = makeHost({ leaseBusy: true });
    expect(await busy.host.onWorktree('clean')).toContain('Another Goal run already owns');
    expect((await wm.listManaged()).worktrees).toHaveLength(1);
  }, 60_000);

  it('merges a finished branch through WorktreeManager', async () => {
    const { host } = makeHost();
    const wm = new WorktreeManager({ projectRoot });
    const h = await wm.allocate('done', { slugHint: 'done' });
    await fs.writeFile(path.join(h.dir, 'b.txt'), 'b\n', 'utf8');
    await wm.commitAll(h, 'work');

    expect(await host.onWorktree('merge', h.branch)).toMatch(/^✓ Merged "wstack\/ap\/done-/);
    // core.autocrlf on Windows checks the merged file out with CRLF.
    const merged = await fs.readFile(path.join(projectRoot, 'b.txt'), 'utf8');
    expect(merged.replace(/\r/g, '')).toBe('b\n');
  }, 60_000);
});
