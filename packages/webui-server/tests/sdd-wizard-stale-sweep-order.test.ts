import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { EventBus } from '@wrongstack/contracts/kernel';
import type { TaskGraph } from '@wrongstack/contracts/types';
import { expect, it, vi } from 'vitest';

const order = vi.hoisted(() => [] as string[]);
const sweep = vi.hoisted(() => ({ release: () => {} }));
vi.mock('@wrongstack/sdd', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@wrongstack/sdd')>()),
  cleanupStaleSddWorktrees: vi.fn(
    () =>
      new Promise((resolve) => {
        order.push('sweep:start');
        sweep.release = () => {
          order.push('sweep:done');
          resolve({ swept: true, removed: 1, detected: 1 });
        };
      }),
  ),
  startSddRun: vi.fn((opts: { worktrees?: unknown }) => {
    order.push(opts.worktrees ? 'run:start(worktrees)' : 'run:start');
    return { runId: 'run', completion: Promise.resolve({}) };
  }),
}));

import { startSddRunFromGraph } from '../src/server/sdd-wizard-wiring.js';

// A stale sweep that finds anything removes EVERY managed worktree. Started
// fire-and-forget, it overlapped the new run's first allocations and deleted
// the fresh checkouts; the CLI already awaited it.
it('finishes the stale-worktree sweep before starting a worktree run', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'sdd-sweep-order-'));
  try {
    execFileSync('git', ['init', '-q'], { cwd: root });
    const started = startSddRunFromGraph(
      { id: 'graph', nodes: new Map() } as TaskGraph,
      {
        agent: { ctx: {} } as never,
        events: new EventBus(),
        projectRoot: root,
        subagentFactory: vi.fn() as never,
        projectSddBoards: path.join(root, 'boards'),
      },
      { sessionId: 'tab-1', worktrees: true },
      {} as never,
    );
    // The sweep starts only after an async `git rev-parse` probe, which can
    // exceed waitFor's 1s default on a loaded machine.
    await vi.waitFor(() => expect(order).toContain('sweep:start'), { timeout: 15_000 });
    expect(order).not.toContain('run:start(worktrees)');
    sweep.release();
    await started;
    expect(order).toEqual(['sweep:start', 'sweep:done', 'run:start(worktrees)']);
  } finally {
    await fs.rm(root, { recursive: true, force: true }).catch(() => undefined);
  }
});
