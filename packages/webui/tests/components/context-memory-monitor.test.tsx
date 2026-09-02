import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ContextMemoryMonitor } from '../../src/components/ContextMemoryMonitor.js';
import { useMemoryInjectorTraceStore } from '../../src/stores/memory-injector-store.js';
import { memoryTrace } from '../fixtures/memory-trace.js';

beforeEach(() => useMemoryInjectorTraceStore.getState().clear());
afterEach(cleanup);

describe('ContextMemoryMonitor', () => {
  it('shows full evidence and exact came/went transitions outside the summary widget', () => {
    const store = useMemoryInjectorTraceStore.getState();
    store.pushTrace(memoryTrace());
    store.applyContextSnapshot({
      at: '2026-07-19T16:00:01.000Z',
      activeMemoryIds: ['mem_auth_contract'],
      enteredMemoryIds: ['mem_auth_contract'],
      exitedMemoryIds: [],
    });
    store.applyContextSnapshot({
      at: '2026-07-19T16:00:02.000Z',
      activeMemoryIds: [],
      enteredMemoryIds: [],
      exitedMemoryIds: ['mem_auth_contract'],
    });

    render(<ContextMemoryMonitor />);

    expect(screen.getByText('refreshSession rotates refresh tokens.')).toBeTruthy();
    expect(screen.getByText(/why: anchor:path-match/)).toBeTruthy();
    expect(screen.getAllByText(/score 0.93/).length).toBeGreaterThan(0);
    expect(screen.getAllByText('exited').length).toBeGreaterThan(0);
    expect(screen.getByText('0 ctx')).toBeTruthy();
    expect(screen.getByText('0 pending')).toBeTruthy();
    expect(screen.getByText('1 left')).toBeTruthy();
  });

  it('does not erase provider-confirmed context state when the same memory is reinjected', () => {
    const store = useMemoryInjectorTraceStore.getState();
    store.pushTrace(memoryTrace());
    store.applyContextSnapshot({
      at: '2026-07-19T16:00:01.000Z',
      activeMemoryIds: ['mem_auth_contract'],
      enteredMemoryIds: ['mem_auth_contract'],
      exitedMemoryIds: [],
    });
    store.pushTrace({ ...memoryTrace(), runId: 'run_reinject', at: '2026-07-19T16:00:02.000Z' });

    render(<ContextMemoryMonitor />);

    expect(screen.getByText('1 ctx')).toBeTruthy();
    expect(screen.getByText('0 pending')).toBeTruthy();
  });

  it('prunes exited context memories past the retention cap (memory leak guard)', () => {
    const store = useMemoryInjectorTraceStore.getState();
    // Inject + exit 250 distinct memories; only 200 exited may be retained.
    const base = Date.UTC(2026, 6, 19, 16, 0, 0);
    for (let i = 0; i < 250; i++) {
      const id = `mem_exit_${i}`;
      const at = new Date(base + i * 1_000).toISOString();
      store.pushTrace({
        ...memoryTrace(),
        runId: `run_${i}`,
        at,
        injected: [{ ...memoryTrace().injected[0]!, id, text: `memory body ${i}` }],
        activated: [{ ...memoryTrace().activated[0]!, id, text: `memory body ${i}` }],
      });
      store.applyContextSnapshot({
        at: new Date(base + i * 1_000 + 500).toISOString(),
        activeMemoryIds: [],
        enteredMemoryIds: [],
        exitedMemoryIds: [id],
      });
    }
    const memories = Object.values(useMemoryInjectorTraceStore.getState().contextMemories);
    const exited = memories.filter((m) => m.state === 'exited');
    expect(exited.length).toBeLessThanOrEqual(200);
    // Newest exited ids survive; oldest are dropped.
    expect(useMemoryInjectorTraceStore.getState().contextMemories['mem_exit_249']).toBeDefined();
    expect(useMemoryInjectorTraceStore.getState().contextMemories['mem_exit_0']).toBeUndefined();
  });

  it('caps stored memory text so large injections cannot bloat the browser store', () => {
    const longText = 'x'.repeat(2_000);
    const store = useMemoryInjectorTraceStore.getState();
    store.pushTrace({
      ...memoryTrace(),
      injected: [{ ...memoryTrace().injected[0]!, text: longText }],
      activated: [{ ...memoryTrace().activated[0]!, text: longText }],
    });
    const mem = useMemoryInjectorTraceStore.getState().contextMemories['mem_auth_contract'];
    expect(mem?.text.length).toBeLessThanOrEqual(300);
    expect(
      useMemoryInjectorTraceStore.getState().traces[0]?.injected[0]?.text.length,
    ).toBeLessThanOrEqual(300);
  });
});
