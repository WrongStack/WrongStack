import { afterEach, describe, expect, it } from 'vitest';
import { useWorktreeStore } from '../../src/stores/worktree-store';

describe('worktree store', () => {
  afterEach(() => {
    useWorktreeStore.setState({ worktrees: [], baseBranch: '', activity: [] });
  });

  it('setSnapshot updates worktrees and baseBranch', () => {
    useWorktreeStore
      .getState()
      .setSnapshot(
        [{ handleId: 'wt1', path: '/repo/wt1', branch: 'feat/x', kind: 'worktree' }],
        'main',
      );
    const s = useWorktreeStore.getState();
    expect(s.worktrees).toHaveLength(1);
    expect(s.baseBranch).toBe('main');
  });

  it('pushEvent appends to activity (up to 40)', () => {
    useWorktreeStore.getState().pushEvent({
      handleId: 'wt1',
      kind: 'create',
      text: 'Created worktree',
      at: 1000,
    });
    const s = useWorktreeStore.getState();
    expect(s.activity).toHaveLength(1);
    expect(s.activity[0].text).toBe('Created worktree');
  });

  it('pushEvent caps activity at 40 entries', () => {
    // Fill 42 entries; only last 40 should remain
    for (let i = 0; i < 42; i++) {
      useWorktreeStore.getState().pushEvent({
        handleId: 'wt1',
        kind: 'event',
        text: `event ${i}`,
        at: i,
      });
    }
    const s = useWorktreeStore.getState();
    expect(s.activity).toHaveLength(40);
    expect(s.activity[0].text).toBe('event 2'); // first 2 were dropped
    expect(s.activity[39].text).toBe('event 41');
  });
});
