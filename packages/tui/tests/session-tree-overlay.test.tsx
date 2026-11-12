import type { SessionTreeSnapshot } from '@wrongstack/contracts/types';
import { render } from 'ink-testing-library';
import { describe, expect, it, vi } from 'vitest';
import {
  flattenSessionTreeRows,
  SessionTreeOverlay,
} from '../src/components/session-tree-overlay.js';

function sampleTree(): SessionTreeSnapshot {
  return {
    activeBranchId: 'br_redis',
    headSeq: 12,
    branches: {
      main: {
        id: 'main',
        name: 'main',
        parentBranchId: null,
        forkSeq: 0,
        createdAt: '2026-11-11T10:00:00.000Z',
        lastActivityAt: '2026-11-11T10:05:00.000Z',
        status: 'active',
        turnCount: 3,
      },
      br_redis: {
        id: 'br_redis',
        name: 'try-redis',
        label: 'Redis cache spike',
        parentBranchId: 'main',
        forkSeq: 4,
        forkPromptIndex: 2,
        createdAt: '2026-11-11T10:06:00.000Z',
        lastActivityAt: '2026-11-11T10:10:00.000Z',
        status: 'active',
        turnCount: 2,
        latestWorkspaceCheckpoint: {
          manifestHash: 'deadbeef1234567890abcdef1234567890abcdef1234567890abcdef12345678',
          baseHead: 'a'.repeat(40),
          entryCount: 2,
          unresolvedCount: 0,
          capturedAt: '2026-11-11T10:10:00.000Z',
          coverage: 'git-head-plus-dirty',
        },
      },
      br_sqlite: {
        id: 'br_sqlite',
        name: 'sqlite-poc',
        parentBranchId: 'main',
        forkSeq: 6,
        createdAt: '2026-11-11T10:08:00.000Z',
        lastActivityAt: '2026-11-11T10:09:00.000Z',
        status: 'folded',
        foldedIntoBranchId: 'main',
        turnCount: 1,
      },
    },
  };
}

describe('SessionTreeOverlay', () => {
  it('flattens DAG branches in hierarchical pre-order with tree connectors and CAS short-hashes', () => {
    const rows = flattenSessionTreeRows(sampleTree());
    expect(rows.map((r) => r.branch.name)).toEqual(['main', 'try-redis', 'sqlite-poc']);
    expect(rows[0]?.treePrefix).toBe('');
    expect(rows[1]?.treePrefix).toBe('├─ ');
    expect(rows[1]?.isActive).toBe(true);
    expect(rows[1]?.casShortHash).toBe('deadbeef');
    expect(rows[2]?.treePrefix).toBe('└─ ');
    expect(rows[2]?.glyph).toBe('◈');
  });

  it('renders branch statuses and dispatches switch, fold, archive, and close actions', async () => {
    const onSwitch = vi.fn();
    const onFold = vi.fn();
    const onArchive = vi.fn();
    const onClose = vi.fn();

    const app = render(
      <SessionTreeOverlay
        tree={sampleTree()}
        onSwitch={onSwitch}
        onFold={onFold}
        onArchive={onArchive}
        onClose={onClose}
      />,
    );

    const frame = app.lastFrame() ?? '';
    expect(frame).toContain('Session Tree (3 branches)');
    expect(frame).toContain('try-redis');
    expect(frame).toContain('[ACTIVE]');
    expect(frame).toContain('[folded → main]');
    expect(frame).toContain('cas:deadbeef');

    // Initial selection defaults to active branch (`try-redis`, index 1).
    // Press 'f' to fold `try-redis`.
    app.stdin.write('f');
    await new Promise((r) => setTimeout(r, 15));
    expect(onFold).toHaveBeenCalledWith(expect.objectContaining({ id: 'br_redis' }));

    // Move down ('j') to `sqlite-poc` (index 2, inactive) and press 'a' to archive, then 's' to switch keep-files.
    app.stdin.write('j');
    await new Promise((r) => setTimeout(r, 15));
    app.stdin.write('a');
    await new Promise((r) => setTimeout(r, 15));
    expect(onArchive).toHaveBeenCalledWith(expect.objectContaining({ id: 'br_sqlite' }));

    app.stdin.write('s');
    await new Promise((r) => setTimeout(r, 15));
    expect(onSwitch).toHaveBeenCalledWith(expect.objectContaining({ id: 'br_sqlite' }), {
      keepFiles: true,
    });

    // Press 'q' to close overlay.
    app.stdin.write('q');
    await new Promise((r) => setTimeout(r, 15));
    expect(onClose).toHaveBeenCalledTimes(1);

    app.unmount();
  });

  it('supports ←/→ parent/child navigation, d checkpoint details toggle, and b inline branch creation', async () => {
    const onCreateBranch = vi.fn();
    const tree = sampleTree();
    tree.branches.br_redis = {
      ...tree.branches.br_redis!,
      baseWorkspaceCheckpoint: {
        manifestHash: '1111222233334444555566667777888899990000aaaabbbbccccddddeeeeffff',
        baseHead: 'a'.repeat(40),
        entryCount: 1,
        unresolvedCount: 0,
        capturedAt: '2026-11-11T10:06:00.000Z',
        coverage: 'git-head-plus-dirty',
      },
    };

    const app = render(<SessionTreeOverlay tree={tree} onCreateBranch={onCreateBranch} />);

    // Starts on active `try-redis`. Toggle 'd' details to inspect baseCas vs headCas divergence.
    app.stdin.write('d');
    await new Promise((r) => setTimeout(r, 15));
    const detailFrame = app.lastFrame() ?? '';
    expect(detailFrame).toContain('prompt #2');
    expect(detailFrame).toContain('baseCas:111122223333');
    expect(detailFrame).toContain('headCas:deadbeef1234');
    expect(detailFrame).toContain('diverged from fork checkpoint');

    // Press 'h' (left) to jump up to parent `main`, then 'l' (right) to jump into first child `try-redis`.
    app.stdin.write('h');
    await new Promise((r) => setTimeout(r, 15));
    expect(app.lastFrame() ?? '').toContain('id:main');

    app.stdin.write('l');
    await new Promise((r) => setTimeout(r, 15));
    expect(app.lastFrame() ?? '').toContain('id:br_redis');

    // Press 'b' to open inline branch creator, clear default name, type custom name, and press Enter.
    app.stdin.write('b');
    await new Promise((r) => setTimeout(r, 15));
    expect(app.lastFrame() ?? '').toContain('New branch from try-redis:');

    for (let i = 0; i < 10; i += 1) {
      app.stdin.write('\x7f');
    }
    app.stdin.write('sub-spike');
    await new Promise((r) => setTimeout(r, 15));
    app.stdin.write('\r');
    await new Promise((r) => setTimeout(r, 15));

    expect(onCreateBranch).toHaveBeenCalledWith(
      'sub-spike',
      expect.objectContaining({ id: 'br_redis' }),
    );
    app.unmount();
  });

  it('opens an interactive fold preview modal with keep-open toggle when confirmFold is enabled', async () => {
    const onFold = vi.fn();
    const app = render(<SessionTreeOverlay tree={sampleTree()} confirmFold onFold={onFold} />);

    // Press 'f' on active `try-redis`: opens preview instead of folding immediately.
    app.stdin.write('f');
    await new Promise((r) => setTimeout(r, 15));
    expect(onFold).not.toHaveBeenCalled();
    expect(app.lastFrame() ?? '').toContain('Fold preview: try-redis');
    expect(app.lastFrame() ?? '').toContain('keep-open: off');

    // Toggle 'k' to keep the source branch open after folding, then confirm with Enter.
    app.stdin.write('k');
    await new Promise((r) => setTimeout(r, 15));
    expect(app.lastFrame() ?? '').toContain('keep-open: on');

    app.stdin.write('\r');
    await new Promise((r) => setTimeout(r, 15));
    expect(onFold).toHaveBeenCalledTimes(1);
    expect(onFold).toHaveBeenCalledWith(expect.objectContaining({ id: 'br_redis' }), {
      keepOpen: true,
    });
    app.unmount();
  });
});
