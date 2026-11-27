import type { MemoryEntry, MemoryPort } from '@wrongstack/contracts/types';
import { render } from 'ink-testing-library';
import React, { act } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { reducer } from '../src/app-reducer.js';
import { MemoryPanel } from '../src/components/memory-panel.js';
import { useMemoryPanel } from '../src/hooks/use-memory-panel.js';
import { createMemorySlashCommand } from '../src/memory-slash.js';
import { initial } from './reducer.test.js';

function entry(text: string, scope: MemoryEntry['scope'] = 'project-memory'): MemoryEntry {
  return { scope, text, ts: '2026-01-01T00:00:00.000Z', tags: ['build'] };
}

describe('memoryPanel reducer', () => {
  it('opens closed other panels, resets selection/filter and marks busy', () => {
    const base = initial({ planPanelOpen: true });
    const out = reducer(base, { type: 'memoryPanelOpen' });
    expect(out.memoryPanel.open).toBe(true);
    expect(out.memoryPanel.busy).toBe(true);
    expect(out.memoryPanel.entries).toEqual([]);
    expect(out.memoryPanel.selected).toBe(0);
    expect(out.memoryPanel.filter).toBe('');
    expect(out.planPanelOpen).toBe(false);
  });

  it('close keeps entries but flips open off', () => {
    let out = reducer(initial(), { type: 'memoryPanelOpen' });
    out = reducer(out, { type: 'memoryPanelSetEntries', entries: [entry('a')] });
    out = reducer(out, { type: 'memoryPanelClose' });
    expect(out.memoryPanel.open).toBe(false);
    expect(out.memoryPanel.entries).toHaveLength(1);
  });

  it('move clamps to the entry bounds', () => {
    let out = reducer(initial(), { type: 'memoryPanelOpen' });
    out = reducer(out, { type: 'memoryPanelSetEntries', entries: [entry('a'), entry('b')] });
    out = reducer(out, { type: 'memoryPanelMove', delta: -5 });
    expect(out.memoryPanel.selected).toBe(0);
    out = reducer(out, { type: 'memoryPanelMove', delta: 99 });
    expect(out.memoryPanel.selected).toBe(1);
  });

  it('setEntries clears busy and re-clamps a now-out-of-range selection', () => {
    let out = reducer(initial(), { type: 'memoryPanelOpen' });
    out = reducer(out, {
      type: 'memoryPanelSetEntries',
      entries: [entry('a'), entry('b'), entry('c')],
    });
    out = reducer(out, { type: 'memoryPanelMove', delta: 2 });
    out = reducer(out, { type: 'memoryPanelSetEntries', entries: [entry('a')] });
    expect(out.memoryPanel.busy).toBe(false);
    expect(out.memoryPanel.selected).toBe(0);
  });

  it('setFilter resets selection and marks busy for the reload', () => {
    let out = reducer(initial(), { type: 'memoryPanelOpen' });
    out = reducer(out, { type: 'memoryPanelSetEntries', entries: [entry('a'), entry('b')] });
    out = reducer(out, { type: 'memoryPanelMove', delta: 1 });
    out = reducer(out, { type: 'memoryPanelSetFilter', filter: 'x' });
    expect(out.memoryPanel.filter).toBe('x');
    expect(out.memoryPanel.selected).toBe(0);
    expect(out.memoryPanel.busy).toBe(true);
  });
});

describe('MemoryPanel component', () => {
  const entries = [entry('first memory'), entry('second memory', 'user-memory')];

  it('renders entries, scope tags and the filter row at a wide viewport', () => {
    const view = render(
      React.createElement(MemoryPanel, {
        entries,
        selected: 0,
        filter: '',
        busy: false,
        maxRows: 30,
        columns: 120,
      }),
    );
    const frame = view.lastFrame() ?? '';
    expect(frame).toContain('Memory');
    expect(frame).toContain('2 entries');
    expect(frame).toContain('first memory');
    expect(frame).toContain('[proj]');
    expect(frame).toContain('[user]');
    expect(frame).toContain('type to filter');
    view.unmount();
  });

  it('windows a long list at a short viewport and shows the range marker', () => {
    const many = Array.from({ length: 40 }, (_, i) => entry(`memory number ${i}`));
    const view = render(
      React.createElement(MemoryPanel, {
        entries: many,
        selected: 0,
        filter: '',
        busy: false,
        maxRows: 10,
        columns: 80,
      }),
    );
    const frame = view.lastFrame() ?? '';
    expect(frame).toContain('memory number 0');
    expect(frame).not.toContain('memory number 39');
    expect(frame).toMatch(/1–\d+\/40/);
    view.unmount();
  });

  it('shows an empty state and a loading state', () => {
    const empty = render(
      React.createElement(MemoryPanel, {
        entries: [],
        selected: 0,
        filter: '',
        busy: false,
        maxRows: 20,
      }),
    );
    expect(empty.lastFrame() ?? '').toContain('No memories match');
    empty.unmount();
    const loading = render(
      React.createElement(MemoryPanel, {
        entries: [],
        selected: 0,
        filter: '',
        busy: true,
        maxRows: 20,
      }),
    );
    expect(loading.lastFrame() ?? '').toContain('Loading memory');
    loading.unmount();
  });
});

describe('useMemoryPanel stale-result guard', () => {
  function deferred<T>() {
    let resolve!: (value: T) => void;
    const promise = new Promise<T>((r) => {
      resolve = r;
    });
    return { promise, resolve };
  }

  it('drops a load that resolves after the panel closes', async () => {
    vi.useFakeTimers();
    const slow = deferred<MemoryEntry[]>();
    const store = { list: () => slow.promise, search: () => slow.promise } as unknown as MemoryPort;
    const dispatch = vi.fn();

    function Harness({ open }: { open: boolean }) {
      useMemoryPanel({ dispatch: dispatch as never, memoryStore: store, open, filter: '' });
      return null;
    }

    let view!: ReturnType<typeof render>;
    act(() => {
      view = render(React.createElement(Harness, { open: true }));
    });
    // Empty filter loads on a 0ms timeout; start the in-flight load.
    act(() => vi.advanceTimersByTime(0));
    expect(dispatch).not.toHaveBeenCalled();

    // Close before the load resolves — the generation guard must drop it.
    act(() => {
      view.rerender(React.createElement(Harness, { open: false }));
    });
    await act(async () => {
      slow.resolve([entry('late')]);
      await slow.promise;
    });
    expect(dispatch).not.toHaveBeenCalled();
    act(() => view.unmount());
    vi.useRealTimers();
  });

  it('commits a load that resolves while still open', async () => {
    vi.useFakeTimers();
    const slow = deferred<MemoryEntry[]>();
    const store = { list: () => slow.promise, search: () => slow.promise } as unknown as MemoryPort;
    const dispatch = vi.fn();
    function Harness() {
      useMemoryPanel({ dispatch: dispatch as never, memoryStore: store, open: true, filter: '' });
      return null;
    }
    let view!: ReturnType<typeof render>;
    act(() => {
      view = render(React.createElement(Harness));
    });
    act(() => vi.advanceTimersByTime(0));
    await act(async () => {
      slow.resolve([entry('fresh')]);
      await slow.promise;
    });
    expect(dispatch).toHaveBeenCalledWith({
      type: 'memoryPanelSetEntries',
      entries: [entry('fresh')],
    });
    act(() => view.unmount());
    vi.useRealTimers();
  });
});

describe('bare /memory trigger', () => {
  const store = {
    list: async () => [],
    search: async () => [],
    readAll: async () => '',
  } as unknown as MemoryPort;

  it('opens the panel for empty args when the host wired it', async () => {
    const onOpenPanel = vi.fn(() => true);
    const cmd = createMemorySlashCommand({ memoryStore: store, onOpenPanel });
    const result = await cmd.run('');
    expect(onOpenPanel).toHaveBeenCalledTimes(1);
    expect(result.message).toBe('');
  });

  it('keeps the text path for any argument', async () => {
    const onOpenPanel = vi.fn(() => true);
    const cmd = createMemorySlashCommand({ memoryStore: store, onOpenPanel });
    await cmd.run('--limit 5');
    expect(onOpenPanel).not.toHaveBeenCalled();
  });

  it('falls back to text when the panel cannot open', async () => {
    const onOpenPanel = vi.fn(() => false);
    const cmd = createMemorySlashCommand({ memoryStore: store, onOpenPanel });
    const result = await cmd.run('');
    expect(onOpenPanel).toHaveBeenCalledTimes(1);
    // Not the panel-open empty message — the stats text path ran instead.
    expect(result.message).not.toBe('');
  });
});
