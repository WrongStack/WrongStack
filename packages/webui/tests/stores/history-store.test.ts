import { beforeEach, describe, expect, it } from 'vitest';
import { useHistoryStore } from '../../src/stores/history-store';

function makeEntry(overrides: Partial<{ id: string; title: string; startedAt: string; model: string; provider: string }> = {}): { id: string; title: string; startedAt: string; model: string; provider: string } {
  return {
    id: 'id-1',
    title: 'Test Session',
    startedAt: '2024-01-01T00:00:00.000Z',
    model: 'anthropic-test-model',
    provider: 'anthropic',
    ...overrides,
  };
}

function resetStore() {
  useHistoryStore.setState({ entries: [], loading: false, error: null });
}

// ── setEntries ──────────────────────────────────────────────────────

describe('setEntries', () => {
  beforeEach(() => resetStore());

  it('sets entries and resets loading', () => {
    const entries = [makeEntry({ id: 's1' }), makeEntry({ id: 's2' })];
    useHistoryStore.getState().setEntries(entries);
    expect(useHistoryStore.getState().entries).toHaveLength(2);
    expect(useHistoryStore.getState().loading).toBe(false);
  });

  it('sets error when provided', () => {
    const entries = [makeEntry()];
    useHistoryStore.getState().setEntries(entries, 'network error');
    expect(useHistoryStore.getState().error).toBe('network error');
  });

  it('defaults error to null', () => {
    useHistoryStore.setState({ error: 'previous' });
    useHistoryStore.getState().setEntries([]);
    expect(useHistoryStore.getState().error).toBe(null);
  });
});

// ── setLoading ──────────────────────────────────────────────────────

describe('setLoading', () => {
  beforeEach(() => resetStore());

  it('sets loading to true', () => {
    useHistoryStore.getState().setLoading(true);
    expect(useHistoryStore.getState().loading).toBe(true);
  });

  it('sets loading to false', () => {
    useHistoryStore.setState({ loading: true });
    useHistoryStore.getState().setLoading(false);
    expect(useHistoryStore.getState().loading).toBe(false);
  });
});

// ── removeEntry ────────────────────────────────────────────────────

describe('removeEntry', () => {
  beforeEach(() => resetStore());

  it('removes the entry with matching id', () => {
    useHistoryStore.setState({
      entries: [makeEntry({ id: 's1' }), makeEntry({ id: 's2' })],
    });
    useHistoryStore.getState().removeEntry('s1');
    const entries = useHistoryStore.getState().entries;
    expect(entries).toHaveLength(1);
    expect(entries[0].id).toBe('s2');
  });

  it('is a no-op when id does not exist', () => {
    useHistoryStore.setState({
      entries: [makeEntry({ id: 's1' })],
    });
    useHistoryStore.getState().removeEntry('non-existent');
    expect(useHistoryStore.getState().entries).toHaveLength(1);
  });

  it('handles empty entries', () => {
    useHistoryStore.getState().removeEntry('any-id'); // should not throw
    expect(useHistoryStore.getState().entries).toHaveLength(0);
  });
});

// ── clearHistory ───────────────────────────────────────────────────

describe('clearHistory', () => {
  beforeEach(() => resetStore());

  it('clears all entries', () => {
    useHistoryStore.setState({
      entries: [makeEntry({ id: 's1' }), makeEntry({ id: 's2' })],
    });
    useHistoryStore.getState().clearHistory();
    expect(useHistoryStore.getState().entries).toHaveLength(0);
  });

  it('is safe when already empty', () => {
    useHistoryStore.getState().clearHistory();
    expect(useHistoryStore.getState().entries).toHaveLength(0);
  });
});
