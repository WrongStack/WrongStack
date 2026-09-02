import { createCompatibilityTrustBoundary } from '@wrongstack/core/security';
import { beforeEach, describe, expect, it, vi } from 'vitest';

// ── Fake node-pty ────────────────────────────────────────────────────────────
interface FakePty {
  pid?: number | undefined;
  write: ReturnType<typeof vi.fn>;
  resize: ReturnType<typeof vi.fn>;
  kill: ReturnType<typeof vi.fn>;
  emitData: (d: string) => void;
  emitExit: (code: number, signal?: number) => void;
}

// Hoisted so the vi.mock factory (also hoisted) can reference them safely.
const { spawned, spawnMock } = vi.hoisted(() => {
  const spawnedArr: FakePty[] = [];
  const mock = vi.fn(() => {
    let dataCb: ((d: string) => void) | null = null;
    let exitCb: ((e: { exitCode: number; signal?: number }) => void) | null = null;
    const pty: FakePty = {
      pid: undefined,
      write: vi.fn(),
      resize: vi.fn(),
      kill: vi.fn(),
      emitData: (d) => dataCb?.(d),
      emitExit: (code, signal) => exitCb?.({ exitCode: code, signal }),
    };
    const handle = {
      get pid() {
        return pty.pid;
      },
      onData: (cb: (d: string) => void) => {
        dataCb = cb;
      },
      onExit: (cb: (e: { exitCode: number; signal?: number }) => void) => {
        exitCb = cb;
      },
      write: pty.write,
      resize: pty.resize,
      kill: pty.kill,
    };
    spawnedArr.push(pty);
    return handle;
  });
  return { spawned: spawnedArr, spawnMock: mock };
});

import { TerminalWebSocketHandler } from '@wrongstack/webui-server';

// ── Fake WebSocket ───────────────────────────────────────────────────────────
function makeWs() {
  const listeners: Record<string, Array<() => void>> = {};
  const sent: unknown[] = [];
  const ws = {
    readyState: 1,
    sent,
    send: (data: string) => sent.push(JSON.parse(data)),
    on: (ev: string, cb: () => void) => {
      listeners[ev] ??= [];
      listeners[ev].push(cb);
    },
    fire: (ev: string) => {
      for (const cb of listeners[ev] ?? []) cb();
    },
  };
  return ws as any;
}

const logger = { warn: vi.fn(), debug: vi.fn(), info: vi.fn(), error: vi.fn() };
const loadFakeNodePty = () => ({ spawn: spawnMock });
// Explicit boundary for test isolation. The default compat boundary denies
// critical risk from remote-client actors; terminal.create (high) is still
// allowed by default, but tests pass an explicit boundary to avoid coupling.
const allowBoundary = createCompatibilityTrustBoundary({ denyCriticalRiskRemoteClient: false });

describe('TerminalWebSocketHandler', () => {
  beforeEach(() => {
    spawned.length = 0;
    spawnMock.mockClear();
    logger.warn.mockClear();
    delete process.env.WRONGSTACK_TERMINAL_USE_CONPTY_DLL;
  });

  it('terminal.create spawns a pty in the given cwd and streams output', async () => {
    const h = new TerminalWebSocketHandler(
      () => '/my/cwd',
      logger,
      loadFakeNodePty,
      undefined,
      allowBoundary,
    );
    const ws = makeWs();
    h.addClient(ws);

    expect(
      await h.handleMessage(ws, {
        type: 'terminal.create',
        payload: { id: 't1', cols: 100, rows: 30 },
      }),
    ).toBe(true);
    expect(spawnMock).toHaveBeenCalledTimes(1);
    expect(spawnMock.mock.calls[0]?.[2]).toMatchObject({ cwd: '/my/cwd', cols: 100, rows: 30 });
    expect(spawnMock.mock.calls[0]?.[2]).not.toHaveProperty('useConptyDll');

    spawned[0]?.emitData('hello');
    expect(ws.sent).toContainEqual({
      type: 'terminal.output',
      payload: { id: 't1', data: 'hello' },
    });
  });

  it('terminal.create is idempotent for the same id', async () => {
    const h = new TerminalWebSocketHandler(
      () => '/c',
      logger,
      loadFakeNodePty,
      undefined,
      allowBoundary,
    );
    const ws = makeWs();
    h.addClient(ws);
    await h.handleMessage(ws, { type: 'terminal.create', payload: { id: 't1' } });
    await h.handleMessage(ws, { type: 'terminal.create', payload: { id: 't1' } });
    expect(spawnMock).toHaveBeenCalledTimes(1);
  });

  it('can opt into node-pty useConptyDll on Windows', async () => {
    process.env.WRONGSTACK_TERMINAL_USE_CONPTY_DLL = '1';
    const h = new TerminalWebSocketHandler(
      () => '/c',
      logger,
      loadFakeNodePty,
      undefined,
      allowBoundary,
    );
    const ws = makeWs();
    h.addClient(ws);
    await h.handleMessage(ws, { type: 'terminal.create', payload: { id: 't1' } });
    if (process.platform === 'win32') {
      expect(spawnMock.mock.calls[0]?.[2]).toMatchObject({ useConptyDll: true });
    } else {
      expect(spawnMock.mock.calls[0]?.[2]).not.toHaveProperty('useConptyDll');
    }
  });

  it('terminal.input writes to the pty', async () => {
    const h = new TerminalWebSocketHandler(
      () => '/c',
      logger,
      loadFakeNodePty,
      undefined,
      allowBoundary,
    );
    const ws = makeWs();
    h.addClient(ws);
    await h.handleMessage(ws, { type: 'terminal.create', payload: { id: 't1' } });
    await h.handleMessage(ws, { type: 'terminal.input', payload: { id: 't1', data: 'ls\r' } });
    expect(spawned[0]?.write).toHaveBeenCalledWith('ls\r');
  });

  it('terminal.resize resizes the pty', async () => {
    const h = new TerminalWebSocketHandler(
      () => '/c',
      logger,
      loadFakeNodePty,
      undefined,
      allowBoundary,
    );
    const ws = makeWs();
    h.addClient(ws);
    await h.handleMessage(ws, { type: 'terminal.create', payload: { id: 't1' } });
    await h.handleMessage(ws, {
      type: 'terminal.resize',
      payload: { id: 't1', cols: 120, rows: 40 },
    });
    expect(spawned[0]?.resize).toHaveBeenCalledWith(120, 40);
  });

  it('terminal.close kills the pty', async () => {
    const h = new TerminalWebSocketHandler(
      () => '/c',
      logger,
      loadFakeNodePty,
      undefined,
      allowBoundary,
    );
    const ws = makeWs();
    h.addClient(ws);
    await h.handleMessage(ws, { type: 'terminal.create', payload: { id: 't1' } });
    await h.handleMessage(ws, { type: 'terminal.close', payload: { id: 't1' } });
    expect(spawned[0]?.kill).toHaveBeenCalledTimes(1);
  });

  it('terminal.close logs kill errors without throwing', async () => {
    const h = new TerminalWebSocketHandler(
      () => '/c',
      logger,
      loadFakeNodePty,
      undefined,
      allowBoundary,
    );
    const ws = makeWs();
    h.addClient(ws);
    await h.handleMessage(ws, { type: 'terminal.create', payload: { id: 't1' } });
    spawned[0]?.kill.mockImplementationOnce(() => {
      throw new Error('AttachConsole failed');
    });
    await expect(
      h.handleMessage(ws, { type: 'terminal.close', payload: { id: 't1' } }),
    ).resolves.toBe(true);
    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining('terminal close failed: AttachConsole failed'),
    );
  });

  it('terminal.close uses taskkill on Windows when the pty pid is available', async () => {
    if (process.platform !== 'win32') return;
    const killProcessTree = vi.fn();
    const h = new TerminalWebSocketHandler(
      () => '/c',
      logger,
      loadFakeNodePty,
      killProcessTree,
      allowBoundary,
    );
    const ws = makeWs();
    h.addClient(ws);
    await h.handleMessage(ws, { type: 'terminal.create', payload: { id: 't1' } });
    if (spawned[0]) spawned[0].pid = 4242;
    await h.handleMessage(ws, { type: 'terminal.close', payload: { id: 't1' } });
    expect(killProcessTree).toHaveBeenCalledWith(4242);
    expect(spawned[0]?.kill).not.toHaveBeenCalled();
    expect(spawned[0]?.write).toHaveBeenCalledWith('\x03');
    expect(spawned[0]?.write).toHaveBeenCalledWith('exit\r');
  });

  it('pty exit notifies the client', async () => {
    const h = new TerminalWebSocketHandler(
      () => '/c',
      logger,
      loadFakeNodePty,
      undefined,
      allowBoundary,
    );
    const ws = makeWs();
    h.addClient(ws);
    await h.handleMessage(ws, { type: 'terminal.create', payload: { id: 't1' } });
    spawned[0]?.emitExit(0);
    expect(ws.sent).toContainEqual({
      type: 'terminal.exit',
      payload: { id: 't1', exitCode: 0, signal: undefined },
    });
  });

  it('client disconnect kills all its ptys', async () => {
    const h = new TerminalWebSocketHandler(
      () => '/c',
      logger,
      loadFakeNodePty,
      undefined,
      allowBoundary,
    );
    const ws = makeWs();
    h.addClient(ws);
    await h.handleMessage(ws, { type: 'terminal.create', payload: { id: 't1' } });
    await h.handleMessage(ws, { type: 'terminal.create', payload: { id: 't2' } });
    ws.fire('close');
    expect(spawned[0]?.kill).toHaveBeenCalled();
    expect(spawned[1]?.kill).toHaveBeenCalled();
  });

  it('client disconnect logs kill errors without throwing', async () => {
    const h = new TerminalWebSocketHandler(
      () => '/c',
      logger,
      loadFakeNodePty,
      undefined,
      allowBoundary,
    );
    const ws = makeWs();
    h.addClient(ws);
    await h.handleMessage(ws, { type: 'terminal.create', payload: { id: 't1' } });
    spawned[0]?.kill.mockImplementationOnce(() => {
      throw new Error('AttachConsole failed');
    });
    expect(() => ws.fire('close')).not.toThrow();
    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining('terminal client dispose failed: AttachConsole failed'),
    );
  });

  it('ignores malformed payloads without throwing', async () => {
    const h = new TerminalWebSocketHandler(
      () => '/c',
      logger,
      loadFakeNodePty,
      undefined,
      allowBoundary,
    );
    const ws = makeWs();
    h.addClient(ws);
    expect(await h.handleMessage(ws, { type: 'terminal.create', payload: {} })).toBe(true);
    expect(await h.handleMessage(ws, { type: 'terminal.input', payload: { id: 5 } })).toBe(true);
    expect(spawnMock).not.toHaveBeenCalled();
  });

  it('returns false for non-terminal messages', async () => {
    const h = new TerminalWebSocketHandler(
      () => '/c',
      logger,
      loadFakeNodePty,
      undefined,
      allowBoundary,
    );
    const ws = makeWs();
    h.addClient(ws);
    expect(await h.handleMessage(ws, { type: 'user_message', payload: {} })).toBe(false);
  });

  it('enforces the per-client session cap', async () => {
    const h = new TerminalWebSocketHandler(
      () => '/c',
      logger,
      loadFakeNodePty,
      undefined,
      allowBoundary,
    );
    const ws = makeWs();
    h.addClient(ws);
    for (let i = 0; i < 8; i++) {
      await h.handleMessage(ws, { type: 'terminal.create', payload: { id: `t${i}` } });
    }
    expect(spawnMock).toHaveBeenCalledTimes(8);
    // 9th create over the cap → no new spawn, an exit is sent instead.
    await h.handleMessage(ws, { type: 'terminal.create', payload: { id: 't8' } });
    expect(spawnMock).toHaveBeenCalledTimes(8);
    expect(ws.sent).toContainEqual({ type: 'terminal.exit', payload: { id: 't8', exitCode: -1 } });
  });

  it('reports terminal unavailability when node-pty is absent', async () => {
    const h = new TerminalWebSocketHandler(
      () => '/c',
      logger,
      () => null,
      undefined,
      allowBoundary,
    );
    const ws = makeWs();
    h.addClient(ws);
    expect(await h.handleMessage(ws, { type: 'terminal.create', payload: { id: 't1' } })).toBe(
      true,
    );
    expect(spawnMock).not.toHaveBeenCalled();
    expect(ws.sent).toContainEqual({
      type: 'terminal.output',
      payload: {
        id: 't1',
        data: expect.stringContaining('optional dependency node-pty is not installed'),
      },
    });
    expect(ws.sent).toContainEqual({ type: 'terminal.exit', payload: { id: 't1', exitCode: -1 } });
  });

  it('reports terminal spawn failures to the client', async () => {
    spawnMock.mockImplementationOnce(() => {
      throw new Error('AttachConsole failed');
    });
    const h = new TerminalWebSocketHandler(
      () => '/c',
      logger,
      loadFakeNodePty,
      undefined,
      allowBoundary,
    );
    const ws = makeWs();
    h.addClient(ws);
    expect(await h.handleMessage(ws, { type: 'terminal.create', payload: { id: 't1' } })).toBe(
      true,
    );
    expect(ws.sent).toContainEqual({
      type: 'terminal.output',
      payload: {
        id: 't1',
        data: expect.stringContaining('Integrated terminal failed to start: AttachConsole failed'),
      },
    });
    expect(ws.sent).toContainEqual({ type: 'terminal.exit', payload: { id: 't1', exitCode: -1 } });
  });
});
