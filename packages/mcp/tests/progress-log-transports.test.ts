import { EventBus } from '@wrongstack/contracts/kernel';
import type { Logger } from '@wrongstack/contracts/types';
import { ToolRegistry } from '@wrongstack/core/registry';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MCPClient } from '../src/client.js';
import { MCPRegistry } from '../src/registry.js';
import { SSETransport, StreamableHTTPTransport } from '../src/transport.js';

const originalFetch = globalThis.fetch;

const silentLog: Logger = {
  error: () => {},
  warn: () => {},
  info: () => {},
  debug: () => {},
  trace: () => {},
  child: () => silentLog,
} as never as Logger;

afterEach(() => {
  globalThis.fetch = originalFetch;
  vi.restoreAllMocks();
});

function onLineOf(client: MCPClient): (line: string) => void {
  return (client as never as { onLine: (line: string) => void }).onLine.bind(client);
}

function notification(method: string, params?: unknown): string {
  return JSON.stringify({ jsonrpc: '2.0', method, ...(params === undefined ? {} : { params }) });
}

describe('stdio transport — inbound progress and log notifications', () => {
  it('delivers both notifications to client listeners with parsed values', () => {
    const client = new MCPClient({
      protocolMode: 'legacy',
      name: 'fixture',
      transport: 'stdio',
      command: 'fixture',
    });
    const onProgress = vi.fn();
    const onLog = vi.fn();
    client.addProgressListener(onProgress);
    client.addLogMessageListener(onLog);
    const onLine = onLineOf(client);

    onLine(
      notification('notifications/progress', {
        progressToken: 'progress-1',
        progress: 1,
        total: 4,
        message: 'one quarter',
      }),
    );
    expect(onProgress).toHaveBeenCalledWith('fixture', {
      progressToken: 'progress-1',
      progress: 1,
      total: 4,
      message: 'one quarter',
    });

    onLine(notification('notifications/message', { level: 'warning', logger: 'db', data: 'slow' }));
    expect(onLog).toHaveBeenCalledWith('fixture', {
      level: 'warning',
      logger: 'db',
      data: 'slow',
    });
  });

  it('ignores malformed payloads and keeps delivering later messages', () => {
    const client = new MCPClient({
      protocolMode: 'legacy',
      name: 'fixture',
      transport: 'stdio',
      command: 'fixture',
    });
    const onProgress = vi.fn();
    const onLog = vi.fn();
    client.addProgressListener(onProgress);
    client.addLogMessageListener(onLog);
    const onLine = onLineOf(client);

    // A notification has no reply: malformed ones are dropped, never thrown.
    onLine(notification('notifications/progress', { progress: 'half' }));
    onLine(notification('notifications/progress'));
    onLine(notification('notifications/message', { level: 'loud' }));
    onLine(notification('notifications/message'));
    expect(onProgress).not.toHaveBeenCalled();
    expect(onLog).not.toHaveBeenCalled();

    onLine(notification('notifications/progress', { progressToken: 7, progress: 2 }));
    expect(onProgress).toHaveBeenCalledTimes(1);
    expect(onProgress).toHaveBeenCalledWith('fixture', {
      progressToken: 7,
      progress: 2,
      total: undefined,
      message: undefined,
    });
  });

  it('isolates a throwing listener', () => {
    const client = new MCPClient({
      protocolMode: 'legacy',
      name: 'fixture',
      transport: 'stdio',
      command: 'fixture',
    });
    const seenProgress = vi.fn();
    const seenLog = vi.fn();
    client.addProgressListener(() => {
      throw new Error('listener failed');
    });
    client.addProgressListener(seenProgress);
    client.addLogMessageListener(() => {
      throw new Error('listener failed');
    });
    client.addLogMessageListener(seenLog);
    const onLine = onLineOf(client);

    onLine(notification('notifications/progress', { progressToken: 1, progress: 1 }));
    onLine(notification('notifications/message', { level: 'info', data: 'x' }));
    expect(seenProgress).toHaveBeenCalledTimes(1);
    expect(seenLog).toHaveBeenCalledTimes(1);
  });

  it('stops delivery after remove listener', () => {
    const client = new MCPClient({
      protocolMode: 'legacy',
      name: 'fixture',
      transport: 'stdio',
      command: 'fixture',
    });
    const onProgress = vi.fn();
    const onLog = vi.fn();
    client.addProgressListener(onProgress);
    client.addLogMessageListener(onLog);
    client.removeProgressListener(onProgress);
    client.removeLogMessageListener(onLog);
    onLineOf(client)(notification('notifications/progress', { progressToken: 1, progress: 1 }));
    onLineOf(client)(notification('notifications/message', { level: 'info', data: 'x' }));
    expect(onProgress).not.toHaveBeenCalled();
    expect(onLog).not.toHaveBeenCalled();
  });

  it('sends a fresh params._meta.progressToken on every tools/call', async () => {
    const client = new MCPClient({
      protocolMode: 'legacy',
      name: 'fixture',
      transport: 'stdio',
      command: 'fixture',
    });
    const internals = client as never as {
      state: 'connected';
      request: (
        method: string,
        params: unknown,
        timeoutMs?: number,
        opts?: { signal?: AbortSignal | undefined },
      ) => Promise<{ result: unknown }>;
    };
    internals.state = 'connected';
    const request = vi.fn(
      async (
        _method: string,
        _params: unknown,
        _timeoutMs?: number,
        _opts?: { signal?: AbortSignal | undefined },
      ) => ({ jsonrpc: '2.0' as const, id: 1, result: { content: 'ok' } }),
    );
    internals.request = request;

    await client.callTool('slow-tool', {});
    await client.callTool('slow-tool', {});
    const tokens = request.mock.calls.map(
      (call) =>
        (call[1] as { _meta?: { progressToken?: string } })._meta?.progressToken ?? undefined,
    );
    expect(tokens).toEqual(['progress-1', 'progress-2']);
    expect(request.mock.calls[0]?.[0]).toBe('tools/call');
  });
});

describe('SSE transport — inbound progress and log notifications', () => {
  it('delivers both from the event stream and survives malformed payloads', async () => {
    const transport = new SSETransport({ name: 'sse', url: 'https://example.test' });
    const onProgress = vi.fn();
    const onLog = vi.fn();
    transport.onProgress(() => {
      throw new Error('listener failed');
    });
    transport.onProgress(onProgress);
    transport.onLogMessage(onLog);
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(
          new TextEncoder().encode(
            [
              'data: {"method":"notifications/progress","params":{"progressToken":"progress-1","progress":1,"total":4,"message":"one quarter"}}',
              '',
              'data: {"method":"notifications/message","params":{"level":"info","logger":"db","data":"connected"}}',
              '',
              'data: {"method":"notifications/progress","params":{"progress":"half"}}',
              '',
              'data: {"method":"notifications/message","params":{"level":"loud"}}',
              '',
              'data: {"method":"notifications/progress","params":{"progressToken":7,"progress":2}}',
              '',
              '',
            ].join('\n'),
          ),
        );
        controller.close();
      },
    });
    globalThis.fetch = vi.fn(async () => new Response(stream));
    vi.spyOn(
      transport as never as { httpPost: (method: string, params: unknown) => Promise<unknown> },
      'httpPost',
    ).mockImplementation(async (method) => {
      if (method === 'initialize') {
        return {
          jsonrpc: '2.0',
          id: 1,
          result: {
            protocolVersion: '2024-11-05',
            capabilities: { tools: {}, resources: {}, prompts: {} },
            serverInfo: { name: 'fixture', version: '1.0.0' },
          },
        };
      }
      if (method === 'notifications/initialized') throw new Error('not required');
      return { jsonrpc: '2.0', id: 2, error: { code: 1, message: 'unavailable' } };
    });

    await transport.connect();
    await vi.waitFor(() => {
      // Malformed payloads dropped; the good notification after them still
      // arrived — the stream was not broken.
      expect(onProgress).toHaveBeenCalledTimes(2);
    });
    expect(onLog).toHaveBeenCalledTimes(1);
    expect(onProgress).toHaveBeenNthCalledWith(1, {
      progressToken: 'progress-1',
      progress: 1,
      total: 4,
      message: 'one quarter',
    });
    expect(onProgress).toHaveBeenNthCalledWith(2, {
      progressToken: 7,
      progress: 2,
      total: undefined,
      message: undefined,
    });
    expect(onLog).toHaveBeenCalledWith({ level: 'info', logger: 'db', data: 'connected' });
    await transport.close();
  });

  it('sends a fresh params._meta.progressToken on every tools/call', async () => {
    const transport = new SSETransport({ name: 'sse', url: 'https://example.test' });
    (transport as never as { state: 'connected' }).state = 'connected';
    const bodies: { method?: string; params?: { _meta?: { progressToken?: string } } }[] = [];
    globalThis.fetch = vi.fn(async (_url: unknown, init?: RequestInit) => {
      const request = JSON.parse(String(init?.body ?? '{}'));
      bodies.push(request);
      return new Response(
        JSON.stringify({ jsonrpc: '2.0', id: request.id, result: { content: 'ok' } }),
        {
          status: 200,
          headers: { 'content-type': 'application/json' },
        },
      );
    });

    await transport.callTool('slow', {});
    await transport.callTool('slow', {});
    expect(bodies.map((b) => b.method)).toEqual(['tools/call', 'tools/call']);
    expect(bodies.map((b) => b.params?._meta?.progressToken)).toEqual(['progress-1', 'progress-2']);
  });
});

describe('streamable-http transport — inbound progress and log notifications', () => {
  it('delivers both from the response stream and survives malformed payloads', async () => {
    const transport = new StreamableHTTPTransport({
      protocolMode: 'legacy',
      name: 'streamable',
      url: 'https://example.test',
    });
    const onProgress = vi.fn();
    const onLog = vi.fn();
    transport.onProgress(onProgress);
    transport.onLogMessage(() => {
      throw new Error('listener failed');
    });
    transport.onLogMessage(onLog);
    const events = [
      'data: {"jsonrpc":"2.0","method":"notifications/progress","params":{"progressToken":"progress-1","progress":1,"total":4}}',
      '',
      'data: {"jsonrpc":"2.0","method":"notifications/message","params":{"level":"error","data":"boom"}}',
      '',
      'data: {"jsonrpc":"2.0","method":"notifications/progress","params":{"progressToken":1}}',
      '',
      'data: {"jsonrpc":"2.0","method":"notifications/message","params":{"level":3}}',
      '',
      'data: {"jsonrpc":"2.0","method":"notifications/progress","params":{"progressToken":7,"progress":2}}',
      '',
      'data: {"jsonrpc":"2.0","id":1,"result":{"content":"ok"}}',
      '',
      '',
    ].join('\n');
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(events));
        controller.close();
      },
    });
    globalThis.fetch = vi.fn(
      async () =>
        new Response(stream, {
          status: 200,
          headers: { 'content-type': 'text/event-stream' },
        }),
    );

    const res = await transport.request('tools/list', {});
    expect(onProgress).toHaveBeenCalledTimes(2);
    expect(onLog).toHaveBeenCalledTimes(1);
    expect(onProgress).toHaveBeenNthCalledWith(1, {
      progressToken: 'progress-1',
      progress: 1,
      total: 4,
      message: undefined,
    });
    expect(onProgress).toHaveBeenNthCalledWith(2, {
      progressToken: 7,
      progress: 2,
      total: undefined,
      message: undefined,
    });
    expect(onLog).toHaveBeenCalledWith({ level: 'error', logger: undefined, data: 'boom' });
    // The response after the malformed notifications was still matched.
    expect(res.result).toEqual({ content: 'ok' });
  });

  it('sends a fresh params._meta.progressToken on every tools/call', async () => {
    const transport = new StreamableHTTPTransport({
      protocolMode: 'legacy',
      name: 'streamable',
      url: 'https://example.test',
    });
    (transport as never as { state: 'connected' }).state = 'connected';
    const bodies: { method?: string; params?: { _meta?: { progressToken?: string } } }[] = [];
    globalThis.fetch = vi.fn(async (_url: unknown, init?: RequestInit) => {
      const request = JSON.parse(String(init?.body ?? '{}'));
      bodies.push(request);
      return new Response(
        JSON.stringify({ jsonrpc: '2.0', id: request.id, result: { content: 'ok' } }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    });

    await transport.callTool('slow', {});
    await transport.callTool('slow', {});
    expect(bodies.map((b) => b.method)).toEqual(['tools/call', 'tools/call']);
    expect(bodies.map((b) => b.params?._meta?.progressToken)).toEqual(['progress-1', 'progress-2']);

    // The registration disposers returned by onProgress/onLogMessage unsubscribe.
    const disposeProgress = transport.onProgress(() => {});
    const disposeLog = transport.onLogMessage(() => {});
    disposeProgress();
    disposeLog();
  });

  it('a full MCPClient connect surfaces progress/log notifications (streamable)', async () => {
    globalThis.fetch = vi.fn(async (_url: unknown, init?: RequestInit) => {
      const request = JSON.parse(String(init?.body ?? '{}'));
      if (request.method === 'notifications/initialized') {
        return new Response('', { status: 202 });
      }
      if (request.method === 'initialize') {
        return new Response(
          JSON.stringify({
            jsonrpc: '2.0',
            id: request.id,
            result: {
              protocolVersion: '2024-11-05',
              capabilities: { tools: {}, resources: {}, prompts: {} },
              serverInfo: { name: 'fixture', version: '1.0.0' },
            },
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      }
      // tools/list answers over SSE, with the notifications riding ahead of
      // the response on the same stream.
      const body = [
        'data: {"jsonrpc":"2.0","method":"notifications/progress","params":{"progressToken":"progress-1","progress":1,"total":2}}',
        '',
        'data: {"jsonrpc":"2.0","method":"notifications/message","params":{"level":"info","data":"halfway"}}',
        '',
        `data: {"jsonrpc":"2.0","id":${request.id},"result":{"tools":[]}}`,
        '',
        '',
      ].join('\n');
      return new Response(new TextEncoder().encode(body), {
        status: 200,
        headers: { 'content-type': 'text/event-stream' },
      });
    });
    const client = new MCPClient({
      protocolMode: 'legacy',
      name: 'http-fixture',
      transport: 'streamable-http',
      url: 'https://m.test/mcp',
    });
    const progress: unknown[] = [];
    const logs: unknown[] = [];
    client.addProgressListener((name, p) => progress.push({ name, ...p }));
    client.addLogMessageListener((name, l) => logs.push({ name, ...l }));
    try {
      await client.connect();
      expect(progress).toEqual([
        {
          name: 'http-fixture',
          progressToken: 'progress-1',
          progress: 1,
          total: 2,
          message: undefined,
        },
      ]);
      expect(logs).toEqual([
        { name: 'http-fixture', level: 'info', logger: undefined, data: 'halfway' },
      ]);
    } finally {
      await client.close();
    }
  });

  it('a full MCPClient connect surfaces progress/log notifications (SSE)', async () => {
    globalThis.fetch = vi.fn(async (_url: unknown, init?: RequestInit) => {
      const method = init?.method ?? 'GET';
      if (method === 'GET') {
        const body = [
          'event: endpoint',
          'data: /mcp',
          '',
          'data: {"method":"notifications/progress","params":{"progressToken":"progress-1","progress":1}}',
          '',
          'data: {"method":"notifications/message","params":{"level":"warning","data":"slow"}}',
          '',
          '',
        ].join('\n');
        const stream = new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(new TextEncoder().encode(body));
          },
        });
        return new Response(stream, {
          status: 200,
          headers: { 'content-type': 'text/event-stream' },
        });
      }
      const request = JSON.parse(String(init?.body ?? '{}'));
      const result =
        request.method === 'initialize'
          ? {
              protocolVersion: '2024-11-05',
              capabilities: { tools: {}, resources: {}, prompts: {} },
              serverInfo: { name: 'fixture', version: '1.0.0' },
            }
          : { tools: [] };
      return new Response(JSON.stringify({ jsonrpc: '2.0', id: request.id, result }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    });
    const client = new MCPClient({
      protocolMode: 'legacy',
      name: 'sse-fixture',
      transport: 'sse',
      url: 'https://m.test/mcp',
    });
    const progress: unknown[] = [];
    const logs: unknown[] = [];
    client.addProgressListener((name, p) => progress.push({ name, ...p }));
    client.addLogMessageListener((name, l) => logs.push({ name, ...l }));
    try {
      await client.connect();
      await vi.waitFor(() => {
        expect(progress).toHaveLength(1);
        expect(logs).toHaveLength(1);
      });
      expect(progress[0]).toEqual({
        name: 'sse-fixture',
        progressToken: 'progress-1',
        progress: 1,
        total: undefined,
        message: undefined,
      });
      expect(logs[0]).toEqual({
        name: 'sse-fixture',
        level: 'warning',
        logger: undefined,
        data: 'slow',
      });
    } finally {
      await client.close();
    }
  });
});

describe('MCPRegistry — progress and log events', () => {
  it('emits mcp.progress and mcp.log once per notification', () => {
    const events = new EventBus();
    const reg = new MCPRegistry({ toolRegistry: new ToolRegistry(), events, log: silentLog });
    const internals = reg as never as {
      servers: Map<string, unknown>;
      addCatalogListeners: (client: {
        addResourcesChangedListener: () => void;
        addPromptsChangedListener: () => void;
        addResourceUpdatedListener?: () => void;
        addProgressListener?: (fn: unknown) => void;
        addLogMessageListener?: (fn: unknown) => void;
      }) => void;
    };
    internals.servers.set('srv', { cfg: { name: 'srv' } });
    const progress: unknown[] = [];
    const logs: unknown[] = [];
    events.on('mcp.progress', (p) => progress.push(p));
    events.on('mcp.log', (l) => logs.push(l));

    // addCatalogListeners is the seam the registry uses on a live client —
    // invoking the registered callbacks proves listener→registry→EventBus.
    const registered: Record<'progress' | 'log', unknown[]> = { progress: [], log: [] };
    internals.addCatalogListeners({
      addResourcesChangedListener: vi.fn(),
      addPromptsChangedListener: vi.fn(),
      addResourceUpdatedListener: vi.fn(),
      addProgressListener: (fn) => registered.progress.push(fn),
      addLogMessageListener: (fn) => registered.log.push(fn),
    });
    const notifyProgress = registered.progress[0] as (name: string, p: unknown) => void;
    const notifyLog = registered.log[0] as (name: string, l: unknown) => void;

    notifyProgress('srv', {
      progressToken: 'progress-1',
      progress: 1,
      total: 4,
      message: 'one quarter',
    });
    notifyLog('srv', { level: 'info', logger: 'db', data: 'connected' });
    expect(progress).toEqual([
      {
        name: 'srv',
        progressToken: 'progress-1',
        progress: 1,
        total: 4,
        message: 'one quarter',
      },
    ]);
    expect(logs).toEqual([{ name: 'srv', level: 'info', logger: 'db', data: 'connected' }]);

    // A notification for an unknown server is dropped, not emitted.
    notifyProgress('ghost', { progressToken: 1, progress: 1 });
    notifyLog('ghost', { level: 'info', data: 'x' });
    expect(progress).toHaveLength(1);
    expect(logs).toHaveLength(1);
  });
});
