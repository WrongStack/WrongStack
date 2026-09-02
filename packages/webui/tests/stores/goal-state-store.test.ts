import { beforeEach, describe, expect, it, vi } from 'vitest';

const mockSend = vi.fn();
let clientImpl: () => unknown = () => ({ send: mockSend });

vi.mock('@/lib/ws-client', () => ({ getWSClient: () => clientImpl() }));

const { useGoalStateStore } = await import('../../src/stores/goal-state-store');

function seedGoal(overrides: Record<string, unknown> = {}) {
  useGoalStateStore.getState().setGoal({
    goal: 'Ship the thing',
    goalState: 'active',
    iterations: 3,
    lastTask: 'wire the handler',
    lastStatus: 'running',
    journal: [{ iteration: 3, task: 'wire the handler', status: 'running' }],
    ...overrides,
  });
}

describe('goal state store', () => {
  beforeEach(() => {
    useGoalStateStore.setState({ goal: null });
    mockSend.mockReset();
    clientImpl = () => ({ send: mockSend });
  });

  it('starts with no goal', () => {
    expect(useGoalStateStore.getState().goal).toBeNull();
  });

  it('setGoal parses a raw goal.json payload', () => {
    seedGoal();
    const goal = useGoalStateStore.getState().goal;
    expect(goal).not.toBeNull();
    expect(goal?.iterations).toBe(3);
  });

  it('setGoal(null) clears the parsed goal', () => {
    seedGoal();
    useGoalStateStore.getState().setGoal(null);
    expect(useGoalStateStore.getState().goal).toBeNull();
  });

  it('clear() resets to no goal', () => {
    seedGoal();
    useGoalStateStore.getState().clear();
    expect(useGoalStateStore.getState().goal).toBeNull();
  });

  it('appendJournalEntry is a no-op when there is no goal', () => {
    useGoalStateStore.getState().appendJournalEntry({
      iteration: 1,
      task: 'orphan',
      status: 'done',
    });
    expect(useGoalStateStore.getState().goal).toBeNull();
  });

  it('prepends the newest journal entry', () => {
    seedGoal();
    useGoalStateStore.getState().appendJournalEntry({
      iteration: 4,
      task: 'add tests',
      status: 'done',
    });
    const journal = useGoalStateStore.getState().goal?.journal ?? [];
    expect(journal[0]?.task).toBe('add tests');
    expect(journal).toHaveLength(2);
  });

  it('advances the iteration counter but never rewinds it', () => {
    seedGoal();
    useGoalStateStore.getState().appendJournalEntry({ iteration: 7, task: 'x', status: 'done' });
    expect(useGoalStateStore.getState().goal?.iterations).toBe(7);

    // An out-of-order (older) entry must not roll the counter back.
    useGoalStateStore.getState().appendJournalEntry({ iteration: 2, task: 'y', status: 'done' });
    expect(useGoalStateStore.getState().goal?.iterations).toBe(7);
  });

  it('updates lastTask/lastStatus from the entry', () => {
    seedGoal();
    useGoalStateStore.getState().appendJournalEntry({
      iteration: 4,
      task: 'new task',
      status: 'failed',
    });
    const goal = useGoalStateStore.getState().goal;
    expect(goal?.lastTask).toBe('new task');
    expect(goal?.lastStatus).toBe('failed');
  });

  it('keeps the previous lastTask/lastStatus when the entry omits them', () => {
    seedGoal();
    useGoalStateStore.getState().appendJournalEntry({ iteration: 4 });
    const goal = useGoalStateStore.getState().goal;
    expect(goal?.lastTask).toBe('wire the handler');
    expect(goal?.lastStatus).toBe('running');
  });

  it('caps the journal at 200 entries, keeping the newest', () => {
    seedGoal({ journal: [] });
    for (let i = 1; i <= 205; i++) {
      useGoalStateStore
        .getState()
        .appendJournalEntry({ iteration: i, task: `t${i}`, status: 'done' });
    }
    const journal = useGoalStateStore.getState().goal?.journal ?? [];
    expect(journal).toHaveLength(200);
    expect(journal[0]?.task).toBe('t205');
    expect(journal.at(-1)?.task).toBe('t6');
  });

  it('handles a goal that arrived without a journal array', () => {
    seedGoal({ journal: undefined });
    useGoalStateStore
      .getState()
      .appendJournalEntry({ iteration: 4, task: 'first', status: 'done' });
    expect(useGoalStateStore.getState().goal?.journal).toHaveLength(1);
  });

  it('refresh() asks the server for the latest goal state', () => {
    useGoalStateStore.getState().refresh();
    expect(mockSend).toHaveBeenCalledWith({ type: 'goal-state.get' });
  });

  it('refresh() swallows a throwing ws-client instead of breaking the caller', () => {
    clientImpl = () => {
      throw new Error('not connected');
    };
    expect(() => useGoalStateStore.getState().refresh()).not.toThrow();
  });

  it('refresh() tolerates a client with no send method', () => {
    clientImpl = () => ({});
    expect(() => useGoalStateStore.getState().refresh()).not.toThrow();
  });

  it('refresh() tolerates a null client', () => {
    clientImpl = () => null;
    expect(() => useGoalStateStore.getState().refresh()).not.toThrow();
  });
});
