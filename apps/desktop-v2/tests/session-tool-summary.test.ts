// @vitest-environment jsdom
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { describe, expect, it } from 'vitest';
import {
  ACTIVITY_LIMIT,
  type EngineEvent,
  emptyEngineState,
  reduceEngine,
  replayEngineBatch,
} from '../src/engine-state';
import { SessionInspector } from '../src/SessionInspector';
import { conversationToolCallCounts } from '../src/tool-stats-model';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const start = { ...emptyEngineState, sessionId: 'session-a' };
const frame = (type: string, id: string, name = 'read', agentId = ''): EngineEvent => ({
  type,
  payload: { sessionId: 'session-a', id, name, agentId, ok: true },
});

describe('session tool call totals', () => {
  it('counts logical calls once, including duplicate frames, parallel agents and reused IDs across runs', () => {
    const events = [
      frame('tool.started', 'same'),
      frame('tool.started', 'same'),
      frame('tool.progress', 'same'),
      frame('tool.executed', 'same'),
      frame('tool.executed', 'same'),
      frame('tool.executed', 'same', 'write', 'worker'),
      { type: 'run.result', payload: { status: 'failed' } },
      frame('tool.started', 'same'),
      frame('tool.executed', 'orphan', 'write'),
      { type: 'tool.started', payload: { sessionId: 'foreign', id: 'foreign', name: 'secret' } },
    ];
    const state = events.reduce(reduceEngine, start);
    expect(conversationToolCallCounts(state)).toEqual({
      total: 4,
      tools: [
        { name: 'read', calls: 2 },
        { name: 'write', calls: 2 },
      ],
    });
    expect(conversationToolCallCounts(start).total).toBe(0);
    expect(state.messages).toHaveLength(0);
    expect(replayEngineBatch(start, events, false).toolCalls.counts).toEqual(
      state.toolCalls.counts,
    );
  });

  it('retains totals beyond the activity window and resets only on a real session replay reset', () => {
    let state = start;
    for (let i = 0; i < ACTIVITY_LIMIT + 5; i++)
      state = reduceEngine(state, frame('tool.executed', String(i)));
    expect(state.activity).toHaveLength(ACTIVITY_LIMIT);
    expect(conversationToolCallCounts(state).total).toBe(ACTIVITY_LIMIT + 5);
    state = reduceEngine(state, {
      type: 'session.start',
      payload: { sessionId: 'session-a', eventEpoch: 'old' },
    });
    state = reduceEngine(state, {
      type: 'session.start',
      payload: { sessionId: 'session-a', eventEpoch: 'new' },
    });
    state = reduceEngine(state, frame('tool.started', '0'));
    expect(conversationToolCallCounts(state).total).toBe(ACTIVITY_LIMIT + 6);
    state = reduceEngine(state, {
      type: 'session.start',
      payload: { sessionId: 'session-a', reset: true },
    });
    expect(conversationToolCallCounts(state)).toEqual({ total: 0, tools: [] });
  });

  it('pairs legacy calls without IDs and resolves initially unnamed calls without increasing totals', () => {
    const state = [
      { type: 'tool.started', payload: { name: 'read' } },
      { type: 'tool.executed', payload: { name: 'read' } },
      { type: 'tool.executed', payload: { name: 'read' } },
      { type: 'tool.started', payload: { id: 'named-later' } },
      frame('tool.executed', 'named-later', 'write'),
    ].reduce(reduceEngine, start);
    expect(conversationToolCallCounts(state)).toEqual({
      total: 3,
      tools: [
        { name: 'read', calls: 2 },
        { name: 'write', calls: 1 },
      ],
    });
  });

  it('shows live totals in Details without recounting after completion or leaking into a new session', async () => {
    const host = document.createElement('div');
    const root = createRoot(host);
    const render = async (state: typeof start) =>
      act(async () =>
        root.render(
          createElement(SessionInspector, { state, command: async () => ({}), onLink: () => {} }),
        ),
      );
    const counts = () =>
      [...host.querySelectorAll('.session-tool-summary dl > div')].map((row) => [
        row.querySelector('dt')?.textContent,
        row.querySelector('dd')?.textContent,
      ]);
    try {
      await render(start);
      await act(async () =>
        host.querySelector<HTMLButtonElement>('[role="tab"][title="Details"]')?.click(),
      );
      expect(counts()).toEqual([['Total', '0']]);
      const state = reduceEngine(start, frame('tool.started', 'one'));
      await render(state);
      expect(counts()).toEqual([
        ['Total', '1'],
        ['read', '1'],
      ]);
      await render(reduceEngine(state, frame('tool.executed', 'one')));
      expect(counts()).toEqual([
        ['Total', '1'],
        ['read', '1'],
      ]);
      await render({ ...start, sessionId: 'session-b' });
      expect(counts()).toEqual([['Total', '0']]);
    } finally {
      await act(async () => root.unmount());
    }
  });
});
