import { describe, expect, it, vi } from 'vitest';
import { DefaultMultiAgentCoordinator } from '../../src/coordination/multi-agent-coordinator.js';

/**
 * A subagent belongs to the session that spawned it — for its whole life.
 *
 * The coordinator's `sessionId` option is a live getter ("which session is the
 * host on right now"). That is the right source at spawn time and the wrong
 * one at every moment after. With four WebUI tabs open the host's session moves
 * whenever the user switches tabs, so re-reading it when an event fires filed
 * tab A's worker under tab B: A's subagent showed up in B's roster, B looked
 * busy while idle (and refused to close), and nothing recorded which session
 * owned which worker — so "stop this tab" could not reach its own fleet
 * without killing everyone else's.
 *
 * These tests pin the stamp. If they go red, some emission started re-reading
 * the host's live session again.
 */

function makeConfig(overrides = {}) {
  return {
    coordinatorId: 'coord',
    doneCondition: { type: 'all_tasks_done' as const },
    maxConcurrent: 4,
    ...overrides,
  };
}

/** A coordinator whose host session moves, as the WebUI's does on a tab switch. */
function coordinatorOnMovingHost() {
  let hostSession = 'sess_a';
  const events: Array<{ type: string; payload: Record<string, unknown> }> = [];
  const coord = new DefaultMultiAgentCoordinator(makeConfig(), {
    sessionId: () => hostSession,
  });
  coord.setFleetBus({
    emit: (e: { type: string; payload?: unknown }) => {
      events.push({ type: e.type, payload: (e.payload ?? {}) as Record<string, unknown> });
    },
    filter: () => () => {},
  } as never);
  return {
    coord,
    events,
    switchTabTo: (id: string) => {
      hostSession = id;
    },
  };
}

function payloadsOf(
  events: Array<{ type: string; payload: Record<string, unknown> }>,
  type: string,
) {
  return events.filter((e) => e.type === type).map((e) => e.payload);
}

describe('subagents belong to the session that spawned them', () => {
  it('rejects a spawn when no owning session id is available', async () => {
    const coord = new DefaultMultiAgentCoordinator(makeConfig());

    await expect(coord.spawn({ id: 'w1', name: 'Worker 1' })).rejects.toMatchObject({
      code: 'SESSION_ID_REQUIRED',
    });
  });

  it('stamps a spawn with the session live at spawn time', async () => {
    const { coord, events } = coordinatorOnMovingHost();
    await coord.spawn({ id: 'w1', name: 'Worker 1' });

    expect(payloadsOf(events, 'subagent.assigned')[0]?.['sessionId']).toBe('sess_a');
    expect(coord.subagentIdsForSession('sess_a')).toEqual(['w1']);
  });

  it('keeps that stamp after the host moves to another tab', async () => {
    const { coord, events, switchTabTo } = coordinatorOnMovingHost();
    await coord.spawn({ id: 'w1', name: 'Worker 1' });

    // The user clicks tab B. The worker did not change hands.
    switchTabTo('sess_b');
    await coord.stop('w1');

    expect(payloadsOf(events, 'subagent.stopped')[0]?.['sessionId']).toBe('sess_a');
    expect(coord.subagentIdsForSession('sess_a')).toEqual(['w1']);
    expect(coord.subagentIdsForSession('sess_b')).toEqual([]);
  });

  it('files two tabs’ workers separately', async () => {
    const { coord, switchTabTo } = coordinatorOnMovingHost();
    await coord.spawn({ id: 'a1', name: 'A1' });
    switchTabTo('sess_b');
    await coord.spawn({ id: 'b1', name: 'B1' });
    await coord.spawn({ id: 'b2', name: 'B2' });

    expect(coord.subagentIdsForSession('sess_a')).toEqual(['a1']);
    expect(coord.subagentIdsForSession('sess_b')).toEqual(['b1', 'b2']);
  });

  it('carries the owning session on the dispatched task, for agent factories', async () => {
    const seen: Array<Record<string, unknown> | undefined> = [];
    let hostSession = 'sess_a';
    const coord = new DefaultMultiAgentCoordinator(makeConfig(), {
      sessionId: () => hostSession,
      runner: async (task) => {
        seen.push(task.context);
        return { iterations: 1, toolCalls: 0 };
      },
    });
    await coord.spawn({ id: 'w1', name: 'Worker 1' });
    // The user switches tabs between spawn and dispatch.
    hostSession = 'sess_b';
    await coord.assign({ id: 't1', description: 'work', subagentId: 'w1' });
    await coord.awaitTasks(['t1']);

    expect(seen[0]?.['sessionId']).toBe('sess_a');
  });

  it('lets an explicit task stamp win over the spawn stamp', async () => {
    const seen: Array<Record<string, unknown> | undefined> = [];
    const coord = new DefaultMultiAgentCoordinator(makeConfig(), {
      sessionId: () => 'sess_a',
      runner: async (task) => {
        seen.push(task.context);
        return { iterations: 1, toolCalls: 0 };
      },
    });
    await coord.spawn({ id: 'w1', name: 'Worker 1' });
    await coord.assign({
      id: 't1',
      description: 'work',
      subagentId: 'w1',
      context: { sessionId: 'sess_explicit' },
    });
    await coord.awaitTasks(['t1']);

    expect(seen[0]?.['sessionId']).toBe('sess_explicit');
  });
});

describe('stopSession', () => {
  it('stops only the workers of the named session', async () => {
    const { coord, switchTabTo } = coordinatorOnMovingHost();
    await coord.spawn({ id: 'a1', name: 'A1' });
    switchTabTo('sess_b');
    await coord.spawn({ id: 'b1', name: 'B1' });

    await coord.stopSession('sess_a');

    const byId = new Map(coord.getStatus().subagents.map((s) => [s.id, s.status]));
    expect(byId.get('a1')).toBe('stopped');
    // The other tab is untouched — this is the whole point of scoping the stop.
    expect(byId.get('b1')).toBe('idle');
  });

  it('drains that session’s still-queued tasks so their waiters unblock', async () => {
    const { coord, switchTabTo } = coordinatorOnMovingHost();
    // No runner: the first task pinned to a worker dispatches and parks there,
    // so a SECOND task pinned to the same worker stays in the queue — which is
    // the state this drain exists for.
    await coord.spawn({ id: 'a1', name: 'A1' });
    switchTabTo('sess_b');
    await coord.spawn({ id: 'b1', name: 'B1' });

    await coord.assign({ id: 't_a1', description: 'a work', subagentId: 'a1' });
    await coord.assign({ id: 't_a2', description: 'a more work', subagentId: 'a1' });
    await coord.assign({ id: 't_b1', description: 'b work', subagentId: 'b1' });
    await coord.assign({ id: 't_b2', description: 'b more work', subagentId: 'b1' });
    expect(coord.listPendingTasks().map((t) => t.id)).toEqual(['t_a2', 't_b2']);

    await coord.stopSession('sess_a');

    // Tab A's queued task resolves instead of hanging its waiter forever.
    const [queuedA] = await coord.awaitTasks(['t_a2']);
    expect(queuedA?.status).toBe('stopped');
    // Tab B's queue is untouched — this stop was not theirs.
    expect(coord.listPendingTasks().map((t) => t.id)).toEqual(['t_b2']);
  });

  it('is a no-op for a session that owns nothing', async () => {
    const { coord } = coordinatorOnMovingHost();
    await coord.spawn({ id: 'a1', name: 'A1' });
    const stopped = vi.fn();
    coord.on('subagent.stopped', stopped);

    await coord.stopSession('sess_nobody');

    expect(stopped).not.toHaveBeenCalled();
  });
});
