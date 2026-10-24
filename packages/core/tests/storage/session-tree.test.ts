/**
 * `/resume` as a tree: a fork records its parent in the session summary, the
 * listing nests forks under parents, and the repository's other git
 * worktrees are discovered for the picker.
 */
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import type { SessionEvent } from '@wrongstack/contracts/types/session';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DefaultSessionStore } from '../../src/index.js';
import { summarizeSessionEvents } from '../../src/storage/session-store/summary-builder.js';
import { orderSessionTree, sessionTreePrefix } from '../../src/storage/session-tree.js';
import { listGitWorktrees } from '../../src/worktree/git-worktree-list.js';

const s = (id: string, forkedFrom?: string) => ({ id, ...(forkedFrom ? { forkedFrom } : {}) });

describe('orderSessionTree', () => {
  it('nests forks under their parent and keeps the listing order', () => {
    const rows = orderSessionTree([s('c1', 'a'), s('b'), s('a'), s('c2', 'a'), s('d1', 'c1')]);
    expect(rows.map((r) => [r.session.id, r.depth])).toEqual([
      ['b', 0],
      ['a', 0],
      ['c1', 1],
      ['d1', 2],
      ['c2', 1],
    ]);
    const prefixes = rows.map((_, i) => sessionTreePrefix(rows, i));
    expect(prefixes).toEqual(['', '', '├─ ', '│  └─ ', '└─ ']);
  });

  it('keeps a fork whose parent is not listed, and survives a parent cycle', () => {
    expect(orderSessionTree([s('x', 'gone'), s('y')]).map((r) => r.depth)).toEqual([0, 0]);
    const cycle = orderSessionTree([s('p', 'q'), s('q', 'p')]);
    expect(cycle.map((r) => r.session.id).sort()).toEqual(['p', 'q']);
  });
});

describe('forkedFrom in session summaries', () => {
  let dir: string;
  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'wstack-tree-'));
  });
  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  it('a fork lists its parent after a real create → fork → list', async () => {
    const store = new DefaultSessionStore({ dir });
    const parent = await store.create({ id: 'parent', model: 'm', provider: 'p' });
    await parent.append({ type: 'user_input', ts: new Date().toISOString(), content: 'hello' });
    await parent.close();
    const fork = await store.fork('parent');

    const listed = await new DefaultSessionStore({ dir }).list(10);
    const child = listed.find((x) => x.id === fork.id);
    expect(child?.forkedFrom).toBe('parent');
    expect(listed.find((x) => x.id === 'parent')?.forkedFrom).toBeUndefined();
  });

  it('records the checkout a session was created in and the one it was last resumed in', async () => {
    const mainCheckout = path.join(dir, 'main');
    const featureCheckout = path.join(dir, 'feature');
    const writer = await new DefaultSessionStore({ dir, projectRoot: mainCheckout }).create({
      id: 'wt-session',
      model: 'm',
      provider: 'p',
    });
    await writer.append({ type: 'user_input', ts: new Date().toISOString(), content: 'hi' });
    await writer.close();
    const listed = await new DefaultSessionStore({ dir }).list(10);
    expect(listed.find((x) => x.id === 'wt-session')?.checkout).toBe(path.resolve(mainCheckout));

    const resumed = await new DefaultSessionStore({ dir, projectRoot: featureCheckout }).resume(
      'wt-session',
    );
    await resumed.writer.append({
      type: 'user_input',
      ts: new Date().toISOString(),
      content: 'again',
    });
    await resumed.writer.close();
    const relisted = await new DefaultSessionStore({ dir }).list(10);
    expect(relisted.find((x) => x.id === 'wt-session')?.checkout).toBe(
      path.resolve(featureCheckout),
    );
  });

  it('a summary rebuilt from the journal carries it too', async () => {
    const ts = new Date().toISOString();
    const events: SessionEvent[] = [
      { type: 'session_start', ts, model: 'm', provider: 'p' } as SessionEvent,
      {
        type: 'session_forked',
        ts,
        parentSessionId: 'parent-1',
        parentCheckpointHash: 'h',
        workspace: 'shared-current',
      } as SessionEvent,
    ];
    const summary = await summarizeSessionEvents({ id: 'child', events, mtime: ts });
    expect(summary.forkedFrom).toBe('parent-1');
  });
});

describe('listGitWorktrees', () => {
  const root = path.resolve(os.tmpdir(), 'repo');
  const porcelain = [
    `worktree ${root}`,
    'HEAD aaa',
    'branch refs/heads/main',
    '',
    `worktree ${path.resolve(os.tmpdir(), 'repo-feature')}`,
    'HEAD bbb',
    'branch refs/heads/feature/x',
    '',
    `worktree ${path.join(root, '.wrongstack', 'worktrees', 'ap-1')}`,
    'HEAD ccc',
    'branch refs/heads/wstack/ap/1',
    '',
    `worktree ${path.resolve(os.tmpdir(), 'repo-detached')}`,
    'HEAD ddd',
    'detached',
    '',
    `worktree ${path.resolve(os.tmpdir(), 'repo-gone')}`,
    'HEAD eee',
    'branch refs/heads/old',
    'prunable gitdir file points to non-existent location',
    '',
  ].join('\n');

  it('lists the user worktrees, marks the current one, drops managed and prunable ones', async () => {
    const list = await listGitWorktrees(path.join(root, 'packages', 'core'), async () => ({
      code: 0,
      stdout: porcelain,
      stderr: '',
    }));
    expect(list).toEqual([
      { root, branch: 'main', current: true },
      { root: path.resolve(os.tmpdir(), 'repo-feature'), branch: 'feature/x', current: false },
      { root: path.resolve(os.tmpdir(), 'repo-detached'), branch: undefined, current: false },
    ]);
  });

  it('is empty outside a repository, or when git fails part-way', async () => {
    expect(
      await listGitWorktrees(root, async () => ({ code: 128, stdout: '', stderr: 'not a repo' })),
    ).toEqual([]);
    expect(
      await listGitWorktrees(root, async () => ({ code: 1, stdout: porcelain, stderr: 'boom' })),
    ).toEqual([]);
  });

  it('a worktree nested inside the main checkout is the current one when you are in it', async () => {
    const nested = path.join(root, 'wt', 'feature');
    const out = [
      `worktree ${root}`,
      'branch refs/heads/main',
      '',
      `worktree ${nested}`,
      'branch refs/heads/f',
      '',
    ].join('\n');
    const list = await listGitWorktrees(path.join(nested, 'src'), async () => ({
      code: 0,
      stdout: out,
      stderr: '',
    }));
    expect(list.map((w) => [w.root, w.current])).toEqual([
      [root, false],
      [nested, true],
    ]);
  });
});
