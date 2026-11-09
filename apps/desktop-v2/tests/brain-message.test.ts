import { describe, expect, it } from 'vitest';
import { emptyEngineState, reduceEngine } from '../src/engine-state';

const started = () =>
  reduceEngine(emptyEngineState, {
    type: 'session.start',
    payload: { sessionId: 's', provider: 'local', model: 'test' },
  });
describe('non-council Brain messages', () => {
  it('retains decision facts in the owning conversation and deduplicates replay', () => {
    const event = {
      type: 'brain.event',
      payload: {
        sessionId: 's',
        event: 'brain.decision_answered',
        tier: 'policy',
        request: { id: 'q', question: 'Is this allowed?', risk: 'high', source: 'tool' },
        decision: { type: 'answer', text: 'Yes', rationale: 'Verified scope', confidence: 0.8 },
      },
    };
    const state = reduceEngine(started(), event);
    expect(state.messages).toHaveLength(1);
    expect(state.messages[0]).toMatchObject({
      brain: {
        question: 'Is this allowed?',
        risk: 'high',
        tier: 'policy',
        text: 'Yes',
        confidence: 0.8,
      },
    });
    expect(reduceEngine(state, event).messages).toHaveLength(1);
    expect(
      reduceEngine(state, { ...event, payload: { ...event.payload, sessionId: 'other' } }),
    ).toBe(state);
  });
  it('keeps request-start events out of the transcript', () => {
    expect(
      reduceEngine(started(), {
        type: 'brain.event',
        payload: { sessionId: 's', event: 'brain.decision_started', request: { id: 'q' } },
      }).messages,
    ).toEqual([]);
  });
});
