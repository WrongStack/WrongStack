import { EventEmitter } from 'node:events';
import { createServer } from 'node:http';
import { PassThrough } from 'node:stream';
import { describe, expect, it, vi } from 'vitest';
import {
  MCPServer,
  type MCPServerToolHost,
  serveHttp,
  serveStdio,
  toContentBlocks,
} from '../src/server.js';

function makeHost(overrides: Partial<MCPServerToolHost> = {}): MCPServerToolHost {
  return {
    listTools: () => [{ name: 'echo', description: 'echo back', inputSchema: { type: 'object' } }],
    callTool: async (name, args) => ({
      content: `${name}:${JSON.stringify(args)}`,
      isError: false,
    }),
    ...overrides,
  };
}

async function call(server: MCPServer, msg: unknown): Promise<Record<string, unknown> | null> {
  const res = await server.handleMessage(JSON.stringify(msg));
  return res === null ? null : (JSON.parse(res) as Record<string, unknown>);
}

describe('MCPServer.handleMessage', () => {
  it('returns INVALID_REQUEST for malformed JSON-RPC envelopes', async () => {
    const server = new MCPServer({ host: makeHost() });
    for (const message of [null, 42, 'text', {}, { id: 8 }, { id: 'request-id' }]) {
      const response = await call(server, message);
      expect((response!.error as { code: number }).code).toBe(-32600);
    }
  });

  it('responds to initialize with protocol version and serverInfo', async () => {
    const server = new MCPServer({ host: makeHost(), serverInfo: { name: 'ws', version: '9' } });
    const res = await call(server, { jsonrpc: '2.0', id: 1, method: 'initialize', params: {} });
    expect(res?.id).toBe(1);
    const result = res?.result as Record<string, unknown>;
    expect(result.protocolVersion).toBe('2024-11-05');
    expect(result.serverInfo).toEqual({ name: 'ws', version: '9' });
    expect((result.capabilities as { tools?: unknown }).tools).toBeDefined();
  });

  it('lists tools', async () => {
    const server = new MCPServer({ host: makeHost() });
    const res = await call(server, { jsonrpc: '2.0', id: 2, method: 'tools/list' });
    const tools = (res!.result as { tools: unknown[] }).tools;
    expect(tools).toHaveLength(1);
    expect((tools[0] as { name: string }).name).toBe('echo');
  });

  it('calls a tool and wraps the result as content blocks', async () => {
    const server = new MCPServer({ host: makeHost() });
    const res = await call(server, {
      jsonrpc: '2.0',
      id: 3,
      method: 'tools/call',
      params: { name: 'echo', arguments: { x: 1 } },
    });
    const result = res?.result as {
      content: Array<{ type: string; text: string }>;
      isError: boolean;
    };
    expect(result.isError).toBe(false);
    expect(result.content[0]).toEqual({ type: 'text', text: 'echo:{"x":1}' });
  });

  it('passes the call through when the host cannot enumerate tools', async () => {
    // assertArgumentsMatchSchema: a host whose listTools() rejects must not
    // block the call — the real failure surfaces from callTool itself
    // (server.ts:278-281).
    const server = new MCPServer({
      host: makeHost({
        listTools: async () => {
          throw new Error('tool store unavailable');
        },
      }),
    });
    const res = await call(server, {
      jsonrpc: '2.0',
      id: 3,
      method: 'tools/call',
      params: { name: 'echo', arguments: { x: 1 } },
    });
    const result = res?.result as {
      content: Array<{ type: string; text: string }>;
      isError: boolean;
    };
    expect(result.isError).toBe(false);
    expect(result.content[0]).toEqual({ type: 'text', text: 'echo:{"x":1}' });
  });

  it('reports tool errors as isError without throwing the connection', async () => {
    const host = makeHost({
      callTool: async () => ({ content: 'boom', isError: true }),
    });
    const server = new MCPServer({ host });
    const res = await call(server, {
      jsonrpc: '2.0',
      id: 4,
      method: 'tools/call',
      params: { name: 'echo', arguments: {} },
    });
    const result = res?.result as { isError: boolean };
    expect(result.isError).toBe(true);
  });

  it('validates tool names and normalizes invalid argument containers', async () => {
    const callTool = vi.fn(async () => ({ content: 'ok', isError: false }));
    const server = new MCPServer({ host: makeHost({ callTool }) });
    const invalid = await call(server, {
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: { name: 1 },
    });
    expect((invalid!.error as { code: number }).code).toBe(-32603);
    const missingParams = await call(server, {
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
    });
    expect((missingParams!.error as { code: number }).code).toBe(-32603);

    for (const argumentsValue of [null, [], 'text']) {
      await call(server, {
        jsonrpc: '2.0',
        id: 2,
        method: 'tools/call',
        params: { name: 'echo', arguments: argumentsValue },
      });
    }
    expect(callTool).toHaveBeenCalledTimes(3);
    expect(callTool).toHaveBeenCalledWith('echo', {});
  });

  it('returns INTERNAL_ERROR when the host throws', async () => {
    const host = makeHost({
      callTool: async () => {
        throw new Error('kaboom');
      },
    });
    const server = new MCPServer({ host, logger: { warn: vi.fn() } });
    const res = await call(server, {
      jsonrpc: '2.0',
      id: 5,
      method: 'tools/call',
      params: { name: 'echo' },
    });
    expect((res!.error as { code: number }).code).toBe(-32603);
  });

  it('returns METHOD_NOT_FOUND for unknown methods', async () => {
    const server = new MCPServer({ host: makeHost() });
    const res = await call(server, { jsonrpc: '2.0', id: 6, method: 'does/not/exist' });
    expect((res!.error as { code: number }).code).toBe(-32601);
  });

  it('returns a parse error for malformed JSON', async () => {
    const server = new MCPServer({ host: makeHost() });
    const out = await server.handleMessage('{ not json');
    const res = JSON.parse(out!) as Record<string, unknown>;
    expect((res.error as { code: number }).code).toBe(-32700);
    expect(res.id).toBeNull();
  });

  it('does not respond to notifications (no id)', async () => {
    const server = new MCPServer({ host: makeHost() });
    expect(await call(server, { jsonrpc: '2.0', method: 'notifications/initialized' })).toBeNull();
    expect(await server.handleMessage('   ')).toBeNull();
  });

  it('answers ping', async () => {
    const server = new MCPServer({ host: makeHost() });
    const res = await call(server, { jsonrpc: '2.0', id: 7, method: 'ping' });
    expect(res?.result).toEqual({});
  });

  it('advertises and serves only explicitly configured resources', async () => {
    const server = new MCPServer({
      host: makeHost(),
      resources: [
        {
          uri: 'file:///project/README.md',
          name: 'README.md',
          mimeType: 'text/markdown',
          size: 5,
          contents: [
            { uri: 'file:///project/README.md', mimeType: 'text/markdown', text: 'hello' },
          ],
        },
      ],
    });
    const initialized = await call(server, { jsonrpc: '2.0', id: 1, method: 'initialize' });
    expect(
      (initialized!.result as { capabilities: { resources?: unknown } }).capabilities.resources,
    ).toBeDefined();
    const listed = await call(server, { jsonrpc: '2.0', id: 2, method: 'resources/list' });
    expect((listed!.result as { resources: unknown[] }).resources).toEqual([
      {
        uri: 'file:///project/README.md',
        name: 'README.md',
        mimeType: 'text/markdown',
        size: 5,
      },
    ]);
    const read = await call(server, {
      jsonrpc: '2.0',
      id: 3,
      method: 'resources/read',
      params: { uri: 'file:///project/README.md' },
    });
    expect((read!.result as { contents: Array<{ text: string }> }).contents[0]?.text).toBe('hello');

    const templates = await call(server, {
      jsonrpc: '2.0',
      id: 4,
      method: 'resources/templates/list',
    });
    expect(templates?.result).toEqual({ resourceTemplates: [] });
    const missing = await call(server, {
      jsonrpc: '2.0',
      id: 5,
      method: 'resources/read',
      params: { uri: 'file:///missing' },
    });
    expect((missing!.error as { code: number }).code).toBe(-32603);
  });

  it('paginates explicitly configured resources', async () => {
    const resources = Array.from({ length: 101 }, (_, index) => ({
      uri: `mem://resource/${index}`,
      name: `resource-${index}`,
      contents: [{ uri: `mem://resource/${index}`, text: String(index) }],
    }));
    const server = new MCPServer({ host: makeHost(), resources });
    const first = await call(server, { jsonrpc: '2.0', id: 1, method: 'resources/list' });
    expect((first!.result as { resources: unknown[] }).resources).toHaveLength(100);
    expect((first!.result as { nextCursor: string }).nextCursor).toBe('100');
    const second = await call(server, {
      jsonrpc: '2.0',
      id: 2,
      method: 'resources/list',
      params: { cursor: '100' },
    });
    expect((second!.result as { resources: unknown[] }).resources).toHaveLength(1);
  });

  it('lists and renders explicitly configured prompt templates', async () => {
    const server = new MCPServer({
      host: makeHost(),
      prompts: [
        {
          name: 'review',
          description: 'Review a target',
          arguments: [{ name: 'target', required: true }],
          template: 'Review {{target}}',
        },
      ],
    });
    const listed = await call(server, { jsonrpc: '2.0', id: 1, method: 'prompts/list' });
    expect((listed!.result as { prompts: Array<{ name: string }> }).prompts[0]?.name).toBe(
      'review',
    );
    const initialized = await call(server, { jsonrpc: '2.0', id: 9, method: 'initialize' });
    expect(
      (initialized!.result as { capabilities: { prompts?: unknown } }).capabilities.prompts,
    ).toBeDefined();
    const selected = await call(server, {
      jsonrpc: '2.0',
      id: 2,
      method: 'prompts/get',
      params: { name: 'review', arguments: { target: 'src/' } },
    });
    expect(
      (
        selected!.result as {
          messages: Array<{ content: { text: string } }>;
        }
      ).messages[0]?.content.text,
    ).toBe('Review src/');

    const missingArgument = await call(server, {
      jsonrpc: '2.0',
      id: 3,
      method: 'prompts/get',
      params: { name: 'review' },
    });
    expect((missingArgument!.error as { code: number }).code).toBe(-32603);
    const missingPrompt = await call(server, {
      jsonrpc: '2.0',
      id: 4,
      method: 'prompts/get',
      params: { name: 'missing' },
    });
    expect((missingPrompt!.error as { code: number }).code).toBe(-32603);
  });

  it('serves static prompt messages and validates prompt arguments', async () => {
    const server = new MCPServer({
      host: makeHost(),
      prompts: [
        {
          name: 'static',
          arguments: [{ name: 'optional', required: false }],
          messages: [{ role: 'assistant', content: { type: 'text', text: 'ready' } }],
        },
        {
          name: 'empty',
        },
        {
          name: 'template',
          template: 'Hello {{name}}',
        },
      ],
    });
    const staticPrompt = await call(server, {
      jsonrpc: '2.0',
      id: 1,
      method: 'prompts/get',
      params: { name: 'static', arguments: { optional: 'yes' } },
    });
    expect(
      (staticPrompt!.result as { messages: Array<{ content: { text: string } }> }).messages[0]
        ?.content.text,
    ).toBe('ready');
    const emptyPrompt = await call(server, {
      jsonrpc: '2.0',
      id: 2,
      method: 'prompts/get',
      params: { name: 'empty' },
    });
    expect((emptyPrompt!.result as { messages: unknown[] }).messages).toEqual([]);

    for (const argumentsValue of [[], 'invalid', { optional: 1 }]) {
      const response = await call(server, {
        jsonrpc: '2.0',
        id: 3,
        method: 'prompts/get',
        params: { name: 'static', arguments: argumentsValue },
      });
      expect((response!.error as { code: number }).code).toBe(-32603);
    }
    const missingTemplateValue = await call(server, {
      jsonrpc: '2.0',
      id: 4,
      method: 'prompts/get',
      params: { name: 'template', arguments: {} },
    });
    expect((missingTemplateValue!.error as { code: number }).code).toBe(-32603);
  });

  it('validates resource and prompt pagination cursors', async () => {
    const resources = [
      {
        uri: 'mem://one',
        name: 'one',
        contents: [{ uri: 'mem://one', text: 'one' }],
      },
    ];
    const prompts = Array.from({ length: 101 }, (_, index) => ({
      name: `prompt-${index}`,
      template: 'hello',
    }));
    const server = new MCPServer({ host: makeHost(), resources, prompts });

    for (const cursor of [1, '-1', 'not-a-number', '999999999999999999999999']) {
      const response = await call(server, {
        jsonrpc: '2.0',
        id: 1,
        method: 'resources/list',
        params: { cursor },
      });
      expect((response!.error as { code: number }).code).toBe(-32603);
    }
    const firstPrompts = await call(server, {
      jsonrpc: '2.0',
      id: 2,
      method: 'prompts/list',
    });
    expect((firstPrompts!.result as { nextCursor: string }).nextCursor).toBe('100');
  });

  it('requires non-empty resource and prompt names', async () => {
    const server = new MCPServer({
      host: makeHost(),
      resources: [{ uri: 'mem://one', name: 'one', contents: [] }],
      prompts: [{ name: 'one' }],
    });
    for (const [method, params] of [
      ['resources/read', {}],
      ['resources/read', { uri: '' }],
      ['prompts/get', {}],
      ['prompts/get', { name: '' }],
    ] as const) {
      const response = await call(server, { jsonrpc: '2.0', id: 1, method, params });
      expect((response!.error as { code: number }).code).toBe(-32603);
    }
  });

  it('keeps tools-only server behavior for unadvertised resources and prompts', async () => {
    const server = new MCPServer({ host: makeHost() });
    for (const method of [
      'resources/list',
      'resources/templates/list',
      'resources/read',
      'prompts/list',
      'prompts/get',
    ]) {
      const response = await call(server, { jsonrpc: '2.0', id: 1, method });
      expect((response!.error as { code: number }).code).toBe(-32601);
    }
  });
});

describe('toContentBlocks', () => {
  it('wraps a string', () => {
    expect(toContentBlocks('hi')).toEqual([{ type: 'text', text: 'hi' }]);
  });
  it('passes through pre-shaped text blocks', () => {
    const blocks = [{ type: 'text', text: 'a' }];
    expect(toContentBlocks(blocks)).toBe(blocks);
  });
  it('stringifies objects', () => {
    expect(toContentBlocks({ a: 1 })).toEqual([{ type: 'text', text: '{"a":1}' }]);
  });
  it('handles null/undefined', () => {
    expect(toContentBlocks(undefined)).toEqual([{ type: 'text', text: '' }]);
  });

  it('handles null content', () => {
    expect(toContentBlocks(null)).toEqual([{ type: 'text', text: '' }]);
  });

  it('joins non-block array items with newlines', () => {
    expect(toContentBlocks([{ not: 'text' }, 'string-item'])).toEqual([
      { type: 'text', text: '{"not":"text"}\nstring-item' },
    ]);
  });

  it('stringifies circular values through their safe fallback', () => {
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    expect(toContentBlocks(circular)).toEqual([{ type: 'text', text: '[object Object]' }]);
    expect(toContentBlocks([])).toEqual([]);
  });
});

describe('serveStdio', () => {
  it('can attach to and immediately detach from the default process streams', async () => {
    const handle = serveStdio(new MCPServer({ host: makeHost() }));
    handle.close();
    handle.close();
    await handle.done;
  });

  it('reads newline-delimited requests and writes responses', async () => {
    const stdin = new PassThrough();
    const stdout = new PassThrough();
    const server = new MCPServer({ host: makeHost() });
    const handle = serveStdio(server, { stdin, stdout });

    const lines: string[] = [];
    stdout.on('data', (c: Buffer) => {
      for (const l of c.toString('utf8').split('\n')) if (l.trim()) lines.push(l);
    });

    stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' })}\n`);
    // notification — should produce no output
    stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`);
    stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'ping' })}\n`);

    await vi.waitFor(() => expect(lines.length).toBe(2));
    handle.close();
    await handle.done;

    const ids = lines.map((l) => (JSON.parse(l) as { id: number }).id).sort();
    expect(ids).toEqual([1, 2]);
  });

  it('resolves done on stdin end', async () => {
    const stdin = new PassThrough();
    const stdout = new PassThrough();
    const handle = serveStdio(new MCPServer({ host: makeHost() }), { stdin, stdout });
    stdin.end();
    await expect(handle.done).resolves.toBeUndefined();
  });

  it('done waits for in-flight writes to drain before resolving', async () => {
    // Hosts that simulate async work ensure a real response is queued in
    // writeChain when stdin ends. done must NOT resolve before that write
    // lands on stdout — otherwise callers that `await handle.done` could
    // close the process while the last response line is still buffered.
    const stdin = new PassThrough();
    const stdout = new PassThrough();
    let responseArrived = false;
    const sawResponseLine = new Promise<void>((resolve) => {
      stdout.on('data', (c: Buffer) => {
        for (const l of c.toString('utf8').split('\n')) {
          if (!l.trim()) continue;
          responseArrived = true;
          resolve();
        }
      });
    });
    const host: MCPServerToolHost = {
      listTools: () => [],
      callTool: async () => {
        // Yield to the event loop so we deterministically schedule a write
        // *after* the next stdin 'end' event.
        await new Promise((r) => setTimeout(r, 5));
        return { content: 'late', isError: false };
      },
    };
    const handle = serveStdio(new MCPServer({ host }), { stdin, stdout });
    stdin.write(
      `${JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'any' } })}\n`,
    );
    stdin.end();
    await expect(handle.done).resolves.toBeUndefined();
    expect(responseArrived).toBe(true);
    await expect(sawResponseLine).resolves.toBeUndefined();
  });

  it('aborts when a single line exceeds the buffer cap (no newline)', async () => {
    // A misbehaving peer that streams bytes forever without `\n` would
    // otherwise balloon the line buffer. The server must detect the cap,
    // drop the unread tail, and resolve `done` cleanly.
    const stdin = new PassThrough();
    const stdout = new PassThrough();
    const handle = serveStdio(new MCPServer({ host: makeHost() }), { stdin, stdout });
    // 5 MB of 'a' with no newline. The internal cap is 4 MiB.
    stdin.write('a'.repeat(5 * 1024 * 1024));
    stdin.end();
    await expect(handle.done).resolves.toBeUndefined();
  });

  it('logs rejected message handlers and continues', async () => {
    const stdin = new PassThrough();
    const stdout = new PassThrough();
    const server = new MCPServer({ host: makeHost() });
    vi.spyOn(server, 'handleMessage').mockRejectedValue(new Error('handler failed'));
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    const handle = serveStdio(server, { stdin, stdout });
    stdin.end('{"jsonrpc":"2.0","id":1,"method":"ping"}\n');

    await vi.waitFor(() =>
      expect(consoleError).toHaveBeenCalledWith(expect.stringContaining('handle_message_failed')),
    );
    await handle.done;
  });

  it('logs stdout write failures', async () => {
    const stdin = new PassThrough();
    const stdout = new PassThrough();
    vi.spyOn(stdout, 'write').mockImplementation(() => {
      throw new Error('write failed');
    });
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    const handle = serveStdio(new MCPServer({ host: makeHost() }), { stdin, stdout });
    stdin.end('{"jsonrpc":"2.0","id":1,"method":"ping"}\n');

    await vi.waitFor(() =>
      expect(consoleError).toHaveBeenCalledWith(expect.stringContaining('stdout_write_failed')),
    );
    await handle.done;
  });

  it('ignores stream teardown failures after buffer overflow', async () => {
    const stdin = new PassThrough();
    const stdout = new PassThrough();
    vi.spyOn(stdin, 'pause').mockImplementation(() => {
      throw new Error('pause failed');
    });
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const handle = serveStdio(new MCPServer({ host: makeHost() }), { stdin, stdout });
    const onData = stdin.listeners('data')[0] as (chunk: Buffer | string) => void;
    onData('a'.repeat(5 * 1024 * 1024));
    onData('ignored after overflow');
    await expect(handle.done).resolves.toBeUndefined();
  });

  it('skips blank stdio lines', async () => {
    const stdin = new PassThrough();
    stdin.setEncoding('utf8');
    const stdout = new PassThrough();
    const handle = serveStdio(new MCPServer({ host: makeHost() }), { stdin, stdout });
    stdin.end('\n   \n');
    await handle.done;
  });

  it('supports readable streams without resume()', async () => {
    const stdin = new EventEmitter() as never as NodeJS.ReadableStream;
    const handle = serveStdio(new MCPServer({ host: makeHost() }), {
      stdin,
      stdout: new PassThrough(),
    });
    handle.close();
    await handle.done;
  });
});

describe('serveHttp', () => {
  it('serves JSON-RPC over POST on an ephemeral loopback port', async () => {
    const handle = await serveHttp(new MCPServer({ host: makeHost() }), { port: 0 });
    try {
      const r = await fetch(handle.url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
      });
      expect(r.status).toBe(200);
      const body = (await r.json()) as { result: { tools: unknown[] } };
      expect(body.result.tools).toHaveLength(1);
    } finally {
      await handle.close();
    }
  });

  it('answers a GET health probe', async () => {
    const handle = await serveHttp(new MCPServer({ host: makeHost() }), { port: 0 });
    try {
      const r = await fetch(handle.url);
      expect(r.status).toBe(200);
      expect(((await r.json()) as { status: string }).status).toBe('ok');
    } finally {
      await handle.close();
    }
  });

  it('returns 202 (no body) for notifications', async () => {
    const handle = await serveHttp(new MCPServer({ host: makeHost() }), { port: 0 });
    try {
      const r = await fetch(handle.url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }),
      });
      expect(r.status).toBe(202);
    } finally {
      await handle.close();
    }
  });

  it('enforces bearer token when configured', async () => {
    const handle = await serveHttp(new MCPServer({ host: makeHost() }), {
      port: 0,
      token: 'secret',
    });
    try {
      const unauth = await fetch(handle.url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'ping' }),
      });
      expect(unauth.status).toBe(401);
      const ok = await fetch(handle.url, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: 'Bearer secret' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'ping' }),
      });
      expect(ok.status).toBe(200);
    } finally {
      await handle.close();
    }
  });

  it('refuses to bind a non-loopback host without a token', async () => {
    await expect(
      serveHttp(new MCPServer({ host: makeHost() }), { host: '0.0.0.0' }),
    ).rejects.toThrow(/non-loopback/);
  });

  it('returns 405 for non-POST and non-GET requests', async () => {
    const handle = await serveHttp(new MCPServer({ host: makeHost() }), { port: 0 });
    try {
      const r = await fetch(handle.url, {
        method: 'PUT',
      });
      expect(r.status).toBe(405);
      const body = (await r.json()) as { error: string };
      expect(body.error).toBe('method not allowed');
    } finally {
      await handle.close();
    }
  });

  it('rejects payloads larger than the HTTP body cap', async () => {
    const handle = await serveHttp(new MCPServer({ host: makeHost() }), { port: 0 });
    try {
      const outcome = await fetch(handle.url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: 'x'.repeat(5 * 1024 * 1024),
      }).catch((error: unknown) => error);
      if (outcome instanceof Response) expect(outcome.status).toBe(413);
      else expect(outcome).toBeInstanceOf(Error);
    } finally {
      await handle.close();
    }
  });

  it('returns 500 and logs when the protocol handler rejects', async () => {
    const server = new MCPServer({ host: makeHost() });
    vi.spyOn(server, 'handleMessage').mockRejectedValue(new Error('handler failed'));
    const warn = vi.fn();
    const handle = await serveHttp(server, { port: 0, logger: { warn } });
    try {
      const response = await fetch(handle.url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: '{}',
      });
      expect(response.status).toBe(500);
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('handler failed'));
    } finally {
      await handle.close();
    }
  });

  it('rejects when the requested port is already occupied', async () => {
    const occupied = createServer();
    await new Promise<void>((resolve) => occupied.listen(0, '127.0.0.1', resolve));
    const address = occupied.address();
    if (!address || typeof address === 'string') throw new Error('fixture did not bind');
    try {
      await expect(
        serveHttp(new MCPServer({ host: makeHost() }), {
          host: '127.0.0.1',
          port: address.port,
        }),
      ).rejects.toThrow();
    } finally {
      await new Promise<void>((resolve) => occupied.close(() => resolve()));
    }
  });

  it('formats an IPv6 loopback URL', async () => {
    const handle = await serveHttp(new MCPServer({ host: makeHost() }), {
      host: '::1',
      port: 0,
    });
    try {
      expect(handle.url).toContain('http://[::1]:');
    } finally {
      await handle.close();
    }
  });
});
