import { afterEach, describe, expect, it } from 'vitest';
import { MCPClient } from '../src/client.js';
import { SSETransport, StreamableHTTPTransport } from '../src/transport.js';

const originalFetch = globalThis.fetch;
const MAX_SAFE_ID = Number.MAX_SAFE_INTEGER;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

async function expectHttpIdsToWrap(
  transport: SSETransport | StreamableHTTPTransport,
): Promise<void> {
  const sent: number[] = [];
  globalThis.fetch = async (_input, init) => {
    const request = JSON.parse(String(init?.body)) as { id: number };
    sent.push(request.id);
    return new Response(JSON.stringify({ jsonrpc: '2.0', id: request.id, result: {} }), {
      headers: { 'content-type': 'application/json' },
    });
  };

  (transport as unknown as { _nextId: number })._nextId = MAX_SAFE_ID;
  await transport.request('resources/list', {});
  await transport.request('resources/list', {});

  expect(sent).toEqual([MAX_SAFE_ID, 1]);
}

describe('MCP JSON-RPC request ID rollover', () => {
  it('wraps SSE request IDs before precision loss', async () => {
    await expectHttpIdsToWrap(new SSETransport({ name: 'sse', url: 'https://example.test' }));
  });

  it('wraps streamable HTTP request IDs before precision loss', async () => {
    await expectHttpIdsToWrap(
      new StreamableHTTPTransport({ name: 'streamable', url: 'https://example.test' }),
    );
  });

  it('wraps stdio request IDs without overwriting pending responses', async () => {
    const client = new MCPClient({ name: 'stdio', transport: 'stdio', command: 'fixture' });
    const internals = client as unknown as {
      child: { stdin: { destroyed: boolean; write: (data: string) => boolean } };
      nextId: number;
      request: (method: string, params: unknown) => Promise<unknown>;
      onLine: (line: string) => void;
    };
    const sent: number[] = [];
    internals.nextId = MAX_SAFE_ID;
    internals.child = {
      stdin: {
        destroyed: false,
        write: (data) => {
          sent.push((JSON.parse(data) as { id: number }).id);
          return true;
        },
      },
    };

    const first = internals.request('resources/list', {});
    const second = internals.request('resources/list', {});
    expect(sent).toEqual([MAX_SAFE_ID, 1]);

    internals.onLine(JSON.stringify({ jsonrpc: '2.0', id: MAX_SAFE_ID, result: { request: 'first' } }));
    internals.onLine(JSON.stringify({ jsonrpc: '2.0', id: 1, result: { request: 'second' } }));
    await expect(first).resolves.toMatchObject({ result: { request: 'first' } });
    await expect(second).resolves.toMatchObject({ result: { request: 'second' } });
  });
});
