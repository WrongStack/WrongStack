import { beforeEach, describe, expect, it } from 'vitest';
import { useHistoryStore } from '../../src/stores/history-store';

function makeEntry(
  overrides: Partial<{
    id: string;
    title: string;
    startedAt: string;
    model: string;
    provider: string;
  }> = {},
): {
  id: string;
  title: string;
  startedAt: string;
  model: string;
  provider: string;
  tokenTotal: number;
  isCurrent: boolean;
} {
  return {
    id: 'id-1',
    title: 'Test Session',
    startedAt: '2024-01-01T00:00:00.000Z',
    model: 'anthropic-test-model',
    provider: 'anthropic',
    tokenTotal: 0,
    isCurrent: false,
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

// ── updateEntryName ────────────────────────────────────────────────

describe('updateEntryName', () => {
  beforeEach(() => resetStore());

  it('sets a trimmed name on the matching entry', () => {
    useHistoryStore.setState({ entries: [makeEntry({ id: 's1' })] });
    useHistoryStore.getState().updateEntryName('s1', '  Refactor pass  ');
    expect(useHistoryStore.getState().entries[0]).toMatchObject({ name: 'Refactor pass' });
  });

  it('overwrites an existing name', () => {
    useHistoryStore.setState({ entries: [{ ...makeEntry({ id: 's1' }), name: 'Old' }] });
    useHistoryStore.getState().updateEntryName('s1', 'New');
    expect(useHistoryStore.getState().entries[0]).toMatchObject({ name: 'New' });
  });

  it('leaves other entries untouched', () => {
    useHistoryStore.setState({
      entries: [makeEntry({ id: 's1' }), { ...makeEntry({ id: 's2' }), name: 'Keep me' }],
    });
    useHistoryStore.getState().updateEntryName('s1', 'Renamed');
    expect(useHistoryStore.getState().entries[1]).toMatchObject({ id: 's2', name: 'Keep me' });
  });

  it('removes the name key entirely when given an empty string', () => {
    useHistoryStore.setState({ entries: [{ ...makeEntry({ id: 's1' }), name: 'Old name' }] });
    useHistoryStore.getState().updateEntryName('s1', '');
    // The key is deleted rather than set to '' so the UI falls back to its
    // default label instead of rendering a blank title.
    expect(useHistoryStore.getState().entries[0]).not.toHaveProperty('name');
  });

  it('treats a whitespace-only name as a clear', () => {
    useHistoryStore.setState({ entries: [{ ...makeEntry({ id: 's1' }), name: 'Old name' }] });
    useHistoryStore.getState().updateEntryName('s1', '   \t ');
    expect(useHistoryStore.getState().entries[0]).not.toHaveProperty('name');
  });

  it('preserves the rest of the entry when clearing the name', () => {
    useHistoryStore.setState({
      entries: [{ ...makeEntry({ id: 's1', title: 'Test Session' }), name: 'Old' }],
    });
    useHistoryStore.getState().updateEntryName('s1', '');
    expect(useHistoryStore.getState().entries[0]).toMatchObject({
      id: 's1',
      title: 'Test Session',
    });
  });

  it('is a no-op when the id does not exist', () => {
    useHistoryStore.setState({ entries: [{ ...makeEntry({ id: 's1' }), name: 'Keep' }] });
    useHistoryStore.getState().updateEntryName('missing', 'New');
    expect(useHistoryStore.getState().entries[0]).toMatchObject({ name: 'Keep' });
  });

  it('is safe on an empty list', () => {
    expect(() => useHistoryStore.getState().updateEntryName('s1', 'x')).not.toThrow();
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
