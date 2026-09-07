import { EventEmitter } from 'node:events';
import * as fs from 'node:fs/promises';
import { PassThrough } from 'node:stream';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  parseAuthorizationServerMetadata,
  validateMcpAuthorizationServerMetadata,
} from '../src/authorization.js';
import { MCPAuthorizationManager } from '../src/authorization-manager.js';
import { MCPClient } from '../src/client.js';
import { disableMcp, enableMcp, restartMcp, updateMcp } from '../src/manage.js';
import { manifestConfigHash } from '../src/manifest-cache.js';
import { markLazySlotDormant } from '../src/registry-disconnect.js';
import { sleepIdleSlot, sweepIdleSlots } from '../src/registry-idle.js';
import { handleHttpRequest, MCPServer, serveHttp, serveStdio } from '../src/server.js';
import { MCPRefreshingAuthorizationProvider } from '../src/token-store.js';
import { classifyTransportAddress, transportPinnedLookup } from '../src/transport-security.js';
import { SSETransport } from '../src/transport-sse.js';
import { StreamableHTTPTransport } from '../src/transport-streamable.js';
import { wrapMCPTool } from '../src/wrap-tool.js';

describe('mcp 100% coverage suite', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('covers authorization-manager activeAuthorizationCount starting key in and not in pending', async () => {
    const mgr = new MCPAuthorizationManager({
      maxActiveAuthorizations: 5,
    } as any);
    (mgr as any).pending.set('server1\0res1', {
      serverName: 'server1',
      resource: 'res1',
      expiresAt: Date.now() + 10000,
      tokenSet: { accessToken: 'a' },
    });
    // Add key to starting that IS in pending (false branch of line 243)
    (mgr as any).starting.set('server1\0res1', Promise.resolve());
    // Add key to starting that is NOT in pending (true branch of line 243)
    (mgr as any).starting.set('server2\0res2', Promise.resolve());
    const count = (mgr as any).activeAuthorizationCount();
    expect(count).toBe(2);
  });

  it('covers authorization.ts cross-origin endpoints without issuer parameter support', () => {
    // 1. parseAuthorizationServerMetadata cross-origin
    expect(() =>
      parseAuthorizationServerMetadata(
        {
          issuer: 'https://auth.example.com',
          authorization_endpoint: 'https://cross.example.com/oauth/authorize',
          token_endpoint: 'https://auth.example.com/token',
          code_challenge_methods_supported: ['S256'],
        },
        'https://auth.example.com',
      ),
    ).toThrow(/cross-origin endpoints must support the authorization response issuer parameter/);

    // 2. validateMcpAuthorizationServerMetadata line 329
    expect(() =>
      validateMcpAuthorizationServerMetadata({
        issuer: 'https://auth.example.com',
        authorizationEndpoint: 'https://cross.example.com/oauth/authorize',
        tokenEndpoint: 'https://auth.example.com/token',
      }),
    ).toThrow(/cross-origin endpoints must support the authorization response issuer parameter/);
  });

  it('covers client.ts stdout end with rxBuffer, and notify on destroyed/unwritable stdin', async () => {
    const client = new MCPClient({
      name: 'stdio-test',
      transport: 'stdio',
      command: process.execPath,
      args: ['-e', 'process.stdin.resume()'],
    });
    const internals = client as never as {
      request: (method: string, params: unknown) => Promise<unknown>;
      notify: (method: string, params: unknown) => Promise<void>;
      rxBuffer: string;
      onLine: (line: string) => void;
      child: { stdout: EventEmitter; stdin: { destroyed: boolean; writable: boolean } };
    };
    vi.spyOn(internals, 'request')
      .mockResolvedValueOnce({
        jsonrpc: '2.0',
        id: 1,
        result: {
          protocolVersion: '2025-06-18',
          capabilities: { tools: {} },
          serverInfo: { name: 'test', version: '1.0' },
        },
      })
      .mockResolvedValueOnce({ jsonrpc: '2.0', id: 2, result: { tools: [] } });
    vi.spyOn(internals, 'notify').mockResolvedValue();

    try {
      await client.connect();
      let handledLine = '';
      internals.onLine = (line: string) => {
        handledLine = line;
      };
      internals.rxBuffer = '{"jsonrpc":"2.0","result":"buffered"}';
      internals.child.stdout.emit('end');
      expect(handledLine).toBe('{"jsonrpc":"2.0","result":"buffered"}');

      // 2. notify() with destroyed stdin
      const realStdin = internals.child.stdin;
      internals.child.stdin = { destroyed: true, writable: false, destroy: () => {} } as any;
      await expect((client as any).notify('test/method', {})).resolves.toBeUndefined();

      // 3. notify() with writable === false
      internals.child.stdin = { destroyed: false, writable: false, destroy: () => {} } as any;
      await expect((client as any).notify('test/method', {})).resolves.toBeUndefined();
      internals.child.stdin = realStdin;
    } finally {
      await client.close().catch(() => {});
    }

    // 4. notify() when child is undefined (!stdin)
    const noChildClient = new MCPClient({ name: 'no-child', transport: 'stdio', command: 'node' });
    await expect((noChildClient as any).notify('test/method', {})).resolves.toBeUndefined();

    // 5. onData without newline (false branch of line 910 if (start > 0))
    (client as any).rxBuffer = '';
    (client as any).rxBufferBytes = 0;
    (client as any).onData('no-newline-chunk');
    expect((client as any).rxBuffer).toBe('no-newline-chunk');

    // 6. concurrent close() calls (line 594 if (this.closePromise) return this.closePromise)
    const clientForClose = new MCPClient({
      name: 'close-test',
      transport: 'stdio',
      command: 'node',
    });
    const [c1, c2] = await Promise.all([clientForClose.close(), clientForClose.close()]);
    expect(c1).toBeUndefined();
    expect(c2).toBeUndefined();

    // 7. connect failure with close rejecting (line 201 catch (() => {}))
    const failCloseClient = new MCPClient({
      name: 'fail-close',
      transport: 'stdio',
      command: 'node',
    });
    vi.spyOn(failCloseClient as any, 'connectStdio').mockRejectedValue(new Error('connect failed'));
    vi.spyOn(failCloseClient, 'close').mockRejectedValue(new Error('close failed'));
    await expect(failCloseClient.connect()).rejects.toThrow('connect failed');
  });

  it('covers manage.ts enableMcp, updateMcp, disableMcp, restartMcp when server is undefined/null in config', async () => {
    const os = await import('node:os');
    const path = await import('node:path');
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'mcp-manage-test-'));
    const configPath = path.join(tempDir, 'config.json');
    try {
      await fs.writeFile(
        configPath,
        JSON.stringify({
          mcpServers: {
            'server-null': null,
          },
        }),
        'utf8',
      );

      const fakeDeps = {
        configPath,
        registry: {
          list: vi.fn().mockReturnValue([]),
          update: vi.fn(),
          stop: vi.fn(),
        } as any,
      };
      const resEnable = await enableMcp('server-null', fakeDeps as any);
      expect(resEnable.ok).toBe(false);

      const resUpdate = await updateMcp(
        { name: 'server-null', allowPrivateNetworks: true },
        fakeDeps as any,
      );
      expect(resUpdate.ok).toBe(false);

      const resDisable = await disableMcp('server-null', fakeDeps as any);
      expect(resDisable.ok).toBe(false);

      const resRestart = await restartMcp('server-null', fakeDeps as any);
      expect(resRestart.ok).toBe(false);

      // Update existing server retaining base.allowPrivateNetworks
      await fs.writeFile(
        configPath,
        JSON.stringify({
          mcpServers: {
            'server-existing': {
              command: 'node',
              allowPrivateNetworks: true,
            },
          },
        }),
        'utf8',
      );
      const resUpdateExisting = await updateMcp(
        { name: 'server-existing', description: 'new desc' },
        fakeDeps as any,
      );
      expect(resUpdateExisting.ok).toBe(true);
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });

  it('covers manifest-cache.ts sortedEntries comparator and missing env var', () => {
    delete process.env['TEST_NONEXISTENT_VAR_XYZ_123'];
    const hash = manifestConfigHash({
      transport: 'stdio',
      headers: { b: '2', a: '1' },
      env: { b: '2', a: '1' },
      passthroughEnv: ['TEST_NONEXISTENT_VAR_XYZ_123'],
    });
    expect(hash).toBeDefined();
  });

  it('covers registry-disconnect.ts markLazySlotDormant branches', () => {
    const fakeEvents = { emit: vi.fn() };
    // 1. without client and timer
    const fakeSlot1: any = {
      cfg: { name: 's1' },
      client: undefined,
    };
    markLazySlotDormant(fakeSlot1, fakeEvents as any, 'test-disconnect');
    expect(fakeSlot1.reconnectTimer).toBeUndefined();
    expect(fakeSlot1.state).toBe('dormant');

    // 2. with reconnectTimer and onDisconnect
    const fakeClient = {
      removeDisconnectListener: vi.fn(),
      close: vi.fn().mockResolvedValue(undefined),
    };
    const onDisconnect = vi.fn();
    const fakeSlot2: any = {
      cfg: { name: 's2' },
      reconnectTimer: setTimeout(() => {}, 10000),
      onDisconnect,
      client: fakeClient,
    };
    markLazySlotDormant(fakeSlot2, fakeEvents as any, 'test-disconnect');
    expect(fakeSlot2.reconnectTimer).toBeUndefined();
    expect(fakeClient.removeDisconnectListener).toHaveBeenCalledWith(onDisconnect);

    // 3. with client close rejecting (line 49 catch (() => {}))
    const failingClient = {
      close: vi.fn().mockRejectedValue(new Error('close failed')),
    };
    const fakeSlot3: any = {
      cfg: { name: 's3' },
      client: failingClient,
    };
    markLazySlotDormant(fakeSlot3, fakeEvents as any, 'test-disconnect');
    expect(fakeSlot3.state).toBe('dormant');
  });

  it('covers registry-idle.ts sleepIdleSlot and sweepIdleSlots branches', async () => {
    const fakeSlot: any = {
      cfg: { name: 'idle-srv' },
      state: 'ready',
      client: {
        close: vi.fn(async () => {
          throw new Error('close failure');
        }),
      },
      operations: { inFlightCalls: 0, sleepCount: 0 },
    };
    const fakeCtx: any = {
      log: { warn: vi.fn(), info: vi.fn() },
      events: { emit: vi.fn() },
      recordOperation: vi.fn(),
      removeCatalogListeners: vi.fn(),
    };
    await sleepIdleSlot(fakeCtx, fakeSlot);
    expect(fakeCtx.log.warn).toHaveBeenCalledWith(
      expect.stringContaining('error during idle sleep close'),
      expect.any(Error),
    );
    expect(fakeSlot.state).toBe('dormant');

    // inFlightCalls > 0 returns early
    const busySlot: any = {
      cfg: { name: 'busy' },
      operations: { inFlightCalls: 1 },
    };
    await sleepIdleSlot(fakeCtx, busySlot);

    // sweepIdleSlots idleTimeoutMs <= 0
    expect(await sweepIdleSlots({ ...fakeCtx, idleTimeoutMs: 0, servers: new Map() })).toBe(false);

    // sweepIdleSlots returns true when a connected slot remains
    const readySlot: any = {
      lazy: true,
      state: 'connected',
      client: {},
      operations: { inFlightCalls: 0 },
      lastUsed: Date.now(),
    };
    const servers = new Map([['ready', readySlot]]);
    expect(await sweepIdleSlots({ ...fakeCtx, idleTimeoutMs: 60000, servers })).toBe(true);
  });

  it('covers server.ts serveStdio onEnd with trailing un-newline-terminated message', async () => {
    const server = new MCPServer({
      host: { listTools: () => [], callTool: async () => ({ content: '', isError: false }) },
      serverInfo: { name: 'test-srv', version: '1.0' },
    });
    const inStream = new PassThrough();
    const outStream = new PassThrough();

    let output = '';
    outStream.on('data', (chunk) => {
      output += chunk.toString();
    });

    const handle = serveStdio(server, { stdin: inStream, stdout: outStream });

    inStream.write('{"jsonrpc":"2.0","id":1,"method":"ping"}');
    inStream.end();

    await handle.done;
    expect(output).toContain('"result":{}');

    // CRLF input
    const inStreamCRLF = new PassThrough();
    const outStreamCRLF = new PassThrough();
    const handleCRLF = serveStdio(server, { stdin: inStreamCRLF, stdout: outStreamCRLF });
    inStreamCRLF.write('{"jsonrpc":"2.0","id":2,"method":"ping"}\r\n');
    inStreamCRLF.end();
    await handleCRLF.done;

    // trailing notification without newline (line 548 res === null)
    const inStreamNotif = new PassThrough();
    const outStreamNotif = new PassThrough();
    const handleNotif = serveStdio(server, { stdin: inStreamNotif, stdout: outStreamNotif });
    inStreamNotif.write('{"jsonrpc":"2.0","method":"notifications/initialized"}');
    inStreamNotif.end();
    await handleNotif.done;
  });

  it('covers server.ts serveStdio onEnd handleMessage rejection', async () => {
    const server = new MCPServer({
      host: { listTools: () => [], callTool: async () => ({ content: '', isError: false }) },
      serverInfo: { name: 'test-srv', version: '1.0' },
    });
    vi.spyOn(server, 'handleMessage').mockRejectedValueOnce(new Error('crash on line'));
    const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    const inStream = new PassThrough();
    const outStream = new PassThrough();
    const handle = serveStdio(server, { stdin: inStream, stdout: outStream });

    inStream.write('{"jsonrpc":"2.0","id":2,"method":"crash"}');
    inStream.end();

    await handle.done;
    expect(consoleErrorSpy).toHaveBeenCalled();
  });

  it('covers server.ts serveHttp error handling and aborted stream branches', async () => {
    const srv = new MCPServer({
      host: { listTools: () => [], callTool: async () => ({ content: '', isError: false }) },
      serverInfo: { name: 'test-srv', version: '1.0' },
    });
    vi.spyOn(srv, 'handleMessage').mockRejectedValue(new Error('crash in http'));
    const handle = await serveHttp(srv, { port: 0 });
    try {
      const res = await fetch(handle.url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: '{"jsonrpc":"2.0","id":1,"method":"crash"}',
      });
      expect(res.status).toBe(500);

      // Simulate request abortion on handleHttpRequest
      const fakeReq = new EventEmitter() as any;
      fakeReq.method = 'POST';
      fakeReq.headers = { 'content-type': 'application/json', host: '127.0.0.1' };
      fakeReq.destroy = vi.fn();
      const fakeRes = {
        writeHead: vi.fn(),
        end: vi.fn(),
        setHeader: vi.fn(),
      } as any;
      const p = handleHttpRequest(srv, fakeReq, fakeRes, undefined, undefined, '127.0.0.1');

      // 1. exceed 4MB
      fakeReq.emit('data', Buffer.alloc(4 * 1024 * 1024 + 10));
      // 2. data chunk after aborted (line 726 if (aborted) return)
      fakeReq.emit('data', Buffer.alloc(10));
      // 3. end event after aborted (line 736 if (aborted) return)
      fakeReq.emit('end');
      expect(fakeRes.writeHead).toHaveBeenCalledWith(413, expect.anything());
      await p;
    } finally {
      await handle.close();
    }
  });

  it('covers token-store.ts awaitWithAbort all abort and resolve branches', async () => {
    const value = {
      serverName: 's1',
      resource: 'https://mcp.example.com/mcp',
      clientId: 'c1',
      authorizationServer: {
        issuer: 'https://auth.example.com',
        authorizationEndpoint: 'https://auth.example.com/oauth/authorize',
        tokenEndpoint: 'https://auth.example.com/token',
      },
      tokenSet: { accessToken: 'old', refreshToken: 'ref', expiresAt: Date.now() - 1000 },
      updatedAt: new Date().toISOString(),
    };
    const store = {
      load: vi.fn().mockResolvedValue(value),
      save: vi.fn().mockResolvedValue(undefined),
    };

    const provider = new MCPRefreshingAuthorizationProvider({
      serverName: 's1',
      resource: 'https://mcp.example.com/mcp',
      store: store as any,
    });

    // 1. !signal
    vi.spyOn(provider as any, 'refreshInner').mockResolvedValue(value);
    await (provider as any).refresh(value, undefined);

    // 2. signal already aborted with Error
    const errController = new AbortController();
    errController.abort(new Error('pre-aborted error'));
    await expect((provider as any).refresh(value, errController.signal)).rejects.toThrow(
      'pre-aborted error',
    );

    // 3. signal already aborted with non-Error
    const strController = new AbortController();
    strController.abort('pre-aborted string');
    await expect((provider as any).refresh(value, strController.signal)).rejects.toThrow(
      'MCP token refresh aborted',
    );

    // 4. signal aborts while pending with Error
    vi.spyOn(provider as any, 'refreshInner').mockImplementation(() => new Promise(() => {}));
    const pendingController = new AbortController();
    const p = (provider as any).refresh(value, pendingController.signal);
    pendingController.abort(new Error('pending error'));
    await expect(p).rejects.toThrow('pending error');

    // Reset refreshPromise so next step doesn't inherit the unsettled promise
    (provider as any).refreshPromise = undefined;

    // 5. signal aborts while pending with non-Error
    const pendingStrController = new AbortController();
    const p2 = (provider as any).refresh(value, pendingStrController.signal);
    pendingStrController.abort('custom string abort');
    await expect(p2).rejects.toThrow('MCP token refresh aborted');

    // Reset refreshPromise
    (provider as any).refreshPromise = undefined;

    // 6. un-aborted signal with mock refreshInner resolving (line 324 finally)
    const unAborted = new AbortController();
    vi.spyOn(provider as any, 'refreshInner').mockResolvedValue(value);
    await (provider as any).refresh(value, unAborted.signal);
  });

  it('covers transport-base.ts pinnedDispatcher with tls options', () => {
    const transport = new SSETransport({
      name: 'sse-tls',
      url: 'https://example.com',
      tls: { ca: 'fake-cert', rejectUnauthorized: true },
    });
    const dispatcher = (transport as any).pinnedDispatcher();
    expect(dispatcher).toBeDefined();
    transport.close();
  });

  it('covers transport-security.ts classifyTransportAddress and transportPinnedLookup branches', async () => {
    // 1. classifyTransportAddress line 158 false branch (invalid hex)
    expect(classifyTransportAddress('::ffff:xyz:123', 6)).toBe('blocked');

    // 2. transportPinnedLookup line 233 default lookup invoked
    const defaultLookupFn = transportPinnedLookup({ allowPrivateNetworks: true });
    await new Promise<void>((resolve) => {
      defaultLookupFn('127.0.0.1', {}, () => resolve());
    });

    // 3. transportPinnedLookup lines 238-243 empty records
    const emptyLookup = transportPinnedLookup({
      allowPrivateNetworks: false,
      lookup: async () => [],
    });
    await new Promise<void>((resolve) => {
      emptyLookup('empty.example.com', {}, (err) => {
        expect(err).toBeDefined();
        expect((err as any).code).toBe('ENOTFOUND');
        resolve();
      });
    });

    // 4. transportPinnedLookup line 258 fallback to records when filtered is empty
    const lookupFn = transportPinnedLookup({
      allowPrivateNetworks: false,
      lookup: async () => [{ address: '2606:4700::6810:1', family: 6 }],
    });
    await new Promise<void>((resolve) => {
      lookupFn('v6only.example.com', { family: 4, all: true }, (err, records) => {
        expect(err).toBeNull();
        expect(records).toEqual([{ address: '2606:4700::6810:1', family: 6 }]);
        resolve();
      });
    });
  });

  it('covers transport-sse.ts notifications method and markDisconnected on error', async () => {
    const transport = new SSETransport({
      name: 'sse',
      url: 'https://example.com',
    });

    // 1. notifications method returns jsonrpc object
    (transport as any).fetchWithAuthorization = vi
      .fn()
      .mockResolvedValue(new Response('', { status: 202 }));
    const notifRes = await transport.request('notifications/test', {});
    expect(notifRes).toMatchObject({ jsonrpc: '2.0' });

    // 2. error causes markDisconnected when state === 'connected'
    (transport as any).state = 'connected';
    let disconnected = false;
    transport.onDisconnect(() => {
      disconnected = true;
    });

    (transport as any).fetchWithAuthorization = vi
      .fn()
      .mockRejectedValue(new Error('network down'));

    await expect((transport as any).httpPost('tools/list', {})).rejects.toThrow('network down');
    expect(disconnected).toBe(true);
    expect((transport as any).state).toBe('disconnected');

    // 3. reader cancel and releaseLock in close()
    (transport as any).reader = {
      cancel: vi.fn().mockResolvedValue(undefined),
      releaseLock: vi.fn(),
    };
    await transport.close();

    // 4. readBodyCapped throwing ToolError with context.received in httpPost
    const transportErr = new SSETransport({ name: 'sse-err', url: 'https://example.com' });
    const largeChunk = new Uint8Array(1024 * 1024);
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(largeChunk);
        controller.close();
      },
    });
    (transportErr as any).fetchWithAuthorization = vi
      .fn()
      .mockResolvedValue(
        new Response(stream, { status: 500, statusText: 'Internal Server Error' }),
      );
    await expect((transportErr as any).httpPost('tools/list', {})).rejects.toThrow(/bytes total/);

    // 5. non-ToolError error body unreadable
    const transportNonToolErr = new SSETransport({ name: 'sse-err2', url: 'https://example.com' });
    (transportNonToolErr as any).fetchWithAuthorization = vi.fn().mockResolvedValue({
      ok: false,
      status: 500,
      body: {
        getReader: () => ({
          read: async () => {
            throw new Error('generic network stream break');
          },
          releaseLock: () => {},
        }),
      },
    });
    await expect((transportNonToolErr as any).httpPost('tools/list', {})).rejects.toThrow(
      'error body unreadable',
    );

    // 6. notifications/ with body error in httpPost (line 263 catch (() => undefined))
    (transport as any).fetchWithAuthorization = vi.fn().mockResolvedValue({
      ok: true,
      body: {
        getReader: () => ({
          read: async () => {
            throw new Error('body error');
          },
          releaseLock: () => {},
        }),
      },
    });
    const notifRes2 = await (transport as any).httpPost('notifications/test', {});
    expect(notifRes2).toMatchObject({ jsonrpc: '2.0' });

    // 7. notifications/ with body error in request (line 373 catch (() => undefined))
    const notifReqRes = await transport.request('notifications/test', {});
    expect(notifReqRes).toMatchObject({ jsonrpc: '2.0' });
  });

  it('covers transport-streamable.ts session fatal status codes marking disconnected', async () => {
    const transport = new StreamableHTTPTransport({
      name: 'streamable',
      url: 'https://example.com',
    });

    // 1. postRaw session fatal
    (transport as any).state = 'connected';
    let disconnected = false;
    transport.onDisconnect(() => {
      disconnected = true;
    });

    (transport as any).fetchWithAuthorization = vi
      .fn()
      .mockResolvedValue(new Response('Unauthorized', { status: 401, statusText: 'Unauthorized' }));

    await expect((transport as any).postRaw('tools/list', {})).rejects.toThrow(
      'HTTP 401: Unauthorized',
    );
    expect(disconnected).toBe(true);
    expect((transport as any).state).toBe('disconnected');

    // 2. request session fatal
    (transport as any).state = 'connected';
    disconnected = false;
    await expect(transport.request('tools/list', {})).rejects.toThrow('HTTP 401: Unauthorized');
    expect(disconnected).toBe(true);
    expect((transport as any).state).toBe('disconnected');

    // 3. markDisconnected when state !== 'connected'
    (transport as any).state = 'disconnected';
    (transport as any).markDisconnected();
    expect((transport as any).state).toBe('disconnected');
  });

  it('covers wrap-tool.ts empty error content fallback message', async () => {
    const fakeClient = {
      callTool: async () => ({
        isError: true,
        content: '',
      }),
    };

    const tool = wrapMCPTool(
      'test-server',
      { name: 'empty_err_tool', description: 'desc', inputSchema: {} },
      fakeClient as any,
    );
    await expect(
      tool.execute({}, {} as any, { signal: new AbortController().signal }),
    ).rejects.toThrow(/MCP tool ".*empty_err_tool" failed/);
  });
});
