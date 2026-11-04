import { describe, expect, it } from 'vitest';
import { emptyEngineState, reduceEngine } from '../src/engine-state';

const started = () =>
  reduceEngine(emptyEngineState, {
    type: 'session.start',
    payload: { sessionId: 'core-a', provider: 'local', model: 'test' },
  });

const brain = (payload: Record<string, unknown>) => ({ type: 'brain.event', payload });

describe('Brain council decisions in a conversation', () => {
  it('adds one decision card per resolved panel, with its question and seats', () => {
    let state = started();
    state = reduceEngine(
      state,
      brain({
        event: 'brain.decision_requested',
        sessionId: 'core-a',
        request: { id: 'req-1', question: 'Ship the migration?' },
      }),
    );
    for (const [seatId, model, optionId] of [
      ['s1', 'model-a', 'approve'],
      ['s2', 'model-b', 'deny'],
    ])
      state = reduceEngine(
        state,
        brain({
          event: 'brain.council_vote',
          sessionId: 'core-a',
          requestId: 'req-1',
          seatId,
          persona: seatId === 's1' ? 'pragmatist' : 'skeptic',
          status: 'valid',
          optionId,
          model,
          at: 1000,
        }),
      );
    expect(state.messages).toHaveLength(0);

    const resolution = brain({
      event: 'brain.council_resolved',
      sessionId: 'core-a',
      requestId: 'req-1',
      status: 'decided',
      resolution: 'majority',
      optionId: 'approve',
      configuredSeatCount: 2,
      validVoteCount: 2,
      distinctTargetCount: 2,
      usage: { totalTokens: 900, durationMs: 4200 },
      at: 2000,
    });
    state = reduceEngine(state, resolution);

    expect(state.messages).toHaveLength(1);
    const card = state.messages[0]?.council;
    expect(card).toMatchObject({
      requestId: 'req-1',
      phase: 'resolved',
      question: 'Ship the migration?',
      resolution: 'majority',
      validVoteCount: 2,
      totalTokens: 900,
    });
    expect(card?.seats.map((seat) => seat.optionId)).toEqual(['approve', 'deny']);
    expect(state.messages[0]?.text).toContain('Council majority');

    // The same resolution replayed (a second window, a reconnect) adds no second card.
    expect(reduceEngine(state, resolution).messages).toHaveLength(1);
  });

  it("ignores another conversation's council", () => {
    const state = reduceEngine(
      started(),
      brain({
        event: 'brain.council_resolved',
        sessionId: 'core-b',
        requestId: 'req-2',
        status: 'decided',
        at: 2000,
      }),
    );
    expect(state.messages).toHaveLength(0);
    expect(state.council.panels).toHaveLength(0);
  });
});
