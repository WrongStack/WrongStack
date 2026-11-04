import { describe, expect, it } from 'vitest';
import { emptyEngineState, reduceEngine } from '../src/engine-state';
import { turnToolSummary } from '../src/turn-tools';

const tool = (type: string, id: string, name: string, ok = true) => ({
  type,
  payload: { sessionId: 's1', id, name, ok },
});

describe('tool work kept with each turn', () => {
  it('attaches a finished run’s tool events to its answer and summarizes them', () => {
    let state = reduceEngine(emptyEngineState, {
      type: 'session.start',
      payload: { sessionId: 's1', provider: 'p', model: 'm' },
    });
    for (const event of [
      tool('tool.started', 't1', 'read'),
      tool('tool.executed', 't1', 'read'),
      tool('tool.executed', 't2', 'read'),
      tool('tool.executed', 't3', 'edit', false),
      {
        type: 'provider.text_delta',
        payload: { sessionId: 's1', messageId: 'a1', text: 'Done.' },
      },
      { type: 'run.result', payload: { sessionId: 's1', status: 'done', finalText: 'Done.' } },
    ])
      state = reduceEngine(state, event);
    const answer = state.messages.findLast((message) => message.role === 'assistant')!;
    const events = state.turnActivity[answer.id]!;
    expect(events.map((event) => event.type)).toEqual([
      'tool.started',
      'tool.executed',
      'tool.executed',
      'tool.executed',
    ]);
    expect(turnToolSummary(events)).toEqual({ calls: 3, failed: 1, text: 'read ×2 · edit' });
    // A second run with no tools records nothing for its answer.
    state = reduceEngine(state, {
      type: 'provider.text_delta',
      payload: { sessionId: 's1', messageId: 'a2', text: 'Again.' },
    });
    state = reduceEngine(state, {
      type: 'run.result',
      payload: { sessionId: 's1', status: 'done', finalText: 'Again.' },
    });
    expect(Object.keys(state.turnActivity)).toHaveLength(1);
  });
  it('keeps every tool call of a long turn, however much thinking and output streamed', () => {
    let state = reduceEngine(emptyEngineState, {
      type: 'session.start',
      payload: { sessionId: 's1', provider: 'p', model: 'm' },
    });
    for (let call = 0; call < 150; call++) {
      for (let delta = 0; delta < 20; delta++)
        state = reduceEngine(state, {
          type: 'provider.thinking_delta',
          payload: { sessionId: 's1', text: `step ${call}.${delta} ` },
        });
      state = reduceEngine(state, tool('tool.started', `t${call}`, 'read'));
      for (let line = 0; line < 30; line++)
        state = reduceEngine(state, {
          type: 'tool.progress',
          payload: {
            sessionId: 's1',
            id: `t${call}`,
            name: 'read',
            event: { type: 'log', text: `line ${line}` },
          },
        });
      state = reduceEngine(state, tool('tool.executed', `t${call}`, 'read'));
    }
    // While the turn runs, the live view sees all of it with the streamed frames merged.
    expect(state.runTimeline.filter((event) => event.type === 'tool.started')).toHaveLength(150);
    expect(state.runTimeline).toHaveLength(150 * 4);
    expect(String(state.runTimeline[0]!.payload['text'])).toContain('step 0.19');
    state = reduceEngine(state, {
      type: 'provider.text_delta',
      payload: { sessionId: 's1', messageId: 'a1', text: 'Done.' },
    });
    state = reduceEngine(state, {
      type: 'run.result',
      payload: { sessionId: 's1', status: 'done', finalText: 'Done.' },
    });
    const answer = state.messages.findLast((message) => message.role === 'assistant')!;
    expect(turnToolSummary(state.turnActivity[answer.id]!)).toEqual({
      calls: 150,
      failed: 0,
      text: 'read ×150',
    });
    expect(state.runTimeline).toEqual([]);
  });
  it('keeps what each turn took with its answer: iterations and the tokens of its requests', () => {
    let state = reduceEngine(emptyEngineState, {
      type: 'session.start',
      payload: { sessionId: 's1', provider: 'p', model: 'm' },
    });
    const turn = (messageId: string, prompt: number, output: number) => {
      for (const event of [
        { type: 'iteration.started', payload: { sessionId: 's1', index: 0, maxIterations: 50 } },
        {
          type: 'provider.response',
          payload: { sessionId: 's1', usage: { input: prompt / 2, cacheRead: prompt / 2, output } },
        },
        { type: 'iteration.started', payload: { sessionId: 's1', index: 1, maxIterations: 50 } },
        { type: 'provider.text_delta', payload: { sessionId: 's1', messageId, text: 'Done.' } },
        { type: 'run.result', payload: { sessionId: 's1', status: 'done', iterations: 2 } },
      ])
        state = reduceEngine(state, event);
      return state.messages.findLast((message) => message.role === 'assistant')!.id;
    };
    const first = turn('a1', 1000, 50);
    const second = turn('a2', 4000, 70);
    expect(state.turnStats[first]).toEqual({
      iterations: 2,
      prompt: 1000,
      output: 50,
      cacheRead: 500,
    });
    expect(state.turnStats[second]).toEqual({
      iterations: 2,
      prompt: 4000,
      output: 70,
      cacheRead: 2000,
    });
    expect(state.runStartTotals).toBeNull();
  });
});
