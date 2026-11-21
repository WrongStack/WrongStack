import { describe, expect, it } from 'vitest';
import { createWrongTraceClient } from '../client.js';

describe('createWrongTraceClient respects opts.fetchImpl', () => {
  it('routes subsequent HTTP calls through the injected fetchImpl instead of globalThis.fetch', async () => {
    const calls: string[] = [];
    const customFetch = (async (input: string | URL | Request) => {
      const url = String(input);
      calls.push(url);
      if (url.endsWith('/api/health')) {
        return new Response(JSON.stringify({ ok: true, version: '0.3.3' }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      if (url.endsWith('/api/guardrail/lock')) {
        return new Response(JSON.stringify({ ok: false, owner: 'peer-agent' }), {
          status: 409,
          headers: { 'content-type': 'application/json' },
        });
      }
      return new Response('[]', { status: 200, headers: { 'content-type': 'application/json' } });
    }) as typeof fetch;

    const client = await createWrongTraceClient({
      baseUrl: 'http://127.0.0.1:1',
      socketPath: '',
      fetchImpl: customFetch,
    });

    expect(client.isAvailable).toBe(true);
    expect(await client.getHealth()).toMatchObject({ ok: true, version: '0.3.3' });
    expect(await client.lockFile('src/app.ts', 'test')).toMatchObject({
      ok: false,
      owner: 'peer-agent',
    });
    expect(calls).toHaveLength(3);
  });
});
