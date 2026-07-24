import { EventEmitter } from 'node:events';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { forceKillTree, MCPClient, type MCPTool } from '../src/client.js';
import { SSETransport, StreamableHTTPTransport } from '../src/transport.js';

afterEach(() => {
  vi.restoreAllMocks();
});

const METADATA = {
  protocolVersion: '2025-06-18',
  capabilities: { tools: {}, resources: { subscribe: true }, prompts: {} },
  serverInfo: { name: 'fixture', version: '1.0.0' },
};

describe('MCPClient coverage', () => {
  it('returns defensive metadata snapshots and delegates active transports', async () => {
    const client = new MCPClient({ name: 'client', transport: 'stdio', command: 'noop' });
    expect(client.getServerMetadata()).toBeUndefined();
    const internals = client as never as {
      state: 'connected';
      _serverMetadata: typeof METADATA;
      sseTransport: {
        callTool: (name: string, input: unknown) => Promise<unknown>;
        request: (method: string, params: unknown) => Promise<unknown>;
      };
      request: (method: string, params: unknown) => Promise<unknown>;
    };
    internals.state = 'connected';
    internals._serverMetadata = METADATA;
    const first = client.getServerMetadata();
    const second = client.getServerMetadata();
    expect(first).toEqual(second);
    expect(first).not.toBe(second);
    expect(first?.capabilities).not.toBe(second?.capabilities);
    internals.sseTransport = {
      callTool: vi.fn(async () => ({ content: 'sse', isError: false })),
      request: vi.fn(async () => ({ jsonrpc: '2.0', id: 1, result: {} })),
    };
    await expect(client.callTool('one', {})).resolves.toMatchObject({ content: 'sse' });
    await expect(internals.request('ping', {})).resolves.toMatchObject({ result: {} });

    internals.sseTransport = undefined as never;
    (internals as never as { httpTransport: typeof internals.sseTransport }).httpTransport = {
      callTool: vi.fn(async () => ({ content: 'http', isError: false })),
      request: vi.fn(async () => ({ jsonrpc: '2.0', id: 2, result: {} })),
    };
    await expect(client.callTool('two', {})).resolves.toMatchObject({ content: 'http' });
    await expect(internals.request('ping', {})).resolves.toMatchObject({ result: {} });
  });

  it('covers successful SSE transport callbacks', async () => {
    let disconnect: (() => void) | undefined;
    let toolsChanged: ((tools: MCPTool[]) => void) | undefined;
    let resourcesChanged: (() => void) | undefined;
    let promptsChanged: (() => void) | undefined;
    vi.spyOn(SSETransport.prototype, 'connect').mockResolvedValue();
    vi.spyOn(SSETransport.prototype, 'listTools').mockReturnValue([
      { name: 'initial', inputSchema: {} },
    ]);
    vi.spyOn(SSETransport.prototype, 'getServerMetadata').mockReturnValue(METADATA);
    vi.spyOn(SSETransport.prototype, 'onDisconnect').mockImplementation((cb) => {
      disconnect = cb;
      return () => {};
    });
    vi.spyOn(SSETransport.prototype, 'onToolsChanged').mockImplementation((cb) => {
      toolsChanged = cb;
      return () => {};
    });
    vi.spyOn(SSETransport.prototype, 'onResourcesChanged').mockImplementation((cb) => {
      resourcesChanged = cb;
      return () => {};
    });
    vi.spyOn(SSETransport.prototype, 'onPromptsChanged').mockImplementation((cb) => {
      promptsChanged = cb;
      return () => {};
    });
    const client = new MCPClient({
      name: 'sse',
      transport: 'sse',
      url: 'https://example.test',
    });
    const disconnected = vi.fn();
    const tools = vi.fn();
    const resources = vi.fn();
    const prompts = vi.fn();
    const throwing = () => {
      throw new Error('listener failed');
    };
    client.addDisconnectListener(disconnected);
    client.addDisconnectListener(throwing);
    client.addToolsChangedListener(tools);
    client.addToolsChangedListener(throwing);
    client.addResourcesChangedListener(resources);
    client.addResourcesChangedListener(throwing);
    client.addPromptsChangedListener(prompts);
    client.addPromptsChangedListener(throwing);

    await client.connect();
    expect(client.listTools()).toHaveLength(1);
    toolsChanged?.([{ name: 'updated', inputSchema: {} }]);
    resourcesChanged?.();
    promptsChanged?.();
    disconnect?.();
    expect(tools).toHaveBeenCalledOnce();
    expect(resources).toHaveBeenCalledOnce();
    expect(prompts).toHaveBeenCalledOnce();
    expect(disconnected).toHaveBeenCalledOnce();
    expect(client.getState()).toBe('disconnected');
  });

  it('covers successful streamable HTTP transport callbacks', async () => {
    let disconnect: (() => void) | undefined;
    let toolsChanged: ((tools: MCPTool[]) => void) | undefined;
    let resourcesChanged: (() => void) | undefined;
    let promptsChanged: (() => void) | undefined;
    vi.spyOn(StreamableHTTPTransport.prototype, 'connect').mockResolvedValue();
    vi.spyOn(StreamableHTTPTransport.prototype, 'listTools').mockReturnValue([]);
    vi.spyOn(StreamableHTTPTransport.prototype, 'getServerMetadata').mockReturnValue(METADATA);
    vi.spyOn(StreamableHTTPTransport.prototype, 'onDisconnect').mockImplementation((cb) => {
      disconnect = cb;
      return () => {};
    });
    vi.spyOn(StreamableHTTPTransport.prototype, 'onToolsChanged').mockImplementation((cb) => {
      toolsChanged = cb;
      return () => {};
    });
    vi.spyOn(StreamableHTTPTransport.prototype, 'onResourcesChanged').mockImplementation((cb) => {
      resourcesChanged = cb;
      return () => {};
    });
    vi.spyOn(StreamableHTTPTransport.prototype, 'onPromptsChanged').mockImplementation((cb) => {
      promptsChanged = cb;
      return () => {};
    });
    const client = new MCPClient({
      name: 'http',
      transport: 'streamable-http',
      url: 'https://example.test',
    });
    const disconnected = vi.fn();
    const tools = vi.fn();
    const resources = vi.fn();
    const prompts = vi.fn();
    const throwing = () => {
      throw new Error('listener failed');
    };
    client.addDisconnectListener(disconnected);
    client.addDisconnectListener(throwing);
    client.addToolsChangedListener(tools);
    client.addToolsChangedListener(throwing);
    client.addResourcesChangedListener(resources);
    client.addResourcesChangedListener(throwing);
    client.addPromptsChangedListener(prompts);
    client.addPromptsChangedListener(throwing);

    await client.connect();
    toolsChanged?.([{ name: 'updated', inputSchema: {} }]);
    resourcesChanged?.();
    promptsChanged?.();
    disconnect?.();
    expect(tools).toHaveBeenCalledOnce();
    expect(resources).toHaveBeenCalledOnce();
    expect(prompts).toHaveBeenCalledOnce();
    expect(disconnected).toHaveBeenCalledOnce();
  });

  it('tolerates transport cleanup rejection after failed connects', async () => {
    vi.spyOn(SSETransport.prototype, 'connect').mockRejectedValue(new Error('connect failed'));
    vi.spyOn(SSETransport.prototype, 'close').mockRejectedValue(new Error('close failed'));
    await expect(
      new MCPClient({
        name: 'sse',
        transport: 'sse',
        url: 'https://example.test',
      }).connect(),
    ).rejects.toThrow(/connect failed/);
    vi.restoreAllMocks();

    vi.spyOn(StreamableHTTPTransport.prototype, 'connect').mockRejectedValue(
      new Error('connect failed'),
    );
    vi.spyOn(StreamableHTTPTransport.prototype, 'close').mockRejectedValue(
      new Error('close failed'),
    );
    await expect(
      new MCPClient({
        name: 'http',
        transport: 'streamable-http',
        url: 'https://example.test',
      }).connect(),
    ).rejects.toThrow(/connect failed/);
  });

  it('normalizes stdio tool errors and empty results', async () => {
    const client = new MCPClient({ name: 'stdio', transport: 'stdio', command: 'noop' });
    const internals = client as never as {
      state: 'connected';
      request: (method: string, params: unknown) => Promise<unknown>;
    };
    internals.state = 'connected';
    vi.spyOn(internals, 'request')
      .mockResolvedValueOnce({
        jsonrpc: '2.0',
        id: 1,
        error: { code: 1, message: 'failed' },
      })
      .mockResolvedValueOnce({ jsonrpc: '2.0', id: 2 });
    await expect(client.callTool('failed', {})).resolves.toEqual({
      content: 'failed',
      isError: true,
    });
    await expect(client.callTool('empty', {})).resolves.toEqual({
      content: '',
      isError: false,
    });
  });

  it('covers capability state, metadata, validation, and empty-result errors', async () => {
    const client = new MCPClient({ name: 'client', transport: 'stdio', command: 'noop' });
    await expect(client.listResources()).rejects.toThrow(/not connected/);
    await expect(client.subscribeResource('mem://one')).rejects.toThrow(/not connected/);
    const internals = client as never as {
      state: 'connected';
      _serverMetadata?: typeof METADATA;
      request: (method: string, params: unknown) => Promise<unknown>;
    };
    internals.state = 'connected';
    await expect(client.listResources()).rejects.toThrow(/metadata is unavailable/);
    internals._serverMetadata = METADATA;
    await expect(
      client.getPrompt(
        'prompt',
        Object.fromEntries(Array.from({ length: 65 }, (_, index) => [`key-${index}`, 'value'])),
      ),
    ).rejects.toThrow(/exceed the limit/);
    vi.spyOn(internals, 'request').mockResolvedValue({
      jsonrpc: '2.0',
      id: 1,
      result: [],
    });
    await expect(client.subscribeResource('mem://one')).rejects.toThrow(/expected object/);
  });

  it('covers strict stdio response validation and notification guards', () => {
    const client = new MCPClient({ name: 'client', transport: 'stdio', command: 'noop' });
    const onLine = (
      client as never as {
        onLine: (line: string) => void;
      }
    ).onLine.bind(client);
    for (const value of [
      null,
      1,
      {},
      { jsonrpc: '1.0', id: 1, result: true },
      { jsonrpc: '2.0', id: 1 },
      { jsonrpc: '2.0', id: 1, result: true, error: { code: 1, message: 'x' } },
      { jsonrpc: '2.0', id: 1, error: null },
      { jsonrpc: '2.0', id: 1, error: 'bad' },
      { jsonrpc: '2.0', id: 1, error: { code: '1', message: 'bad' } },
      { jsonrpc: '2.0', id: 1, error: { code: 1, message: 2 } },
      { jsonrpc: '2.0', id: null, method: 'ignored' },
    ]) {
      onLine(JSON.stringify(value));
    }
    onLine('{invalid');
  });

  it('closes on an oversized receive buffer', async () => {
    const client = new MCPClient({ name: 'client', transport: 'stdio', command: 'noop' });
    const close = vi.spyOn(client, 'close');
    (
      client as never as {
        onData: (chunk: string) => void;
      }
    ).onData('x'.repeat(16 * 1024 * 1024 + 1));
    expect(close).toHaveBeenCalledOnce();
  });

  it('resolves drain backpressure and clears listeners', async () => {
    const client = new MCPClient({ name: 'client', transport: 'stdio', command: 'noop' });
    let drain: (() => void) | undefined;
    const removeListener = vi.fn();
    (client as never as { child: unknown }).child = {
      stdin: {
        write: () => false,
        once: (event: string, cb: () => void) => {
          if (event === 'drain') drain = cb;
        },
        removeListener,
      },
    };
    const notify = (
      client as never as {
        notify: (method: string, params: unknown) => Promise<void>;
      }
    ).notify('notifications/test', {});
    drain?.();
    await expect(notify).resolves.toBeUndefined();
    expect(removeListener).toHaveBeenCalled();
  });

  it('covers stdio initialization warnings, passthrough environment, and child errors', async () => {
    const existingName = 'WRONGSTACK_CLIENT_COVERAGE_ENV';
    process.env[existingName] = 'forwarded';
    const client = new MCPClient({
      name: 'stdio',
      transport: 'stdio',
      command: process.execPath,
      args: ['-e', 'process.stdin.resume()'],
      passthroughEnv: [existingName, 'WRONGSTACK_CLIENT_COVERAGE_MISSING'],
    });
    const internals = client as never as {
      request: (method: string, params: unknown) => Promise<unknown>;
      notify: (method: string, params: unknown) => Promise<void>;
      failPending: (reason: string) => void;
      child: {
        stdin?: { emit: (event: string, error: Error) => void };
        emit: (event: string, error: Error) => void;
      };
    };
    vi.spyOn(internals, 'request')
      .mockResolvedValueOnce({ jsonrpc: '2.0', id: 1, result: METADATA })
      .mockResolvedValueOnce({
        jsonrpc: '2.0',
        id: 2,
        error: { code: 1, message: 'tools unavailable' },
      });
    vi.spyOn(internals, 'notify').mockRejectedValue(new Error('notification failed'));
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const failPending = vi.spyOn(internals, 'failPending');

    try {
      await client.connect();
      expect(client.listTools()).toEqual([]);
      expect(warn).toHaveBeenCalled();
      internals.child.stdin?.emit('error', new Error('stdin failed'));
      internals.child.emit('error', new Error('child failed'));
      expect(failPending).toHaveBeenCalledWith(expect.stringContaining('stdin failed'));
      expect(failPending).toHaveBeenCalledWith(expect.stringContaining('child failed'));
    } finally {
      delete process.env[existingName];
      await client.close();
    }
  });

  it('rejects stdio initialize errors and malformed metadata', async () => {
    const create = () =>
      new MCPClient({
        name: 'stdio',
        transport: 'stdio',
        command: process.execPath,
        args: ['-e', 'process.stdin.resume()'],
      });

    const initializeError = create();
    vi.spyOn(
      initializeError as never as {
        request: (method: string, params: unknown) => Promise<unknown>;
      },
      'request',
    ).mockResolvedValue({
      jsonrpc: '2.0',
      id: 1,
      error: { code: 1, message: 'rejected' },
    });
    await expect(initializeError.connect()).rejects.toThrow(/initialize failed/);
    await initializeError.close();

    const malformed = create();
    vi.spyOn(
      malformed as never as {
        request: (method: string, params: unknown) => Promise<unknown>;
      },
      'request',
    ).mockResolvedValue({ jsonrpc: '2.0', id: 1, result: {} });
    await expect(malformed.connect()).rejects.toThrow(/malformed server metadata/);
    await malformed.close();
  });

  it('tolerates failed cancellation notifications', async () => {
    const client = new MCPClient({ name: 'client', transport: 'stdio', command: 'noop' });
    const internals = client as never as {
      child: { stdin: { destroyed: boolean; write: () => boolean } };
      request: (
        method: string,
        params: unknown,
        timeout: number,
        opts: { signal: AbortSignal },
      ) => Promise<unknown>;
      notify: (method: string, params: unknown) => Promise<void>;
    };
    internals.child = { stdin: { destroyed: false, write: () => true } };
    vi.spyOn(internals, 'notify').mockRejectedValue(new Error('notify failed'));
    const controller = new AbortController();
    const pending = internals.request('tools/call', {}, 10_000, {
      signal: controller.signal,
    });
    controller.abort();
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    await vi.waitFor(() => expect(internals.notify).toHaveBeenCalled());
  });

  it('handles missing pending entries in stdin failure guards', async () => {
    const client = new MCPClient({ name: 'client', transport: 'stdio', command: 'noop' });
    const internals = client as never as {
      pending: Map<number, unknown>;
      child: { stdin: { destroyed: boolean; write?: () => boolean } };
      request: (method: string, params: unknown, timeout: number) => Promise<unknown>;
    };
    internals.child = {
      stdin: {
        get destroyed() {
          internals.pending.clear();
          return true;
        },
      },
    };
    await expect(internals.request('one', {}, 10_000)).rejects.toThrow(/stdin not writable/);

    internals.child = {
      stdin: {
        destroyed: false,
        write: () => {
          internals.pending.clear();
          throw new Error('write failed');
        },
      },
    };
    await expect(internals.request('two', {}, 10_000)).rejects.toThrow(/write failed/);
  });

  it('ignores blank lines, unknown notifications, and unmatched responses', () => {
    const client = new MCPClient({ name: 'client', transport: 'stdio', command: 'noop' });
    const internals = client as never as {
      onData: (data: string) => void;
      onLine: (line: string) => void;
    };
    internals.onData('\n');
    internals.onLine('{"jsonrpc":"2.0","method":"notifications/unknown"}');
    internals.onLine('{"jsonrpc":"2.0","method":"notifications/prompts/list_changed"}');
    internals.onLine('{"jsonrpc":"2.0","id":999,"result":{}}');
  });

  it('handles abort after a pending entry was externally cleared', async () => {
    const client = new MCPClient({ name: 'client', transport: 'stdio', command: 'noop' });
    const internals = client as never as {
      child: { stdin: { destroyed: boolean; write: () => boolean } };
      pending: Map<number, unknown>;
      request: (
        method: string,
        params: unknown,
        timeout: number,
        opts: { signal: AbortSignal },
      ) => Promise<unknown>;
    };
    internals.child = { stdin: { destroyed: false, write: () => true } };
    const controller = new AbortController();
    const pending = internals.request('tools/call', {}, 10_000, {
      signal: controller.signal,
    });
    internals.pending.clear();
    controller.abort();
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
  });

  it('covers POSIX stdio spawning', async () => {
    const originalPlatform = process.platform;
    Object.defineProperty(process, 'platform', { value: 'linux' });
    const client = new MCPClient({
      name: 'stdio-posix',
      transport: 'stdio',
      command: process.execPath,
      args: ['-e', 'process.stdin.resume()'],
    });
    const internals = client as never as {
      request: (method: string, params: unknown) => Promise<unknown>;
      notify: (method: string, params: unknown) => Promise<void>;
    };
    vi.spyOn(internals, 'request')
      .mockResolvedValueOnce({ jsonrpc: '2.0', id: 1, result: METADATA })
      .mockResolvedValueOnce({ jsonrpc: '2.0', id: 2, result: { tools: [] } });
    vi.spyOn(internals, 'notify').mockResolvedValue();
    try {
      await client.connect();
      expect(client.getState()).toBe('connected');
    } finally {
      await client.close();
      Object.defineProperty(process, 'platform', { value: originalPlatform });
    }
  });

  it('force-kills children across platform and fallback paths', async () => {
    const makeChild = (pid: number | undefined, kill: () => boolean) =>
      Object.assign(new EventEmitter(), {
        pid,
        kill: vi.fn(kill),
      });
    forceKillTree(makeChild(undefined, () => true) as never);
    forceKillTree(
      makeChild(undefined, () => {
        throw new Error('gone');
      }) as never,
    );

    const originalPlatform = process.platform;
    Object.defineProperty(process, 'platform', { value: 'linux' });
    forceKillTree(makeChild(123, () => true) as never);
    forceKillTree(
      makeChild(123, () => {
        throw new Error('gone');
      }) as never,
    );

    Object.defineProperty(process, 'platform', { value: 'win32' });
    const originalPath = process.env['PATH'];
    process.env['PATH'] = '';
    const windowsChild = makeChild(999_999, () => true);
    forceKillTree(windowsChild as never);
    await vi.waitFor(() => expect(windowsChild.kill).toHaveBeenCalledWith('SIGKILL'));
    const throwingWindowsChild = makeChild(999_998, () => {
      throw new Error('gone');
    });
    forceKillTree(throwingWindowsChild as never);
    await vi.waitFor(() => expect(throwingWindowsChild.kill).toHaveBeenCalledWith('SIGKILL'));
    if (originalPath === undefined) delete process.env['PATH'];
    else process.env['PATH'] = originalPath;
    Object.defineProperty(process, 'platform', { value: originalPlatform });
  });
});
