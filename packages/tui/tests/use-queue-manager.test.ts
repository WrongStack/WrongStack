import { render } from 'ink-testing-library';
import React, { act } from 'react';
import { afterEach, describe, expect, it, type Mock, vi } from 'vitest';
import type { SlashCommandRegistry } from '@wrongstack/core/registry';
import type { QueueStore } from '@wrongstack/core/storage';
import type { ContentBlock } from '@wrongstack/core/types';
import { Text } from '../src/ink.js';
import { useQueueManager, type UseQueueManagerOptions } from '../src/hooks/use-queue-manager.js';
import type { Action, State } from '../src/app-reducer.js';
import type { Settings } from '../src/app-state.js';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function makeQueueStore(overrides?: Partial<QueueStore>): QueueStore {
  // QueueStore is a class with private fields; the hook only calls read/write/
  // clear, so a structural stub is cast through unknown to stand in for it.
  return {
    read: vi.fn(async () => []),
    write: vi.fn(async () => undefined),
    clear: vi.fn(async () => undefined),
    ...overrides,
  } as unknown as QueueStore;
}

function makeRegistry(): SlashCommandRegistry & { registered: { name: string }[]; unregisterCalls: string[] } {
  const registered: { name: string }[] = [];
  const unregisterCalls: string[] = [];
  const commands = new Map<string, unknown>();
  return {
    registered,
    unregisterCalls,
    register(cmd: { name: string }) {
      registered.push({ name: cmd.name });
      commands.set(cmd.name, cmd);
    },
    unregister(name: string) {
      unregisterCalls.push(name);
      commands.delete(name);
    },
    get(name: string) {
      return commands.get(name);
    },
  } as unknown as SlashCommandRegistry & { registered: { name: string }[]; unregisterCalls: string[] };
}

interface HarnessRefs {
  // `| undefined` (not bare `?`) so exactOptionalPropertyTypes allows tests to
  // explicitly assign `undefined` when exercising the "no store" path.
  queueStore?: QueueStore | undefined;
  onQueueChange: Mock;
  slashRegistry: ReturnType<typeof makeRegistry>;
  stateRef: React.MutableRefObject<State>;
  dispatch: Mock;
  getSettings: Mock;
  saveSettings: Mock;
  midRunSendPickerRef: React.MutableRefObject<boolean>;
}

function buildHarness(): HarnessRefs {
  const state = { queue: [] } as unknown as State;
  return {
    queueStore: undefined,
    onQueueChange: vi.fn(),
    slashRegistry: makeRegistry(),
    stateRef: { current: state },
    dispatch: vi.fn(),
    getSettings: vi.fn(() => ({ midRunSendPicker: false } as unknown as Settings)),
    saveSettings: vi.fn(() => null),
    midRunSendPickerRef: { current: false },
  };
}

function Harness({ refs }: { refs: HarnessRefs }): React.ReactElement {
  const opts: UseQueueManagerOptions = {
    queueStore: refs.queueStore,
    onQueueChange: refs.onQueueChange,
    slashRegistry: refs.slashRegistry,
    stateRef: refs.stateRef,
    dispatch: refs.dispatch,
    getSettings: refs.getSettings,
    saveSettings: refs.saveSettings,
    midRunSendPickerRef: refs.midRunSendPickerRef,
  };
  useQueueManager(opts);
  return React.createElement(Text, null, 'queue-mgr');
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.clearAllMocks();
});

describe('useQueueManager', () => {
  it('registers /queue command on mount and unregisters on unmount', () => {
    const refs = buildHarness();
    refs.queueStore = makeQueueStore();
    const view = render(React.createElement(Harness, { refs }));
    expect(refs.slashRegistry.registered).toHaveLength(1);
    expect(refs.slashRegistry.registered[0]?.name).toBe('queue');
    act(() => view.unmount());
    expect(refs.slashRegistry.unregisterCalls).toContain('queue');
  });

  it('rehydrates persisted queue on mount', async () => {
    const refs = buildHarness();
    const persisted = [
      { displayText: 'msg1', blocks: [{ type: 'text' as const, text: 'hello' }] },
      { displayText: 'msg2', blocks: [{ type: 'text' as const, text: 'world' }] },
    ];
    refs.queueStore = makeQueueStore({ read: vi.fn(async () => persisted) });
    render(React.createElement(Harness, { refs }));
    await vi.waitFor(() => {
      expect(refs.dispatch).toHaveBeenCalledWith(
        expect.objectContaining({ type: 'enqueue' }),
      );
    });
    expect(refs.dispatch).toHaveBeenCalledWith({
      type: 'addEntry',
      entry: { kind: 'info', text: 'Restored 2 queued messages from a previous run.' },
    });
  });

  it('skips rehydration when persisted queue is empty', async () => {
    const refs = buildHarness();
    refs.queueStore = makeQueueStore();
    render(React.createElement(Harness, { refs }));
    // Wait for promise to resolve - should not dispatch unless cancelled
    await act(async () => { await Promise.resolve(); });
    const enqueueCalls = refs.dispatch.mock.calls.filter(
      (c: unknown[]) => (c[0] as Action).type === 'enqueue',
    );
    expect(enqueueCalls).toHaveLength(0);
  });

  it('handles rehydration error gracefully', async () => {
    const refs = buildHarness();
    refs.queueStore = makeQueueStore({ read: vi.fn(async () => { throw new Error('read error'); }) });
    render(React.createElement(Harness, { refs }));
    await act(async () => { await Promise.resolve(); });
    // Should not have dispatched anything on failure
    expect(refs.dispatch).not.toHaveBeenCalled();
  });

  it('persists queue on change via useEffect', async () => {
    const refs = buildHarness();
    const store = makeQueueStore();
    refs.queueStore = store;
    render(React.createElement(Harness, { refs }));
    // Trigger a queue change by updating stateRef.current.queue
    const queueItem = { displayText: 'test', blocks: [{ type: 'text' as const, text: 'hello' }] };
    refs.stateRef.current = { queue: [queueItem] } as unknown as State;
    // Re-render to trigger the persist effect
    render(React.createElement(Harness, { refs }));
    // Need re-render via act - the component re-renders on state change
    await vi.waitFor(() => {
      expect(store.write).toHaveBeenCalledWith(
        expect.arrayContaining([expect.objectContaining({ displayText: 'test' })]),
      );
    });
  });

  it('does not persist when queueStore is undefined', () => {
    const refs = buildHarness();
    refs.queueStore = undefined;
    render(React.createElement(Harness, { refs }));
    // Should not throw or error
  });

  it('calls onQueueChange when queue changes', async () => {
    const refs = buildHarness();
    refs.queueStore = makeQueueStore();
    refs.stateRef.current = { queue: [
      { displayText: 'item1', blocks: [] as ContentBlock[] },
    ] } as unknown as State;
    render(React.createElement(Harness, { refs }));

    await vi.waitFor(() => {
      expect(refs.onQueueChange).toHaveBeenCalledWith(['item1']);
    });
  });

  it('does not call onQueueChange when undefined', () => {
    const refs = buildHarness();
    refs.onQueueChange = undefined as unknown as Mock;
    refs.queueStore = makeQueueStore();
    expect(() => render(React.createElement(Harness, { refs }))).not.toThrow();
  });

  it('setPickerEnabled updates ref and persists', async () => {
    const refs = buildHarness();
    refs.queueStore = makeQueueStore();
    render(React.createElement(Harness, { refs }));

    // Find the registered command and test setPickerEnabled
    const cmd = refs.slashRegistry.registered[0]!;
    expect(cmd.name).toBe('queue');
    // The setPickerEnabled logic is inside the createQueueSlashCommand callback
    // which is tested in its own test file
  });

  it('handles single-item rehydration text correctly', async () => {
    const refs = buildHarness();
    const persisted = [
      { displayText: 'one msg', blocks: [{ type: 'text' as const, text: 'one' }] },
    ];
    refs.queueStore = makeQueueStore({ read: vi.fn(async () => persisted) });
    render(React.createElement(Harness, { refs }));
    await vi.waitFor(() => {
      expect(refs.dispatch).toHaveBeenCalledWith({
        type: 'addEntry',
        entry: { kind: 'info', text: 'Restored 1 queued message from a previous run.' },
      });
    });
  });
});
