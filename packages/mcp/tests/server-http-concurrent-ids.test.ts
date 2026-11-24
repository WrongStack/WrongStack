import { describe, expect, it } from 'vitest';
import { MCPServer, type MCPServerToolHost } from '../src/server-dispatch.js';
import { serveHttp } from '../src/server-http.js';

describe('P0.2 HTTP MCPServer concurrent requestId isolation', () => {
  it('does not abort concurrent stateless HTTP clients that reuse request id 1', async () => {
    let releaseFirst!: () => void;
    let releaseSecond!: () => void;
    let calls = 0;

    const host: MCPServerToolHost = {
      listTools: async () => [
        {
          name: 'slow_echo',
          description: 'Echoes label after deferred release',
          inputSchema: {
            type: 'object',
            properties: { label: { type: 'string' } },
            required: ['label'],
          },
        },
      ],
      callTool: async (_name, args, opts) => {
        const signal = opts?.signal;
        const idx = ++calls;
        await new Promise<void>((resolve, reject) => {
          const onAbort = () => reject(signal?.reason ?? new Error('aborted'));
          signal?.addEventListener('abort', onAbort, { once: true });
          const done = () => {
            signal?.removeEventListener('abort', onAbort);
            resolve();
          };
          if (idx === 1) releaseFirst = done;
          else releaseSecond = done;
        });
        return { content: [{ type: 'text', text: String(args['label']) }], isError: false };
      },
    };

    const server = new MCPServer({ host });
    const http = await serveHttp(server, { host: '127.0.0.1', port: 0 });
    try {
      const makeReq = (label: string, sessionId?: string) =>
        fetch(http.url, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            ...(sessionId ? { 'mcp-session-id': sessionId } : {}),
          },
          body: JSON.stringify({
            jsonrpc: '2.0',
            id: 1,
            method: 'tools/call',
            params: { name: 'slow_echo', arguments: { label } },
          }),
        }).then(
          (r) =>
            r.json() as Promise<{
              id: number;
              result?: { content: { text: string }[] };
              error?: unknown;
            }>,
        );

      const p1 = makeReq('client-a');
      const p2 = makeReq('client-b');

      // Wait until both tool calls are in-flight simultaneously
      const deadline = Date.now() + 2000;
      while (calls < 2 && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 10));
      }
      expect(calls).toBe(2);

      releaseFirst();
      releaseSecond();

      const [r1, r2] = await Promise.all([p1, p2]);
      expect(r1.error).toBeUndefined();
      expect(r2.error).toBeUndefined();
      expect(r1.result?.content[0]?.text).toBe('client-a');
      expect(r2.result?.content[0]?.text).toBe('client-b');
    } finally {
      await http.close();
    }
  });

  it('scopes notifications/cancelled to matching Mcp-Session-Id only', async () => {
    let releaseB!: () => void;
    let calls = 0;

    const host: MCPServerToolHost = {
      listTools: async () => [
        {
          name: 'wait_tool',
          description: 'Waits for release or abort',
          inputSchema: { type: 'object', properties: { tag: { type: 'string' } } },
        },
      ],
      callTool: async (_name, args, opts) => {
        const signal = opts?.signal;
        calls++;
        await new Promise<void>((resolve, reject) => {
          if (signal?.aborted) {
            reject(signal.reason ?? new Error('aborted'));
            return;
          }
          const onAbort = () => reject(signal?.reason ?? new Error('aborted'));
          signal?.addEventListener('abort', onAbort, { once: true });
          if (args['tag'] === 'b') {
            releaseB = () => {
              signal?.removeEventListener('abort', onAbort);
              resolve();
            };
          }
        });
        return { content: [{ type: 'text', text: String(args['tag']) }], isError: false };
      },
    };

    const server = new MCPServer({ host });
    const http = await serveHttp(server, { host: '127.0.0.1', port: 0 });
    try {
      const callWithSession = (tag: string, sid: string) =>
        fetch(http.url, {
          method: 'POST',
          headers: { 'content-type': 'application/json', 'mcp-session-id': sid },
          body: JSON.stringify({
            jsonrpc: '2.0',
            id: 7,
            method: 'tools/call',
            params: { name: 'wait_tool', arguments: { tag } },
          }),
        }).then(
          (r) =>
            r.json() as Promise<{
              result?: { content: { text: string }[] };
              error?: { message: string };
            }>,
        );

      const pA = callWithSession('a', 'sess-A');
      const pB = callWithSession('b', 'sess-B');

      const deadline = Date.now() + 2000;
      while (calls < 2 && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 10));
      }
      expect(calls).toBe(2);

      // Cancel id: 7 ONLY for sess-A
      await fetch(http.url, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'mcp-session-id': 'sess-A' },
        body: JSON.stringify({
          jsonrpc: '2.0',
          method: 'notifications/cancelled',
          params: { requestId: 7, reason: 'cancel A only' },
        }),
      });

      const rA = await pA;
      expect(rA.error?.message).toContain('cancel A only');

      releaseB();
      const rB = await pB;
      expect(rB.error).toBeUndefined();
      expect(rB.result?.content[0]?.text).toBe('b');
    } finally {
      await http.close();
    }
  });
});
