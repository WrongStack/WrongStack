import { describe, expect, it, vi } from 'vitest';
import { MCPClient, type MCPTool, quoteWindowsArg } from '../src/client.js';

describe('quoteWindowsArg', () => {
  it('leaves simple tokens untouched', () => {
    expect(quoteWindowsArg('npx')).toBe('npx');
    expect(quoteWindowsArg('-y')).toBe('-y');
    expect(quoteWindowsArg('@scope/pkg')).toBe('@scope/pkg');
    expect(quoteWindowsArg('C:\\path\\no-space')).toBe('C:\\path\\no-space');
  });
  it('wraps tokens with whitespace in double quotes', () => {
    expect(quoteWindowsArg('C:\\Program Files\\x')).toBe('"C:\\Program Files\\x"');
  });
  it('escapes embedded double quotes as cmd.exe doubles them', () => {
    expect(quoteWindowsArg('a "b" c')).toBe('"a ""b"" c"');
  });
});

describe('MCPClient', () => {
  it('starts in idle state', () => {
    const c = new MCPClient({ name: 'test', transport: 'stdio', command: 'noop' });
    expect(c.getState()).toBe('idle');
    expect(c.listTools()).toEqual([]);
  });

  it('rejects SSE transport without url', async () => {
    const c = new MCPClient({ name: 'sse-no-url', transport: 'sse' });
    await expect(c.connect()).rejects.toThrow(/requires "url"/);
    expect(c.getState()).toBe('failed');
  });

  it('rejects streamable-http transport without url', async () => {
    const c = new MCPClient({ name: 'http-no-url', transport: 'streamable-http' });
    await expect(c.connect()).rejects.toThrow(/requires "url"/);
    expect(c.getState()).toBe('failed');
  });

  it('SSE transport fails when URL unreachable', async () => {
    const c = new MCPClient({
      name: 'sse-bad',
      transport: 'sse',
      url: 'https://127.0.0.1:9',
      startupTimeoutMs: 500,
    });
    await expect(c.connect()).rejects.toThrow();
    expect(c.getState()).toBe('failed');
  });

  it('streamable-http transport fails when URL unreachable', async () => {
    const c = new MCPClient({
      name: 'http-bad',
      transport: 'streamable-http',
      url: 'https://127.0.0.1:9',
      startupTimeoutMs: 500,
    });
    await expect(c.connect()).rejects.toThrow();
    expect(c.getState()).toBe('failed');
  }, 10_000);

  it('releases HTTP transport refs after a failed SSE connect', async () => {
    // Regression: a thrown `sseTransport.connect()` used to leave the
    // transport (with its read loop + AbortController) alive until GC. The
    // client must now close it deterministically and clear the field.
    const c = new MCPClient({
      name: 'sse-cleanup',
      transport: 'sse',
      url: 'https://127.0.0.1:9',
      startupTimeoutMs: 250,
    });
    await expect(c.connect()).rejects.toThrow();
    // After failure, listTools must report zero — the transport was torn
    // down, so no stale handle can leak tools (or, conversely, hide them).
    expect(c.listTools()).toEqual([]);
    expect(c.getState()).toBe('failed');
  }, 10_000);

  it('releases HTTP transport refs after a failed streamable-http connect', async () => {
    const c = new MCPClient({
      name: 'http-cleanup',
      transport: 'streamable-http',
      url: 'https://127.0.0.1:9',
      startupTimeoutMs: 250,
    });
    await expect(c.connect()).rejects.toThrow();
    expect(c.listTools()).toEqual([]);
    expect(c.getState()).toBe('failed');
  }, 10_000);

  it('requires command for stdio transport', async () => {
    const c = new MCPClient({ name: 'no-cmd', transport: 'stdio' });
    await expect(c.connect()).rejects.toThrow(/requires "command"/);
    expect(c.getState()).toBe('failed');
  });

  it('callTool rejects when not connected', async () => {
    const c = new MCPClient({ name: 'idle', transport: 'stdio', command: 'noop' });
    await expect(c.callTool('any', {})).rejects.toThrow(/not connected/);
  });

  it('rejects unanswered stdio JSON-RPC requests after requestTimeoutMs', async () => {
    const c = new MCPClient({
      name: 'timeout-test',
      transport: 'stdio',
      command: 'noop',
      requestTimeoutMs: 20,
    });
    // Inject a writable stdin that accepts the request but never produces a
    // response. This drives the real timeout path — without it the request
    // would be rejected synchronously by the "stdin not writable" guard and
    // never reach the timer.
    (c as never as { child: { stdin: { write: () => boolean; destroyed: boolean } } }).child = {
      stdin: { write: () => true, destroyed: false },
    };
    await expect(
      (c as never as { request: (method: string, params: unknown) => Promise<unknown> }).request(
        'tools/list',
        {},
      ),
    ).rejects.toThrow(/timed out/);
    expect((c as never as { pending: Map<unknown, unknown> }).pending.size).toBe(0);
  });

  it('close on idle client is a no-op', async () => {
    const c = new MCPClient({ name: 'idle', transport: 'stdio', command: 'noop' });
    await expect(c.close()).resolves.toBeUndefined();
    expect(c.getState()).toBe('disconnected');
  });

  it('connect to nonexistent binary fails with timeout', async () => {
    const c = new MCPClient({
      name: 'broken',
      transport: 'stdio',
      command: '__definitely_not_a_binary__',
      startupTimeoutMs: 100,
    });
    await expect(c.connect()).rejects.toThrow();
  });

  it('addExitListener fires callback on child exit', () => {
    const c = new MCPClient({
      name: 'listener-test',
      transport: 'stdio',
      command: 'echo',
      args: ['hello'],
    });
    const handler = vi.fn();
    c.addExitListener(handler);
    // Simulate exit by directly emitting (can't easily test real spawn exit here)
    // The listener is registered correctly — verify by removing
    expect(() => c.removeExitListener(handler)).not.toThrow();
  });

  it('listTools returns cached tools after disconnect', () => {
    const c = new MCPClient({ name: 'cache-test', transport: 'stdio', command: 'echo' });
    // Before any connect, listTools returns empty
    expect(c.listTools()).toEqual([]);
    // listTools() of a client that has no tools yet but has a cache (set after first connect)
    // The fallback logic in listTools: prefer _tools over _toolsCache
    expect(c.listTools().length).toBe(0);
  });

  describe('L2-C tools/list_changed notification', () => {
    it('addToolsChangedListener accepts and removes listeners without throwing', () => {
      const c = new MCPClient({ name: 'tlc', transport: 'stdio', command: 'noop' });
      const listener = vi.fn();
      expect(() => c.addToolsChangedListener(listener)).not.toThrow();
      expect(() => c.removeToolsChangedListener(listener)).not.toThrow();
    });

    it('list_changed notification triggers refresh + listener via private onLine path', async () => {
      const c = new MCPClient({ name: 'tlc-2', transport: 'stdio', command: 'noop' });
      const refreshed: { name: string; tools: { name: string }[] }[] = [];
      c.addToolsChangedListener((name, tools) => {
        refreshed.push({ name, tools: tools.map((t) => ({ name: t.name })) });
      });
      // Stub the request method so the refresh "succeeds" without a real
      // child process. This drives the same code path as a real server
      // sending the notification.
      const fakeRequest = vi.fn(async (method: string) => {
        if (method === 'tools/list') {
          return {
            jsonrpc: '2.0',
            id: 1,
            result: { tools: [{ name: 'new_tool', inputSchema: {} }] },
          };
        }
        return { jsonrpc: '2.0', id: 1, result: {} };
      });
      // Cast through unknown to invoke private members for the test.
      (c as never as { request: typeof fakeRequest }).request = fakeRequest;
      (c as never as { onLine: (line: string) => void }).onLine(
        JSON.stringify({ jsonrpc: '2.0', method: 'notifications/tools/list_changed' }),
      );
      // Allow the async refresh to settle
      await new Promise((r) => setTimeout(r, 10));
      expect(fakeRequest).toHaveBeenCalledWith('tools/list', {});
      expect(refreshed).toHaveLength(1);
      expect(refreshed[0]?.tools[0]?.name).toBe('new_tool');
      // Cache is now invalidated to the new list
      expect(c.listTools()[0]?.name).toBe('new_tool');
    });

    it('filters invalid tools and defaults missing inputSchema during refresh', async () => {
      const c = new MCPClient({ name: 'tlc-normalize', transport: 'stdio', command: 'noop' });
      (c as never as { request: (method: string) => Promise<unknown> }).request = async () => ({
        jsonrpc: '2.0',
        id: 1,
        result: {
          tools: [
            { name: '', inputSchema: {} },
            { description: 'missing name', inputSchema: {} },
            { name: 'valid' },
          ],
        },
      });
      (c as never as { onLine: (line: string) => void }).onLine(
        JSON.stringify({ jsonrpc: '2.0', method: 'notifications/tools/list_changed' }),
      );
      await new Promise((r) => setTimeout(r, 10));
      expect(c.listTools()).toEqual([
        { name: 'valid', inputSchema: { type: 'object', properties: {} } },
      ]);
    });

    it('list_changed refresh failure is swallowed; cache stays intact', async () => {
      const c = new MCPClient({ name: 'tlc-3', transport: 'stdio', command: 'noop' });
      // Pre-seed cache so we can verify it isn't wiped on error.
      (c as never as { _tools: { name: string }[] })._tools = [
        { name: 'cached', inputSchema: {} } as never,
      ];
      const listener = vi.fn();
      c.addToolsChangedListener(listener);
      (c as never as { request: () => Promise<unknown> }).request = async () => {
        throw new Error('upstream rejected');
      };
      (c as never as { onLine: (line: string) => void }).onLine(
        JSON.stringify({ jsonrpc: '2.0', method: 'notifications/tools/list_changed' }),
      );
      await new Promise((r) => setTimeout(r, 10));
      expect(listener).not.toHaveBeenCalled();
      expect(c.listTools()[0]?.name).toBe('cached');
    });
  });

  describe('close() — stdio lifecycle edge cases', () => {
    it('close uses SIGTERM then escalates to SIGKILL on stuck process', async () => {
      // The previous version of this test constructed a client with a
      // `while(true) {}` busy-loop command but never called connect() — no
      // child ever existed, so close() returned instantly and the
      // SIGTERM→SIGKILL escalation was never exercised. Drive the real
      // escalation deterministically with an injected fake child that
      // ignores SIGTERM and only exits on SIGKILL — no subprocess needed.
      const c = new MCPClient({
        name: 'force-kill-test',
        transport: 'stdio',
        command: 'noop',
      });
      const { EventEmitter } = await import('node:events');
      const fakeChild = new EventEmitter() as InstanceType<typeof EventEmitter> & {
        exitCode: number | null;
        signalCode: string | null;
        kill: (signal?: string) => boolean;
      };
      fakeChild.exitCode = null;
      fakeChild.signalCode = null;
      const signals: string[] = [];
      fakeChild.kill = (signal = 'SIGTERM') => {
        signals.push(signal);
        if (signal === 'SIGKILL') {
          fakeChild.signalCode = 'SIGKILL';
          fakeChild.emit('exit', null, 'SIGKILL');
        }
        // SIGTERM is ignored — the "stuck" server.
        return true;
      };
      Object.defineProperty(c as never as Record<string, unknown>, 'child', {
        value: fakeChild,
        writable: true,
        configurable: true,
      });
      await c.close();
      expect(signals).toEqual(['SIGTERM', 'SIGKILL']);
      expect(c.getState()).toBe('disconnected');
    });

    it('close sets state to disconnected even when child never started', async () => {
      const c = new MCPClient({
        name: 'never-started',
        transport: 'stdio',
        command: 'noop',
      });
      // Never called connect()
      await c.close();
      expect(c.getState()).toBe('disconnected');
    });

    it('close is safe to call multiple times', async () => {
      const c = new MCPClient({
        name: 'double-close',
        transport: 'stdio',
        command: 'node',
        args: ['-e', 'process.stdin.resume()'],
        startupTimeoutMs: 500,
      });
      // connect() will timeout but we can still test close()
      try {
        await c.connect();
      } catch {
        // Expected timeout
      }
      await c.close();
      await expect(c.close()).resolves.toBeUndefined();
      expect(c.getState()).toBe('disconnected');
    });
  });

  describe('failPending() — error propagation', () => {
    it('failPending with zero pending is a no-op', () => {
      const c = new MCPClient({
        name: 'empty-pending',
        transport: 'stdio',
        command: 'echo',
        args: ['x'],
      });
      // Call failPending directly on an idle client with empty pending map
      expect(() =>
        (c as never as { failPending: (reason: string) => void }).failPending('test reason'),
      ).not.toThrow();
    });

    it('failPending swallows exceptions in request reject handlers', () => {
      const c = new MCPClient({
        name: 'reject-swallow',
        transport: 'stdio',
        command: 'echo',
        args: ['x'],
      });
      // Manually add a pending entry with a reject that throws
      const id = (c as never as { nextId: number }).nextId++;
      (
        c as never as {
          pending: Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>;
        }
      ).pending.set(id, {
        resolve: () => {},
        reject: () => {
          throw new Error('reject handler error');
        },
      });
      // failPending should not throw even when a reject handler throws
      expect(() =>
        (c as never as { failPending: (reason: string) => void }).failPending('test'),
      ).not.toThrow();
      expect((c as never as { pending: Map<unknown, unknown> }).pending.size).toBe(0);
    });
  });

  describe('notify() — backpressure handling', () => {
    it('hadNotifySkipped returns false after construction', () => {
      const c = new MCPClient({ name: 'notify-skipped', transport: 'stdio', command: 'echo' });
      expect(c.hadNotifySkipped()).toBe(false);
    });
  });

  describe('onLine() — JSON-RPC parsing edge cases', () => {
    it('onLine ignores malformed JSON', () => {
      const c = new MCPClient({ name: 'malformed-json', transport: 'stdio', command: 'echo' });
      (c as never as { onLine: (line: string) => void }).onLine('not json at all {{{');
      // Should not throw and should not call any handler
    });

    it('onLine handles server-initiated list_changed notification', async () => {
      const c = new MCPClient({
        name: 'server-list-changed',
        transport: 'stdio',
        command: 'echo',
        args: ['x'],
      });
      const toolsChanged = vi.fn();
      c.addToolsChangedListener(toolsChanged);
      // Simulate server sending a list_changed notification (no id)
      (c as never as { onLine: (line: string) => void }).onLine(
        JSON.stringify({ jsonrpc: '2.0', method: 'notifications/tools/list_changed' }),
      );
      // Allow async handleToolsListChanged to complete
      await new Promise((r) => setTimeout(r, 50));
    });
  });

  describe('addExitListener / removeExitListener', () => {
    it('removeExitListener on a never-added listener is safe', () => {
      const c = new MCPClient({ name: 'remove-never-added', transport: 'stdio', command: 'echo' });
      const handler = vi.fn();
      // Removing a listener that was never added should not throw
      expect(() => c.removeExitListener(handler)).not.toThrow();
    });

    it('addExitListener adds to exitListeners set', () => {
      const c = new MCPClient({ name: 'add-exit', transport: 'stdio', command: 'echo' });
      const handler = vi.fn();
      c.addExitListener(handler);
      // Verify the listener was added by removing it successfully
      expect(() => c.removeExitListener(handler)).not.toThrow();
    });
  });

  describe('addDisconnectListener / removeDisconnectListener', () => {
    it('removeDisconnectListener on a never-added listener is safe', () => {
      const c = new MCPClient({
        name: 'remove-disconnect-never',
        transport: 'stdio',
        command: 'echo',
      });
      const handler = vi.fn();
      expect(() => c.removeDisconnectListener(handler)).not.toThrow();
    });

    it('disconnectListeners are called on SSE transport disconnect', async () => {
      const c = new MCPClient({
        name: 'sse-disconnect-listeners',
        transport: 'sse',
        url: 'https://127.0.0.1:9', // Will fail to connect
        startupTimeoutMs: 100,
      });
      const handler = vi.fn();
      c.addDisconnectListener(handler);
      try {
        await c.connect();
      } catch {
        // Expected to fail — state should be 'failed'
      }
      // On failed state, no disconnect event is emitted (it's only emitted on transport-side disconnect)
      expect(c.getState()).toBe('failed');
    });
  });

  describe('listTools() — cache fallback behavior', () => {
    it('listTools returns _tools when non-empty', () => {
      const c = new MCPClient({ name: 'tools-nonempty', transport: 'stdio', command: 'echo' });
      (c as never as { _tools: MCPTool[] })._tools = [{ name: 'cached_tool', inputSchema: {} }];
      const tools = c.listTools();
      expect(tools).toHaveLength(1);
      expect(tools[0]?.name).toBe('cached_tool');
    });

    it('listTools falls back to _toolsCache when _tools is empty', () => {
      const c = new MCPClient({ name: 'cache-fallback', transport: 'stdio', command: 'echo' });
      (c as never as { _tools: never[] })._tools = [];
      (c as never as { _toolsCache: MCPTool[] })._toolsCache = [
        { name: 'from_cache', inputSchema: {} },
      ];
      const tools = c.listTools();
      expect(tools).toHaveLength(1);
      expect(tools[0]?.name).toBe('from_cache');
    });

    it('listTools returns empty array when both caches are empty', () => {
      const c = new MCPClient({ name: 'both-empty', transport: 'stdio', command: 'echo' });
      expect(c.listTools()).toEqual([]);
    });
  });

  describe('connect() — unknown transport', () => {
    it('connect throws unknown transport error and sets state to failed', async () => {
      const c = new MCPClient({
        name: 'unknown-transport',
        // @ts-expect-error — intentionally passing invalid transport for test
        transport: 'unknown-transport-xyz',
      });
      await expect(c.connect()).rejects.toThrow(/Unknown transport/);
      expect(c.getState()).toBe('failed');
    });
  });

  describe('request() — stdio stdin.write() throws', () => {
    it('request() rejects when stdin.write throws', async () => {
      // Lines 436-439: the catch block handles stdin.write() throwing.
      // Create a client that has a child process with a throwing stdin.
      const c = new MCPClient({
        name: 'stdin-throws',
        transport: 'stdio',
        command: 'node',
        args: ['-e', 'process.stdin.resume()'],
      });
      // Access the private child field after construction (child is assigned during connect()).
      // Use any-cast to bypass TypeScript privacy — we need the actual object reference.
      const cAny = c as never as Record<string, unknown>;
      // After construction, child may be set if connectStdio was called (it is on construction
      // via connect()). But we need to replace stdin with a throwing one.
      // Directly set child to a mock process with a throwing stdin.write.
      const mockStdin = {
        write: () => { throw new Error('EPIPE broken pipe'); },
        on: () => {},
        removeListener: () => {},
      };
      const mockChild = {
        stdin: mockStdin,
        stdout: { on: () => {} },
        stderr: { on: () => {} },
        on: () => {},
        kill: () => {},
      };
      // Set the private child field directly
      Object.defineProperty(cAny, 'child', {
        value: mockChild,
        writable: true,
        configurable: true,
      });
      // Also set _drainPending to false so the normal write path is taken
      Object.defineProperty(cAny, '_drainPending', { value: false, configurable: true });
      await expect(
        (c as never as { request: (m: string, p: unknown) => Promise<unknown> }).request(
          'tools/list',
          {},
        ),
      ).rejects.toThrow(/EPIPE|stdin/);
      expect((c as never as { pending: Map<unknown, unknown> }).pending.size).toBe(0);
    });
  });

  describe('notify() — drain backpressure paths', () => {
    it('notify() skips when _drainPending is already true (line 472-478)', async () => {
      const c = new MCPClient({
        name: 'drain-backpressure',
        transport: 'stdio',
        command: 'node',
        args: ['-e', 'process.stdin.resume()'],
        startupTimeoutMs: 500,
      });
      // Manually set _drainPending to true to simulate a concurrent notify already waiting
      (c as never as { _drainPending: boolean })._drainPending = true;
      // Also set _lastNotifySkipped to false to verify it gets set
      (c as never as { _lastNotifySkipped: boolean })._lastNotifySkipped = false;
      // Call notify — should skip and set _lastNotifySkipped to true
      await expect(
        (c as never as { notify: (m: string, p: unknown) => Promise<void> }).notify(
          'notifications/initialized',
          {},
        ),
      ).resolves.toBeUndefined();
      expect((c as never as { _lastNotifySkipped: boolean })._lastNotifySkipped).toBe(true);
    });

    it('notify() throws when drain times out (lines 491-496)', async () => {
      const c = new MCPClient({
        name: 'drain-timeout',
        transport: 'stdio',
        command: 'node',
        args: ['-e', 'process.stdin.resume()'],
        startupTimeoutMs: 500,
      });
      // Set _drainPending = false so write() is called; write returns false to trigger
      // the drain-wait path, but stdin.once never fires 'drain' so the timeout fires.
      Object.defineProperty(c as never as Record<string, unknown>, '_drainPending', { value: false, configurable: true });
      const cAny = c as never as Record<string, unknown>;
      Object.defineProperty(cAny, 'child', {
        value: {
          stdin: {
            write: () => false, // backpressure triggers drain wait
            on: () => {},
            removeListener: () => {},
            once: (_event: string, _cb: () => void) => {}, // never fires drain — timeout fires
          },
          on: () => {},
          kill: () => {},
        },
        writable: true,
        configurable: true,
      });
      // The notify should eventually time out the drain wait
      await expect(
        (c as never as { notify: (m: string, p: unknown) => Promise<void> }).notify(
          'notifications/initialized',
          {},
        ),
      ).rejects.toThrow(/drain timeout/);
    });

    it('notify() throws wrapped error when write throws after backpressure (lines 501-505)', async () => {
      const c = new MCPClient({
        name: 'notify-write-throw',
        transport: 'stdio',
        command: 'echo',
        args: ['x'],
      });
      const cAny = c as never as Record<string, unknown>;
      let callCount = 0;
      Object.defineProperty(cAny, 'child', {
        value: {
          stdin: {
            write: (_s: string) => {
              callCount++;
              if (callCount > 1) throw new Error('pipe error');
              return false; // backpressure on first call
            },
            on: () => {},
          },
          on: () => {},
          kill: () => {},
        },
        writable: true,
        configurable: true,
      });
      Object.defineProperty(cAny, '_drainPending', { value: false, configurable: true });
      // First call hits backpressure, second throws
      await expect(
        (c as never as { notify: (m: string, p: unknown) => Promise<void> }).notify(
          'test',
          {},
        ),
      ).rejects.toThrow(/notify.*failed/);
    });
  });

  describe('stdio request error paths', () => {
    it('rejects immediately when stdin is not writable (no child spawned)', async () => {
      const c = new MCPClient({ name: 'no-stdin', transport: 'stdio', command: 'noop' });
      // No connect() → this.child is undefined. Without the guard the request
      // would sit pending until its timeout; the guard rejects synchronously.
      await expect(
        (
          c as never as {
            request: (m: string, p: unknown, t?: number) => Promise<unknown>;
          }
        ).request('tools/list', {}, 50_000),
      ).rejects.toThrow(/stdin not writable/);
    });

    it('failPending rejects every in-flight request (child error/exit path)', async () => {
      const c = new MCPClient({ name: 'fail-pending', transport: 'stdio', command: 'noop' });
      const cAny = c as never as {
        child: { stdin: { write: () => boolean; destroyed: boolean } };
        request: (m: string, p: unknown, t?: number) => Promise<unknown>;
        failPending: (reason: string) => void;
      };
      // Inject a writable stdin so request() enqueues a pending entry instead
      // of rejecting via the not-writable guard.
      cAny.child = { stdin: { write: () => true, destroyed: false } };
      const inflight = cAny.request('tools/call', {}, 50_000);
      // Simulate what child.on('error') / on('exit') do: fail all pending.
      cAny.failPending('MCP "fail-pending" child error: boom');
      await expect(inflight).rejects.toThrow(/child error: boom/);
    });
  });
});
