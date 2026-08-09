/**
 * WebUI kanban-store outbound dispatch integration tests.
 *
 * These tests verify the store-level contract for outbound actions:
 *   1. Each typed action (transitionTask, dispatchTask, moveTask, removeTask)
 *      sets `loading: true` and `lastOutboundAction` to the matching wire type.
 *   2. Wire-format only — the actual WS send lives in the caller (KanbanView
 *      closure). The store's job is to flag state for the UI to show spiners.
 *   3. handleResult flips `loading: false` on both success and failure, and
 *      surfaces the error string on failure.
 *
 * Real wire-e2e coverage lives in kanban-task-inspector-hooks.test.tsx where
 * the component-level dispatch handler is stubbed.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { useKanbanStore } from '../../src/stores/kanban-store';

const expectInitialState = (): true | Error => {
  const state = useKanbanStore.getState();
  if (state.loading !== false) {
    return new Error(`expected initial loading=false, got ${String(state.loading)}`);
  }
  if (state.lastOutboundAction !== null) {
    return new Error(
      `expected initial lastOutboundAction=null, got ${String(state.lastOutboundAction)}`,
    );
  }
  if (state.error !== null) {
    return new Error(`expected initial error=null, got ${String(state.error)}`);
  }
  return true;
};

describe('kanban-store outbound dispatch integration', () => {
  beforeEach(() => {
    useKanbanStore.setState({ loading: false, lastOutboundAction: null, error: null });
    const ok = expectInitialState();
    if (ok !== true) throw ok;
  });

  it('flags loading + lastOutboundAction when sendKanban is called', () => {
    useKanbanStore.getState().sendKanban('kanban.task.transition', { to: 'done' });
    const state = useKanbanStore.getState();
    expect(state.loading).toBe(true);
    expect(state.lastOutboundAction).toBe('kanban.task.transition');
  });

  it('transitionTask sets the same wire flag', () => {
    useKanbanStore
      .getState()
      .transitionTask('board-1', 'task-1', 'done', { attachment: 'url', comment: 'note' });
    const state = useKanbanStore.getState();
    expect(state.loading).toBe(true);
    expect(state.lastOutboundAction).toBe('kanban.task.transition');
  });

  it('dispatchTask sets the wire flag to the dispatch action', () => {
    useKanbanStore.getState().dispatchTask('board-1', 'task-1', 'investigate this');
    const state = useKanbanStore.getState();
    expect(state.loading).toBe(true);
    expect(state.lastOutboundAction).toBe('kanban.task.dispatch');
  });

  it('moveTask sets the wire flag to the move action', () => {
    useKanbanStore.getState().moveTask('board-1', 'task-1', 'review');
    const state = useKanbanStore.getState();
    expect(state.loading).toBe(true);
    expect(state.lastOutboundAction).toBe('kanban.task.move');
  });

  it('removeTask sets the wire flag to the remove action', () => {
    useKanbanStore.getState().removeTask('board-1', 'task-1');
    const state = useKanbanStore.getState();
    expect(state.loading).toBe(true);
    expect(state.lastOutboundAction).toBe('kanban.task.remove');
  });

  it('handleResult flips loading off on success and surfaces no error', () => {
    useKanbanStore.getState().sendKanban('kanban.task.transition', { to: 'done' });
    expect(useKanbanStore.getState().loading).toBe(true);

    useKanbanStore.getState().handleResult('kanban.task.transition', {
      success: true,
      data: { status: 'completed' },
    });

    const state = useKanbanStore.getState();
    expect(state.loading).toBe(false);
    expect(state.error).toBeNull();
  });

  it('handleResult flips loading off on failure and surfaces the error message', () => {
    useKanbanStore.getState().sendKanban('kanban.task.transition', { to: 'done' });
    expect(useKanbanStore.getState().loading).toBe(true);

    useKanbanStore.getState().handleResult('kanban.task.transition', {
      success: false,
      error: 'lifecycle guard rejected',
    });

    const state = useKanbanStore.getState();
    expect(state.loading).toBe(false);
    expect(state.error).toBe('lifecycle guard rejected');
  });

  it('does not reflag loading when a stale inbound result arrives without a pending outbound', () => {
    expect(useKanbanStore.getState().loading).toBe(false);

    useKanbanStore.getState().handleResult('kanban.list', { success: true, data: [] });

    const state = useKanbanStore.getState();
    expect(state.loading).toBe(false);
  });
});
