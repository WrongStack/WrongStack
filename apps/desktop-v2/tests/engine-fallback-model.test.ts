import { describe, expect, it } from 'vitest';
import { emptyEngineState, reduceEngine } from '../src/engine-state';

describe('model shown after a fallback', () => {
  it('follows a fallback hop and the restore to the primary', () => {
    let state = reduceEngine(emptyEngineState, {
      type: 'session.start',
      payload: { sessionId: 's1', provider: 'primary', model: 'p-model' },
    });
    state = reduceEngine(state, {
      type: 'provider.fallback',
      payload: {
        sessionId: 's1',
        from: { providerId: 'primary', model: 'p-model' },
        to: { providerId: 'backup', model: 'b-model' },
        status: 529,
        providerSwitched: true,
      },
    });
    expect([state.provider, state.model]).toEqual(['backup', 'b-model']);
    state = reduceEngine(state, {
      type: 'provider.fallback',
      payload: { sessionId: 'other', to: { providerId: 'x', model: 'y' } },
    });
    expect(state.model).toBe('b-model');
    state = reduceEngine(state, {
      type: 'provider.primary_restored',
      payload: {
        sessionId: 's1',
        from: { providerId: 'backup', model: 'b-model' },
        to: { providerId: 'primary', model: 'p-model' },
        timestamp: 1,
      },
    });
    expect([state.provider, state.model]).toEqual(['primary', 'p-model']);
  });
});
