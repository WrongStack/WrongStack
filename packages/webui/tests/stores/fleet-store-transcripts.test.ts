import { beforeEach, describe, expect, it } from 'vitest';
import { selectSortedAgentList, shallow, useFleetStore } from '../../src/stores/fleet-store';

/**
 * Transcript merging, leader hand-off, session-scoped queries and the
 * selector helpers — the parts of the fleet store the roster suites don't
 * touch because they only ever push `subagent.event` upserts.
 */

function reset() {
  useFleetStore.setState({
    agents: new Map(),
    leaderId: undefined,
    eventTimeline: [],
    agentTimeline: [],
    agentTranscripts: new Map(),
  });
}

function push(entry: Record<string, unknown>) {
  useFleetStore.getState().pushAgentTimelineEntry({
    subagentId: 'sa1',
    agentName: 'scout',
    content: 'x',
    kind: 'text',
    iteration: 0,
    ts: '2026-01-01T00:00:00.000Z',
    ...entry,
  } as never);
}

function transcript(id = 'sa1') {
  return useFleetStore.getState().getAgentTranscript(id);
}

beforeEach(reset);

describe('transcript merging', () => {
  it('concatenates consecutive text from the same iteration', () => {
    push({ content: 'Hello ' });
    push({ content: 'world' });

    expect(transcript()).toHaveLength(1);
    expect(transcript()[0]).toMatchObject({ content: 'Hello world' });
  });

  it('merges consecutive thinking the same way', () => {
    push({ kind: 'thinking', content: 'a' });
    push({ kind: 'thinking', content: 'b' });
    expect(transcript()[0]).toMatchObject({ content: 'ab' });
  });

  it('advances the timestamp to the newest fragment', () => {
    push({ content: 'a', ts: '2026-01-01T00:00:00.000Z' });
    push({ content: 'b', ts: '2026-01-01T00:00:05.000Z' });
    expect(transcript()[0]).toMatchObject({ ts: '2026-01-01T00:00:05.000Z' });
  });

  it('does not merge across iterations', () => {
    push({ content: 'a', iteration: 1 });
    push({ content: 'b', iteration: 2 });
    expect(transcript()).toHaveLength(2);
  });

  it('does not merge different kinds', () => {
    push({ kind: 'text', content: 'a' });
    push({ kind: 'thinking', content: 'b' });
    expect(transcript()).toHaveLength(2);
  });

  it('does not merge across agents', () => {
    push({ content: 'a' });
    push({ subagentId: 'sa2', content: 'b' });
    expect(transcript('sa1')).toHaveLength(1);
    expect(transcript('sa2')).toHaveLength(1);
  });

  it('never merges tool entries even when otherwise identical', () => {
    push({ kind: 'tool_use', content: 'a', toolName: 'Read', toolOk: true });
    push({ kind: 'tool_use', content: 'b', toolName: 'Read', toolOk: true });
    expect(transcript()).toHaveLength(2);
  });

  it('normalises tool_call — not a known kind — to status', () => {
    // The wire spells it `tool_use`; `tool_call` falls through the switch.
    push({ kind: 'tool_call' });
    expect(transcript()[0]).toMatchObject({ kind: 'status' });
  });

  it('does not merge tool entries whose outcome differs', () => {
    push({ kind: 'text', content: 'a', toolName: 'Read', toolOk: true });
    push({ kind: 'text', content: 'b', toolName: 'Read', toolOk: false });
    expect(transcript()).toHaveLength(2);
  });

  it('normalises an unrecognised kind to status', () => {
    push({ kind: 'nonsense' });
    expect(transcript()[0]).toMatchObject({ kind: 'status' });
  });

  it.each(['text', 'thinking', 'tool_use', 'tool_result', 'error', 'status', 'system'])(
    'keeps the known kind %s as-is',
    (kind) => {
      reset();
      push({ kind });
      expect(transcript()[0]).toMatchObject({ kind });
    },
  );

  it('returns a shared empty array for an unknown agent', () => {
    expect(transcript('nobody')).toEqual([]);
    // Identity is stable, so a selector reading it won't re-render.
    expect(transcript('nobody')).toBe(transcript('someone-else'));
  });

  it('bounds the transcript so a chatty agent cannot grow without limit', () => {
    for (let i = 0; i < 1_100; i += 1) push({ kind: 'status', content: `s${i}` });
    const entries = transcript();

    expect(entries).toHaveLength(1_000);
    // The window keeps the newest entries and drops from the front.
    expect(entries.at(-1)).toMatchObject({ content: 's1099' });
    expect(entries[0]).toMatchObject({ content: 's100' });
  });
});

describe('leader hand-off', () => {
  function event(payload: Record<string, unknown>) {
    useFleetStore.getState().applyEvent(payload as never);
  }

  it('promotes the named agent and records it on the timeline', () => {
    event({ kind: 'leader_updated', subagentId: 'sa1', name: 'scout' });

    expect(useFleetStore.getState().leaderId).toBe('sa1');
    expect(useFleetStore.getState().agents.get('sa1')).toMatchObject({ isLeader: true });
    expect(useFleetStore.getState().eventTimeline.at(-1)).toMatchObject({
      kind: 'leader_updated',
    });
  });

  it('demotes the previous leader', () => {
    event({ kind: 'leader_updated', subagentId: 'sa1', name: 'scout' });
    event({ kind: 'leader_updated', subagentId: 'sa2', name: 'pilot' });

    expect(useFleetStore.getState().agents.get('sa1')).toMatchObject({ isLeader: false });
    expect(useFleetStore.getState().agents.get('sa2')).toMatchObject({ isLeader: true });
    expect(useFleetStore.getState().leaderId).toBe('sa2');
  });

  it('re-announcing the same leader is idempotent', () => {
    event({ kind: 'leader_updated', subagentId: 'sa1', name: 'scout' });
    event({ kind: 'leader_updated', subagentId: 'sa1', name: 'scout' });
    expect(useFleetStore.getState().agents.get('sa1')).toMatchObject({ isLeader: true });
  });

  it('keeps the existing display name when the event carries a blank one', () => {
    event({ kind: 'spawned', subagentId: 'sa1', name: 'scout' });
    event({ kind: 'leader_updated', subagentId: 'sa1', name: '   ' });
    expect(useFleetStore.getState().agents.get('sa1')).toMatchObject({ name: 'scout' });
  });

  it('ignores an event with no agent id', () => {
    const before = useFleetStore.getState();
    event({ kind: 'status_changed', status: 'running' });
    expect(useFleetStore.getState()).toBe(before);
  });
});

describe('session-scoped queries', () => {
  beforeEach(() => {
    useFleetStore.getState().applyEvent({
      kind: 'spawned',
      subagentId: 'sa1',
      name: 'a',
      sessionId: 'sess_a',
    } as never);
    useFleetStore.getState().applyEvent({
      kind: 'spawned',
      subagentId: 'sa2',
      name: 'b',
      sessionId: 'sess_b',
    } as never);
  });

  it('returns only agents belonging to the session', () => {
    expect(
      useFleetStore
        .getState()
        .getAgentsBySession('sess_a')
        .map((a) => a.id),
    ).toEqual(['sa1']);
  });

  it('returns nothing for an unknown session', () => {
    expect(useFleetStore.getState().getAgentsBySession('sess_zzz')).toEqual([]);
  });
});

describe('clearFinishedAgents', () => {
  /** `spawned` always lands as running; `task_completed` carries the outcome. */
  function spawn(id: string, status?: string) {
    useFleetStore
      .getState()
      .applyEvent({ kind: 'spawned', subagentId: id, name: id, sessionId: 'sess-a' } as never);
    if (status) {
      useFleetStore
        .getState()
        .applyEvent({ kind: 'task_completed', subagentId: id, status } as never);
    }
  }

  it('keeps running agents and drops the rest', () => {
    spawn('run');
    spawn('done', 'success');
    spawn('bad', 'failed');

    useFleetStore.getState().clearFinishedAgents('sess-a');
    const ids = [...useFleetStore.getState().agents.keys()];
    expect(ids).toEqual(['run']);
  });

  it('also drops the finished agents transcripts', () => {
    spawn('done', 'success');
    useFleetStore.getState().pushAgentTimelineEntry({
      subagentId: 'done',
      agentName: 'done',
      content: 'x',
      kind: 'text',
      iteration: 0,
      ts: '2026-01-01T00:00:00.000Z',
    } as never);

    useFleetStore.getState().clearFinishedAgents('sess-a');
    expect(useFleetStore.getState().getAgentTranscript('done')).toEqual([]);
  });
});

describe('clear', () => {
  it('wipes every roster surface at once', () => {
    useFleetStore.getState().applyEvent({ kind: 'spawned', subagentId: 'sa1' } as never);
    push({});

    useFleetStore.getState().clear();
    const state = useFleetStore.getState();
    expect(state.agents.size).toBe(0);
    expect(state.eventTimeline).toEqual([]);
    expect(state.agentTranscripts.size).toBe(0);
  });
});

describe('shallow', () => {
  it('is true for the same reference', () => {
    const a = { x: 1 };
    expect(shallow(a, a)).toBe(true);
  });

  it('is true for equal own properties', () => {
    expect(shallow({ x: 1, y: 2 }, { x: 1, y: 2 })).toBe(true);
  });

  it('is false when a value differs', () => {
    expect(shallow({ x: 1 }, { x: 2 })).toBe(false);
  });

  it('is false when the key count differs', () => {
    expect(shallow({ x: 1 }, { x: 1, y: 2 })).toBe(false);
  });

  it('is false when either side is nullish', () => {
    expect(shallow(null as never, { x: 1 })).toBe(false);
    expect(shallow({ x: 1 }, undefined as never)).toBe(false);
  });

  it('compares nested objects by reference, not structurally', () => {
    expect(shallow({ n: { a: 1 } }, { n: { a: 1 } })).toBe(false);
  });
});

describe('selectSortedAgentList', () => {
  it('puts the leader first regardless of activity', () => {
    useFleetStore.getState().applyEvent({ kind: 'spawned', subagentId: 'sa1' } as never);
    useFleetStore.getState().applyEvent({ kind: 'spawned', subagentId: 'sa2' } as never);
    useFleetStore.getState().applyEvent({ kind: 'leader_updated', subagentId: 'sa2' } as never);

    expect(selectSortedAgentList(useFleetStore.getState())[0]?.id).toBe('sa2');
  });

  it('is stable for an empty roster', () => {
    expect(selectSortedAgentList(useFleetStore.getState())).toEqual([]);
  });
});
