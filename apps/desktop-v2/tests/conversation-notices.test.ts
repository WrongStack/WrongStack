import { describe, expect, it } from 'vitest';
import { NOTICE_LIMIT } from '../src/conversation-notices';
import { emptyEngineState, reduceEngine } from '../src/engine-state';

const start = reduceEngine(emptyEngineState, {
  type: 'session.start',
  payload: { sessionId: 's1', provider: 'p', model: 'm' },
});
const texts = (state: typeof start) => state.notices.map((notice) => notice.text);

describe('conversation notices', () => {
  it('explains why a run stopped early or a loop was cut', () => {
    let state = reduceEngine(start, {
      type: 'run.result',
      payload: { sessionId: 's1', status: 'max_iterations', iterations: 40 },
    });
    state = reduceEngine(state, {
      type: 'tool.loop_detected',
      payload: { sessionId: 's1', tools: 'read', repeatCount: 5, action: 'cut' },
    });
    state = reduceEngine(state, {
      type: 'tool.loop_detected',
      payload: { sessionId: 's1', tools: 'grep', repeatCount: 3, action: 'steer' },
    });
    state = reduceEngine(state, {
      type: 'run.result',
      payload: { sessionId: 's1', status: 'done', finalText: 'ok' },
    });
    expect(texts(state)).toEqual([
      'The run stopped at its iteration limit after 40 turns.',
      'The engine ended the turn: repeated read calls (5 repeats).',
    ]);
    expect(state.notices[0]?.hint).toContain('tools.maxIterations');
  });
  it('reports damage, failed compaction, substituted models and blocked providers', () => {
    let state = start;
    for (const event of [
      { type: 'session.damaged', payload: { sessionId: 's1', detail: 'line 12 is not JSON' } },
      { type: 'compaction.failed', payload: { sessionId: 's1', message: 'summary timed out' } },
      {
        type: 'provider.model_rerouted',
        payload: { sessionId: 's1', providerId: 'zai', requested: 'glm-5', served: 'glm-4.6' },
      },
      {
        type: 'provider.model_rerouted',
        payload: { sessionId: 's1', providerId: 'zai', requested: 'glm-5', served: 'glm-5' },
      },
      {
        type: 'provider.active_blocked',
        payload: {
          sessionId: 's1',
          providerId: 'openai',
          model: 'gpt-5',
          lastError: '429',
          fallbackProviderId: 'zai',
          fallbackModel: 'glm-5',
        },
      },
      { type: 'session.damaged', payload: { sessionId: 's2', detail: 'other conversation' } },
    ])
      state = reduceEngine(state, event);
    expect(texts(state)).toEqual([
      "This conversation's journal is damaged: line 12 is not JSON",
      'Context compaction failed: summary timed out',
      'zai answered with glm-4.6 instead of glm-5.',
      'openai/gpt-5 is blocked: 429.',
    ]);
    expect(state.notices[3]?.hint).toBe('The engine tries zai/glm-5 instead.');
  });
  it('keeps distinct ids within a bound and clears on reset', () => {
    let state = start;
    for (let index = 0; index < NOTICE_LIMIT + 3; index++)
      state = reduceEngine(state, {
        type: 'compaction.failed',
        payload: { sessionId: 's1', message: `failure ${index}` },
      });
    expect(state.notices).toHaveLength(NOTICE_LIMIT);
    expect(new Set(state.notices.map((notice) => notice.id)).size).toBe(NOTICE_LIMIT);
    state = reduceEngine(state, {
      type: 'session.start',
      payload: { sessionId: 's1', provider: 'p', model: 'm', reset: true },
    });
    expect(state.notices).toEqual([]);
  });
});
