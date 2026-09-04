import { describe, expect, it } from 'vitest';
import {
  activeMemoryContextCount,
  applyMemoryContextSnapshot,
  applyMemoryInjectorRun,
  emptyMemoryContextMonitor,
  memoryEventMatchesSession,
  readMemoryRecordTotal,
} from '../src/memory-context-monitor.js';

describe('TUI memory context monitor', () => {
  // The widget this state used to render was removed (superseded by the
  // context panel + the statusline memory chip), but the monitor-state
  // transitions it exercised are production logic behind that chip. Kept
  // verbatim minus the rendering assertions.
  it('tracks injection, activation, re-injection and exact exits', () => {
    const injected = applyMemoryInjectorRun(emptyMemoryContextMonitor(), {
      at: '2026-07-19T16:00:00.000Z',
      trigger: 'read',
      candidates: 5,
      contextPressure: 0.42,
      injectedChars: 380,
      rejected: { belowScore: 2 },
      injected: [
        {
          id: 'mem_auth',
          kind: 'fact',
          text: 'Rotate refresh tokens.',
          score: 0.9,
          confidence: 0.95,
          freshness: 0.8,
          importance: 0.9,
          persistence: 'long_lived',
          anchors: [],
          tags: ['auth'],
          activationReasons: ['tag:#auth'],
        },
        { id: 'mem_second', text: 'Second memory.' },
        { id: 'mem_third', text: 'Third memory.' },
      ],
    });
    // Injected but not yet reported active by a snapshot: still 0 in context.
    expect(activeMemoryContextCount(injected)).toBe(0);

    const active = applyMemoryContextSnapshot(injected, {
      at: '2026-07-19T16:00:01.000Z',
      activeMemoryIds: ['mem_auth', 'mem_second', 'mem_third'],
      enteredMemoryIds: ['mem_auth', 'mem_second', 'mem_third'],
      exitedMemoryIds: [],
    });
    expect(activeMemoryContextCount(active)).toBe(3);

    // Re-injecting an already-active memory must not double-count it.
    const reinjected = applyMemoryInjectorRun(active, {
      at: '2026-07-19T16:00:01.500Z',
      trigger: 'read',
      candidates: 1,
      injected: [{ id: 'mem_auth', text: 'Rotate refresh tokens.' }],
    });
    expect(activeMemoryContextCount(reinjected)).toBe(3);

    const exited = applyMemoryContextSnapshot(active, {
      at: '2026-07-19T16:00:02.000Z',
      activeMemoryIds: [],
      enteredMemoryIds: [],
      exitedMemoryIds: ['mem_auth', 'mem_second', 'mem_third'],
    });
    expect(Object.values(exited.memories).every((memory) => memory.state === 'exited')).toBe(true);
    expect(activeMemoryContextCount(exited)).toBe(0);

    // An authoritative empty snapshot clears the count even without an
    // explicit exit list.
    const authoritativeEmptySnapshot = applyMemoryContextSnapshot(active, {
      at: '2026-07-19T16:00:03.000Z',
      activeMemoryIds: [],
      enteredMemoryIds: [],
      exitedMemoryIds: [],
    });
    expect(activeMemoryContextCount(authoritativeEmptySnapshot)).toBe(0);
  });

  it('reads the all-status record total from a SAGE-compatible store', async () => {
    expect(await readMemoryRecordTotal({ stats: async () => ({ total: 6261 }) })).toBe(6261);
    expect(await readMemoryRecordTotal({})).toBeUndefined();
  });

  it('keeps leader context telemetry isolated from subagent sessions', () => {
    expect(memoryEventMatchesSession({ sessionId: 'leader' }, 'leader')).toBe(true);
    expect(memoryEventMatchesSession({ sessionId: 'subagent-1' }, 'leader')).toBe(false);
    expect(memoryEventMatchesSession({}, 'leader')).toBe(true);
  });
});
