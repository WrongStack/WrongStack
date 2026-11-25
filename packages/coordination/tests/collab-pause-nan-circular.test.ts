import { describe, expect, it } from 'vitest';
import { collabInjectMiddleware, collabPauseMiddleware } from '../src/collab-pause.js';

describe('collab-pause timeout and circular injection guards', () => {
  it('sanitizes non-finite defaultTimeoutMs and safely stringifies circular injected content', async () => {
    let passedTimeout: number | undefined;
    const pauseMw = collabPauseMiddleware(
      {
        isPaused: () => true,
        getState: () => ({ pausedBy: 'u1', pausedAt: 'now' }),
        waitForResume: async (ms: number) => {
          passedTimeout = ms;
          return true;
        },
      } as never,
      { defaultTimeoutMs: Number.NaN },
    );
    await pauseMw.handler({ toolUse: { name: 't' } } as never, async (p) => p);
    expect(passedTimeout).toBe(60_000);

    const circular: Record<string, unknown> = {};
    circular.self = circular;
    const payload = { toolUse: { id: '1', name: 't' }, result: {} as Record<string, unknown> };
    const injectMw = collabInjectMiddleware({
      takeInjection: () => ({
        content: circular,
        isError: false,
        reason: 'test',
        authorId: 'a1',
      }),
      notifyInjectionConsumed: () => {},
    } as never);
    await injectMw.handler(payload as never, async (p) => p);
    expect(typeof payload.result.content).toBe('string');
  });
});
