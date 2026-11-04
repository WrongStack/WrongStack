import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import {
  DesktopStoryContext,
  type DesktopStoryValue,
  desktopStoryFeed,
} from '../src/desktop-story-feed';
import { type EngineState, emptyEngineState, reduceEngine } from '../src/engine-state';
import { mergeOfficeFleet } from '../src/office-fleet';

const subagent = (payload: Record<string, unknown>, at: number, sessionId = 's1') => ({
  type: 'subagent.event',
  payload: { sessionId, ...payload },
  at,
});

function fleetState(): EngineState {
  let state: EngineState = { ...emptyEngineState, sessionId: 's1' };
  for (const frame of [
    subagent({ kind: 'leader_updated', subagentId: 'lead', name: 'Ada' }, 1000),
    subagent({ kind: 'spawned', subagentId: 'sub', name: 'Bob', description: 'Map it' }, 2000),
    subagent(
      { kind: 'tool_executed', subagentId: 'sub', toolName: 'read', ok: true, durationMs: 12 },
      3000,
    ),
    subagent(
      {
        kind: 'task_completed',
        subagentId: 'sub',
        status: 'success',
        finalText: 'Done.\n<nextsteps>\n1. Ship it\n</nextsteps>',
      },
      4000,
    ),
    // Another conversation's fleet is not this one's.
    subagent({ kind: 'spawned', subagentId: 'other', name: 'Eve' }, 4500, 's2'),
  ])
    state = reduceEngine(state, frame);
  return state;
}

describe('conversation fleet', () => {
  it('folds subagent events as the WebUI fleet store does, at the frames’ own times', () => {
    const { fleet } = fleetState();
    expect(fleet.leaderId).toBe('lead');
    expect(fleet.agents.get('lead')?.isLeader).toBe(true);
    expect(fleet.agents.get('sub')).toMatchObject({
      name: 'Bob',
      status: 'completed',
      toolCalls: 1,
      lastTool: 'read',
      startedAt: 2000,
      completedAt: 4000,
    });
    expect(fleet.agents.get('sub')?.finalText?.trim()).toBe('Done.');
    expect(fleet.agents.has('other')).toBe(false);
    expect(fleet.agentTranscripts.get('sub')?.map((entry) => entry.kind)).toEqual([
      'system',
      'tool_result',
      'text',
    ]);
  });

  it('merges a project’s conversations for the office, tool calls newest first', () => {
    const first = {
      ...fleetState(),
      lastAt: 9000,
      agents: {
        sub: {
          id: 'sub',
          name: 'Bob',
          status: 'completed',
          entries: [
            {
              id: 'e1',
              subagentId: 'sub',
              agentName: 'Bob',
              content: 'Reading the parser',
              kind: 'text' as const,
              iteration: 1,
              ts: 't',
            },
          ],
        },
      },
      activity: [
        { type: 'tool.started', payload: { id: 't1', agentId: 'lead', name: 'grep' }, at: 5000 },
        { type: 'provider.text_delta', payload: { text: 'x' } },
        { type: 'tool.executed', payload: { id: 't1', agentId: 'lead', ok: false }, at: 5000 },
      ],
    };
    const second = {
      ...emptyEngineState,
      sessionId: 's2',
      activity: [{ type: 'tool.started', payload: { id: 'u1', name: 'edit' }, at: 6000 }],
    };
    const fleet = mergeOfficeFleet([first, second]);
    expect([...fleet.agents.keys()]).toEqual(['lead', 'sub']);
    expect(fleet.leaderId).toBe('lead');
    // The conversation's own timeline frames win over the fleet's summary lines.
    expect(fleet.transcripts.get('sub')?.map((entry) => entry.content)).toEqual([
      'Reading the parser',
    ]);
    expect(
      fleet.toolEvents.map((event) => [event.kind, event.label, event.source, event.timestamp]),
    ).toEqual([
      ['tool:started', 'edit', 'leader', 6000],
      ['tool:executed', 'grep', 'lead', 5000],
      ['tool:started', 'grep', 'lead', 5000],
    ]);
    expect(fleet.toolEvents[1]?.data).toMatchObject({ ok: false, name: 'grep', sessionId: 's1' });
  });

  it('gives the session story the conversation’s fleet as its roster', () => {
    const state = fleetState();
    const value = {
      state,
      projectRoot: 'D:/repo',
      send: vi.fn(),
      command: vi.fn(),
      onBack: vi.fn(),
    } as unknown as DesktopStoryValue;
    const feed = desktopStoryFeed(() => value);
    function Roster() {
      return createElement(
        'ul',
        null,
        feed.useAgents().map((agent) => createElement('li', { key: agent.id }, agent.name)),
      );
    }
    const html = renderToStaticMarkup(
      createElement(DesktopStoryContext.Provider, { value }, createElement(Roster)),
    );
    expect(html).toBe('<ul><li>Ada</li><li>Bob</li></ul>');
  });
});
