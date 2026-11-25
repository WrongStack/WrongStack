import { describe, expect, it } from 'vitest';
import { createHttpClient } from '../src/http.js';

describe('createHttpClient sessionId control character rejection (F1866)', () => {
  it('rejects session IDs containing NUL bytes or control characters', async () => {
    const client = createHttpClient({
      url: 'http://127.0.0.1:3456',
      fetch: (async () =>
        new Response(JSON.stringify({ agents: [] }), { status: 200 })) as typeof fetch,
    });

    for (const badId of ['sess\0id', 'sess\nid', 'sess\rid', 'sess\x7fid', '', '.', '..']) {
      expect(() => client.sessionAgents(badId)).toThrow(/Invalid sessionId/);
    }

    const ok = await client.sessionAgents('valid-session-1');
    expect(ok.agents).toEqual([]);
  });
});
