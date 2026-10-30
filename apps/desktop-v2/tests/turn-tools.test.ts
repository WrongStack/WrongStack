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
});
