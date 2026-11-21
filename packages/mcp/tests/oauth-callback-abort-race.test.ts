import { describe, expect, it } from 'vitest';
import { startMcpOAuthCallbackServer } from '../src/authorization-callback-server.js';

describe('startMcpOAuthCallbackServer abort during listen', () => {
  it('closes the bound server and rejects when signal aborts while listen() is in flight', async () => {
    const ac = new AbortController();
    const startPromise = startMcpOAuthCallbackServer({ timeoutMs: 30_000, signal: ac.signal });
    ac.abort(new Error('aborted-during-listen'));

    await expect(startPromise).rejects.toThrow('aborted-during-listen');
  });
});
