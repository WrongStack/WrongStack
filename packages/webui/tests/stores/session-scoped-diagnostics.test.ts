/**
 * The diagnostic logs are one store PER CONVERSATION.
 *
 * Brain council panels, memory-injector traces, SAGE lifecycle events and the
 * side-effect list all describe a single run. They used to be one global object
 * each, which the handlers defended by dropping anything that was not the tab
 * in front — so a background tab's records were lost outright, and the tab
 * switch had to wipe the store to stop the previous tab's records reading as
 * this one's. Now each conversation gets its own instance: nothing is dropped,
 * nothing is wiped, and nothing crosses.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { disposeLane, ensureLane, setActiveLane } from '../../src/stores/chat-lanes.js';
import { useCoordinatorMonitorStore } from '../../src/stores/coordinator-monitor-store.js';
import { useCouncilLogStore } from '../../src/stores/council-log-store.js';
import { useMemoryInjectorTraceStore } from '../../src/stores/memory-injector-store.js';
import { useMemoryLifecycleStore } from '../../src/stores/memory-lifecycle-store.js';
import { useSideEffectStore } from '../../src/stores/side-effect-store.js';

const A = 'sess_a';
const B = 'sess_b';

function vote(requestId: string, seatId: string) {
  return { requestId, seatId, persona: 'critic', status: 'valid', optionId: 'yes' };
}

describe('per-conversation diagnostic stores', () => {
  beforeEach(() => {
    for (const store of [
      useCouncilLogStore,
      useMemoryInjectorTraceStore,
      useMemoryLifecycleStore,
      useSideEffectStore,
      useCoordinatorMonitorStore,
    ]) {
      for (const id of store.sessionIds()) store.dropSession(id);
    }
    ensureLane(A);
    ensureLane(B);
    setActiveLane(A);
  });

  it('keeps one council log per conversation', () => {
    useCouncilLogStore.for(A).getState().recordVote(vote('req_a', 'seat1'));
    useCouncilLogStore.for(B).getState().recordVote(vote('req_b', 'seat1'));

    expect(
      useCouncilLogStore
        .for(A)
        .getState()
        .panels.map((p) => p.requestId),
    ).toEqual(['req_a']);
    expect(
      useCouncilLogStore
        .for(B)
        .getState()
        .panels.map((p) => p.requestId),
    ).toEqual(['req_b']);
  });

  it('answers the foreground from the tab in front, and follows a switch', () => {
    useCouncilLogStore.for(A).getState().recordVote(vote('req_a', 'seat1'));
    useCouncilLogStore.for(B).getState().recordVote(vote('req_b', 'seat1'));

    expect(useCouncilLogStore.getState().panels[0]?.requestId).toBe('req_a');
    setActiveLane(B);
    // The switch does not clear anything — B simply shows B's own log.
    expect(useCouncilLogStore.getState().panels[0]?.requestId).toBe('req_b');
    setActiveLane(A);
    expect(useCouncilLogStore.getState().panels[0]?.requestId).toBe('req_a');
  });

  it('keeps side effects apart', () => {
    useSideEffectStore
      .for(A)
      .getState()
      .setSideEffects([
        {
          toolUseId: 't1',
          toolName: 'Write',
          ts: '2026-01-01T00:00:00.000Z',
          input: {},
          risk: 'high',
        },
      ]);

    expect(useSideEffectStore.for(A).getState().sideEffects).toHaveLength(1);
    expect(useSideEffectStore.for(B).getState().sideEffects).toEqual([]);
  });

  it('keeps memory traces and lifecycle events apart', () => {
    useMemoryInjectorTraceStore
      .for(A)
      .getState()
      .pushTrace({
        runId: 'run_a',
        at: '2026-01-01T00:00:00.000Z',
        outcome: 'injected',
        trigger: 'tool',
        toolName: 'Read',
        queryPreview: 'q',
        paths: [],
        taskSignals: [],
        contextPressure: 0,
        budget: { maxHints: 3, maxChars: 500 },
        candidates: 1,
        eligible: 1,
        rejected: { duplicate: 0, belowScore: 0, alreadyVisible: 0, cooldown: 0, budget: 0 },
        activated: [],
        injected: [],
        injectedChars: 0,
      });
    useMemoryLifecycleStore.for(B).getState().pushEvent({ event: 'memory.staled', memoryId: 'm1' });

    expect(useMemoryInjectorTraceStore.for(A).getState().traces).toHaveLength(1);
    expect(useMemoryInjectorTraceStore.for(B).getState().traces).toHaveLength(0);
    expect(useMemoryLifecycleStore.for(B).getState().items).toHaveLength(1);
    expect(useMemoryLifecycleStore.for(A).getState().items).toHaveLength(0);
  });

  it('forgets a conversation when its tab closes', () => {
    useCouncilLogStore.for(A).getState().recordVote(vote('req_a', 'seat1'));
    useCouncilLogStore.for(B).getState().recordVote(vote('req_b', 'seat1'));
    expect(useCouncilLogStore.sessionIds()).toContain(A);

    setActiveLane(B);
    disposeLane(A);

    expect(useCouncilLogStore.sessionIds()).not.toContain(A);
    // …and the tab still open is untouched.
    expect(
      useCouncilLogStore
        .for(B)
        .getState()
        .panels.map((p) => p.requestId),
    ).toEqual(['req_b']);
  });

  it('keeps each tab’s coordinator run to itself', () => {
    // The handlers used to drop every background tab's task lifecycle, so a
    // tab that ran a fleet while another was in front came back to an empty
    // monitor. Both fleets are now recorded, in their own tab.
    useCoordinatorMonitorStore.for(A).getState().startTask('task_a', 'worker_a');
    useCoordinatorMonitorStore.for(B).getState().startTask('task_b', 'worker_b');
    useCoordinatorMonitorStore.for(B).getState().failTask('task_b', 'boom');

    expect([...useCoordinatorMonitorStore.for(A).getState().tasks.keys()]).toEqual(['task_a']);
    expect([...useCoordinatorMonitorStore.for(B).getState().tasks.keys()]).toEqual(['task_b']);
    expect(useCoordinatorMonitorStore.for(A).getState().taskCounts.failed).toBe(0);
    expect(useCoordinatorMonitorStore.for(B).getState().taskCounts.failed).toBe(1);
  });

  it('does not let one tab’s coordinator status read as another’s', () => {
    useCoordinatorMonitorStore.for(A).getState().setCoordinatorStatus('running');

    expect(useCoordinatorMonitorStore.for(A).getState().coordinatorStatus).toBe('running');
    expect(useCoordinatorMonitorStore.for(B).getState().coordinatorStatus).toBe('idle');
    // The foreground answers from the tab in front, and follows a switch.
    expect(useCoordinatorMonitorStore.getState().coordinatorStatus).toBe('running');
    setActiveLane(B);
    expect(useCoordinatorMonitorStore.getState().coordinatorStatus).toBe('idle');
  });

  it('gives a fresh conversation an empty log, not the last tab’s', () => {
    useCouncilLogStore.for(A).getState().recordVote(vote('req_a', 'seat1'));

    expect(useCouncilLogStore.for('sess_new').getState().panels).toEqual([]);
  });
});
