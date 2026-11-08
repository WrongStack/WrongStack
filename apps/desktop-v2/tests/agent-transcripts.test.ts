import { EMPTY_FLEET_FOLD } from '@wrongstack/project-surfaces/office/fleet-fold';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { useAgentTabs } from '../src/AgentTranscripts';
import { agentTabList, transcriptSteps } from '../src/agent-transcripts';
import { emptyEngineState, reduceEngine } from '../src/engine-state';

const timeline = (payload: Record<string, unknown>) => ({
  type: 'agent.timeline.message',
  payload: {
    sessionId: 's',
    subagentId: 'a1',
    agentName: 'Ada',
    iteration: 1,
    ts: 't',
    ...payload,
  },
});

describe('subagent transcripts', () => {
  it('folds each agent’s frames, joining streamed text of one iteration', () => {
    let state = { ...emptyEngineState, sessionId: 's' };
    for (const frame of [
      timeline({ kind: 'text', content: 'Look' }),
      timeline({ kind: 'text', content: 'ing.' }),
      timeline({ kind: 'tool_use', content: 'read_file src/a.ts', toolName: 'read_file' }),
      timeline({
        kind: 'tool_result',
        content: 'Completed read_file',
        toolName: 'read_file',
        toolOk: true,
      }),
      timeline({ kind: 'text', content: 'Done.', iteration: 2 }),
      {
        type: 'agent.status_changed',
        payload: {
          sessionId: 's',
          subagentId: 'a1',
          agentName: 'Ada',
          status: 'completed',
          task: 'Audit a.ts',
          ts: 't',
        },
      },
      timeline({ subagentId: 'leader', kind: 'text', content: 'not an agent' }),
      timeline({
        sessionId: 'other',
        subagentId: 'b2',
        kind: 'text',
        content: 'another conversation',
      }),
    ])
      state = reduceEngine(state, frame);
    expect(Object.keys(state.agents)).toEqual(['a1']);
    const agent = state.agents['a1']!;
    expect(agent).toMatchObject({ name: 'Ada', status: 'completed', task: 'Audit a.ts' });
    expect(agent.entries.map((entry) => [entry.kind, entry.content])).toEqual([
      ['text', 'Looking.'],
      ['tool_use', 'read_file src/a.ts'],
      ['tool_result', 'Completed read_file'],
      ['text', 'Done.'],
      ['status', 'completed'],
    ]);
    const steps = transcriptSteps(agent.entries);
    expect(steps.map((step) => step.kind)).toEqual(['entry', 'tool', 'entry', 'entry']);
    expect(steps[1]).toMatchObject({ call: { toolName: 'read_file' }, result: { toolOk: true } });
    expect(
      reduceEngine(state, { type: 'session.start', payload: { sessionId: 's', reset: true } })
        .agents,
    ).toEqual({});
  });

  it('brings a reopened conversation’s agents back from its replay', () => {
    const replayed = {
      subagentId: 'a1',
      agentName: 'Ada',
      status: 'completed',
      task: 'Audit',
      transcript: [
        { id: 'e1', ts: 't1', kind: 'text', content: 'Found two issues.', iteration: 1 },
        { id: 'e2', ts: 't2', kind: 'mystery', content: 'dropped', iteration: 1 },
      ],
    };
    const state = reduceEngine(
      { ...emptyEngineState, sessionId: 's' },
      {
        type: 'session.start',
        payload: {
          sessionId: 's',
          reset: true,
          agentSessions: [replayed, { subagentId: 'leader' }],
        },
      },
    );
    expect(state.agents).toEqual({
      a1: {
        id: 'a1',
        name: 'Ada',
        status: 'completed',
        task: 'Audit',
        entries: [
          {
            id: 'e1',
            subagentId: 'a1',
            agentName: 'Ada',
            kind: 'text',
            content: 'Found two issues.',
            iteration: 1,
            ts: 't1',
          },
        ],
      },
    });
    // A replay of the same conversation does not double what the panel already holds; the
    // live status wins over the replayed one.
    const live = reduceEngine(
      state,
      timeline({ kind: 'text', content: 'More.', ts: 't3', iteration: 2 }),
    );
    const again = reduceEngine(live, {
      type: 'session.start',
      payload: { sessionId: 's', agentSessions: [{ ...replayed, status: 'running' }] },
    });
    expect(again.agents['a1']?.entries.map((entry) => entry.content)).toEqual([
      'Found two issues.',
      'More.',
    ]);
    expect(again.agents['a1']?.status).toBe('completed');
  });

  it('shows a tab per agent once the conversation has one', () => {
    function Tabs({ agents }: { agents: typeof emptyEngineState.agents }) {
      return useAgentTabs({ agents, fleet: EMPTY_FLEET_FOLD }, () => {}).bar;
    }
    expect(renderToStaticMarkup(createElement(Tabs, { agents: {} }))).toBe('');
    const html = renderToStaticMarkup(
      createElement(Tabs, {
        agents: { a1: { id: 'a1', name: 'Ada', status: 'running', task: 'Audit', entries: [] } },
      }),
    );
    expect(html).toContain('aria-pressed="true">Conversation</button>');
    expect(html).toContain('title="Ada: Audit"');
    expect(html).toContain(
      '<span class="agent-led running" aria-hidden="true"></span>Ada<small>Running</small>',
    );
  });

  it('lists every subagent the fleet roster knows, as the WebUI tabs do', () => {
    const subagent = (payload: Record<string, unknown>, at: number) => ({
      type: 'subagent.event',
      payload: { sessionId: 's', ...payload },
      at,
    });
    let state = { ...emptyEngineState, sessionId: 's' };
    for (const frame of [
      subagent({ kind: 'leader_updated', subagentId: 'lead', name: 'Lead' }, 1000),
      subagent({ kind: 'spawned', subagentId: 'w1', name: 'Bob', description: 'Map it' }, 2000),
      subagent(
        { kind: 'tool_executed', subagentId: 'w1', toolName: 'read', ok: true, durationMs: 5 },
        3000,
      ),
      subagent({ kind: 'spawned', subagentId: 'w2', name: 'Cy', description: 'Test it' }, 3500),
      subagent({ kind: 'spawned', subagentId: 'a1', name: 'Ada', description: 'Audit' }, 3600),
    ])
      state = reduceEngine(state, frame);
    // `a1` also streamed its own timeline: it keeps that transcript, gains its task, once.
    state = reduceEngine(state, timeline({ kind: 'text', content: 'Looking.' }));

    const tabs = agentTabList(state.agents, state.fleet);
    expect(Object.keys(tabs).sort()).toEqual(['a1', 'w1', 'w2']);
    expect(tabs['a1']).toMatchObject({ name: 'Ada', task: 'Audit' });
    expect(tabs['a1']?.entries.map((entry) => entry.content)).toEqual(['Looking.']);
    expect(tabs['w1']).toMatchObject({ name: 'Bob', status: 'running', task: 'Map it' });
    expect(tabs['w1']?.entries.map((entry) => entry.kind)).toEqual(['system', 'tool_result']);

    function Tabs() {
      return useAgentTabs(state, () => {}).bar;
    }
    const html = renderToStaticMarkup(createElement(Tabs));
    expect(html).toContain('title="Bob: Map it"');
    expect(html).toContain('title="Cy: Test it"');
    expect(html).not.toContain('Lead');
  });

  it('shows a fleet worker’s output when the roster holds no transcript for it', () => {
    const tabs = agentTabList(
      {},
      {
        leaderId: undefined,
        agentTranscripts: new Map(),
        agents: new Map([
          [
            'w1',
            {
              id: 'w1',
              name: 'Bob',
              status: 'completed',
              iteration: 3,
              toolCalls: 0,
              costUsd: 0,
              ctxPct: 0,
              ctxTokens: 0,
              maxContext: 0,
              extensions: 0,
              startedAt: 1000,
              completedAt: 2000,
              finalText: 'Two issues found.',
              toolLog: [],
              sparklineBins: [],
            },
          ],
        ]),
      },
    );
    expect(tabs['w1']?.entries).toEqual([
      expect.objectContaining({ kind: 'text', content: 'Two issues found.', iteration: 3 }),
    ]);
  });

  it('shows the engine fleet gauge beside the agent tabs', () => {
    const subagent = {
      type: 'subagent.event',
      payload: { sessionId: 's', kind: 'spawned', subagentId: 'w1', name: 'Bob' },
      at: 1,
    };
    let state = reduceEngine({ ...emptyEngineState, sessionId: 's' }, subagent);
    state = reduceEngine(state, {
      type: 'fleet.concurrency_update',
      payload: {
        fleetConcurrency: 1,
        fleetConcurrencyMax: 4,
        maxSpawns: 10,
        usedSpawns: 3,
        remainingSpawns: 7,
      },
    });
    expect(state.fleetGauge).toEqual({
      active: 1,
      max: 4,
      maxSpawns: 10,
      usedSpawns: 3,
      remainingSpawns: 7,
    });
    function Tabs() {
      return useAgentTabs(state, () => {}).bar;
    }
    expect(renderToStaticMarkup(createElement(Tabs))).toContain(
      '<span class="agent-gauge">1/4 running · 7 of 10 spawns left</span>',
    );
    // An unlimited spawn budget (null on the wire) shows only the running count.
    state = reduceEngine(state, {
      type: 'fleet.concurrency_update',
      payload: {
        fleetConcurrency: 0,
        fleetConcurrencyMax: 4,
        maxSpawns: null,
        remainingSpawns: null,
      },
    });
    expect(state.fleetGauge).toEqual({ active: 0, max: 4 });
    expect(renderToStaticMarkup(createElement(Tabs))).toContain(
      '<span class="agent-gauge">0/4 running</span>',
    );
  });
});
