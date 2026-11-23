import { join, resolve } from 'node:path';
import { EventBus } from '@wrongstack/contracts/kernel';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { WebSocket } from 'ws';

vi.mock('@wrongstack/worktree', () => ({ WorktreeManager: vi.fn() }));
vi.mock('@wrongstack/sdd', () => ({
  cleanupStaleSddWorktrees: vi.fn(),
  sddRunLiveReason: vi.fn(async () => undefined),
}));

import { WorktreeManager } from '@wrongstack/worktree';
import { WorktreeWebSocketHandler } from '../src/server/worktree-ws-handler.js';

/**
 * F1391: the panel guard that keeps `worktree.diff` / `worktree.remove` inside
 * `<project>/.wrongstack/worktrees` compared paths case-sensitively, while the
 * worktree package that lists those checkouts (`listManaged` → `managedPathKey`)
 * folds case on win32. git prints a worktree's on-disk spelling, so a project
 * opened as `d:\codebox\...` got every orphan row the scan itself reported
 * refused as "outside the managed worktrees root".
 */

type Sent = { type: string; payload: Record<string, unknown> };
const managerMock = WorktreeManager as unknown as { mockImplementation: (impl: unknown) => void };

function harness(projectRoot: string, methods: Record<string, unknown>) {
  managerMock.mockImplementation(
    class {
      constructor() {
        Object.assign(
          this,
          { listManaged: async () => ({ worktrees: [], branches: [] }) },
          methods,
        );
      }
    } as never,
  );
  const handler = new WorktreeWebSocketHandler(new EventBus(), { debug() {} } as never, {
    projectRoot,
    boardsDir: join(projectRoot, 'boards'),
  });
  const sent: Sent[] = [];
  handler.addClient({
    readyState: 1,
    bufferedAmount: 0,
    on() {},
    send: (data: string) => sent.push(JSON.parse(data) as Sent),
  } as unknown as WebSocket);
  const last = (type: string) => sent.filter((m) => m.type === type).at(-1)?.payload;
  return { handler, last };
}

// Never created: the manager is mocked, nothing touches the filesystem.
const root = resolve('/wstack-f1391/Proj');

beforeEach(() => vi.clearAllMocks());
afterEach(() => vi.clearAllMocks());

describe('worktree panel path guard (F1391)', () => {
  it('treats a case-variant spelling like the worktree package does', async () => {
    // win32 folds case (as `managedPathKey` does); elsewhere the spelling names another path.
    const folds = process.platform === 'win32';
    const variant = resolve('/WSTACK-F1391/proj/.wrongstack/worktrees/x');
    const diffSummary = vi.fn(async () => ({ files: [], insertions: 1, deletions: 0 }));
    const removeOne = vi.fn(async () => ({ removed: true }));
    const { handler, last } = harness(root, { diffSummary, removeOne });

    await handler.handleMessage({ type: 'worktree.diff', payload: { dir: variant } });
    expect(last('worktree.diff_result')).toMatchObject({
      summary: folds ? { insertions: 1 } : null,
    });

    await handler.handleMessage({ type: 'worktree.remove', payload: { dir: variant } });
    expect(last('worktree.cleanup_result')).toMatchObject(
      folds
        ? { ok: true, removed: 1 }
        : { ok: false, reason: 'path is outside the managed worktrees root' },
    );
    if (folds) {
      expect(diffSummary).toHaveBeenCalledWith(variant, undefined);
      expect(removeOne).toHaveBeenCalledWith(variant, undefined);
    }
    handler.dispose();
  });

  it('still refuses the worktrees root itself, siblings and traversal', async () => {
    const diffSummary = vi.fn(async () => ({ files: [], insertions: 1, deletions: 0 }));
    const { handler, last } = harness(root, { diffSummary });
    for (const dir of [
      join(root, '.wrongstack', 'worktrees'),
      join(root, '.wrongstack', 'worktrees-evil', 'x'),
      join(root, '.wrongstack', 'worktrees', '..', '..', 'src'),
      resolve('/elsewhere/.wrongstack/worktrees/x'),
    ]) {
      await handler.handleMessage({ type: 'worktree.diff', payload: { dir } });
      expect(last('worktree.diff_result')).toMatchObject({ dir, summary: null });
    }
    expect(diffSummary).not.toHaveBeenCalled();
    handler.dispose();
  });
});
