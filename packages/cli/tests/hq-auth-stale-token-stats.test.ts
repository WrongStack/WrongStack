import { describe, expect, it } from 'vitest';
import { createHqAuthState } from '../src/hq-server/auth-state.js';

describe('createHqAuthState live tokenStats accuracy', () => {
  it('excludes tokens that expired after initial projection from browserTotal', async () => {
    const state = createHqAuthState(
      {
        browserTokens: [
          {
            id: 't1',
            token: 'tok-1',
            createdAt: new Date(Date.now() - 10_000).toISOString(),
            expiresAt: new Date(Date.now() + 25).toISOString(),
          },
        ],
        clientTokens: [],
      } as never,
      '/tmp/does-not-exist',
    );
    await new Promise((r) => setTimeout(r, 40));
    const stats = state.tokenStats();
    expect(stats.expired).toBe(1);
    expect(stats.browserTotal).toBe(0);
  });
});
