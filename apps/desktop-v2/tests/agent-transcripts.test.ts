import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { useAgentTabs } from '../src/AgentTranscripts';
import { transcriptSteps } from '../src/agent-transcripts';
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

  it('shows a tab per agent once the conversation has one', () => {
    function Tabs({ agents }: { agents: typeof emptyEngineState.agents }) {
      return useAgentTabs(agents, () => {}).bar;
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
      '<span class="agent-led running" aria-hidden="true"></span>Ada<small>running</small>',
    );
  });
});
