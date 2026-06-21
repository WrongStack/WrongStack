import { beforeEach, describe, expect, it, vi } from 'vitest';

// ── Fake node-pty ────────────────────────────────────────────────────────────
interface FakePty {
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
      write: vi.fn(),
      resize: vi.fn(),
      kill: vi.fn(),
      emitData: (d) => dataCb?.(d),
      emitExit: (code, signal) => exitCb?.({ exitCode: code, signal }),
    };
    const handle = {
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

vi.mock('node-pty', () => ({ spawn: spawnMock }));

import { TerminalWebSocketHandler } from '../../src/server/terminal-ws-handler.js';

// ── Fake WebSocket ───────────────────────────────────────────────────────────
function makeWs() {
  const listeners: Record<string, Array<() => void>> = {};
  const sent: unknown[] = [];
  const ws = {
    readyState: 1,
    sent,
    send: (data: string) => sent.push(JSON.parse(data)),
    on: (ev: string, cb: () => void) => {
      (listeners[ev] ??= []).push(cb);
    },
    fire: (ev: string) => {
      for (const cb of listeners[ev] ?? []) cb();
    },
  };
  // biome-ignore lint/suspicious/noExplicitAny: test double
  return ws as any;
}

const logger = { warn: vi.fn(), debug: vi.fn(), info: vi.fn(), error: vi.fn() } as never;

describe('TerminalWebSocketHandler', () => {
  beforeEach(() => {
    spawned.length = 0;
    spawnMock.mockClear();
  });

  it('terminal.create spawns a pty in the given cwd and streams output', () => {
    const h = new TerminalWebSocketHandler(() => '/my/cwd', logger);
    const ws = makeWs();
    h.addClient(ws);

    expect(h.handleMessage(ws, { type: 'terminal.create', payload: { id: 't1', cols: 100, rows: 30 } })).toBe(true);
    expect(spawnMock).toHaveBeenCalledTimes(1);
    expect(spawnMock.mock.calls[0]?.[2]).toMatchObject({ cwd: '/my/cwd', cols: 100, rows: 30 });

    spawned[0]?.emitData('hello');
    expect(ws.sent).toContainEqual({ type: 'terminal.output', payload: { id: 't1', data: 'hello' } });
  });

  it('terminal.create is idempotent for the same id', () => {
    const h = new TerminalWebSocketHandler(() => '/c', logger);
    const ws = makeWs();
    h.addClient(ws);
    h.handleMessage(ws, { type: 'terminal.create', payload: { id: 't1' } });
    h.handleMessage(ws, { type: 'terminal.create', payload: { id: 't1' } });
    expect(spawnMock).toHaveBeenCalledTimes(1);
  });

  it('terminal.input writes to the pty', () => {
    const h = new TerminalWebSocketHandler(() => '/c', logger);
    const ws = makeWs();
    h.addClient(ws);
    h.handleMessage(ws, { type: 'terminal.create', payload: { id: 't1' } });
    h.handleMessage(ws, { type: 'terminal.input', payload: { id: 't1', data: 'ls\r' } });
    expect(spawned[0]?.write).toHaveBeenCalledWith('ls\r');
  });

  it('terminal.resize resizes the pty', () => {
    const h = new TerminalWebSocketHandler(() => '/c', logger);
    const ws = makeWs();
    h.addClient(ws);
    h.handleMessage(ws, { type: 'terminal.create', payload: { id: 't1' } });
    h.handleMessage(ws, { type: 'terminal.resize', payload: { id: 't1', cols: 120, rows: 40 } });
    expect(spawned[0]?.resize).toHaveBeenCalledWith(120, 40);
  });

  it('terminal.close kills the pty', () => {
    const h = new TerminalWebSocketHandler(() => '/c', logger);
    const ws = makeWs();
    h.addClient(ws);
    h.handleMessage(ws, { type: 'terminal.create', payload: { id: 't1' } });
    h.handleMessage(ws, { type: 'terminal.close', payload: { id: 't1' } });
    expect(spawned[0]?.kill).toHaveBeenCalledTimes(1);
  });

  it('pty exit notifies the client', () => {
    const h = new TerminalWebSocketHandler(() => '/c', logger);
    const ws = makeWs();
    h.addClient(ws);
    h.handleMessage(ws, { type: 'terminal.create', payload: { id: 't1' } });
    spawned[0]?.emitExit(0);
    expect(ws.sent).toContainEqual({ type: 'terminal.exit', payload: { id: 't1', exitCode: 0, signal: undefined } });
  });

  it('client disconnect kills all its ptys', () => {
    const h = new TerminalWebSocketHandler(() => '/c', logger);
    const ws = makeWs();
    h.addClient(ws);
    h.handleMessage(ws, { type: 'terminal.create', payload: { id: 't1' } });
    h.handleMessage(ws, { type: 'terminal.create', payload: { id: 't2' } });
    ws.fire('close');
    expect(spawned[0]?.kill).toHaveBeenCalled();
    expect(spawned[1]?.kill).toHaveBeenCalled();
  });

  it('ignores malformed payloads without throwing', () => {
    const h = new TerminalWebSocketHandler(() => '/c', logger);
    const ws = makeWs();
    h.addClient(ws);
    expect(h.handleMessage(ws, { type: 'terminal.create', payload: {} })).toBe(true);
    expect(h.handleMessage(ws, { type: 'terminal.input', payload: { id: 5 } })).toBe(true);
    expect(spawnMock).not.toHaveBeenCalled();
  });

  it('returns false for non-terminal messages', () => {
    const h = new TerminalWebSocketHandler(() => '/c', logger);
    const ws = makeWs();
    h.addClient(ws);
    expect(h.handleMessage(ws, { type: 'user_message', payload: {} })).toBe(false);
  });

  it('enforces the per-client session cap', () => {
    const h = new TerminalWebSocketHandler(() => '/c', logger);
    const ws = makeWs();
    h.addClient(ws);
    for (let i = 0; i < 8; i++) {
      h.handleMessage(ws, { type: 'terminal.create', payload: { id: `t${i}` } });
    }
    expect(spawnMock).toHaveBeenCalledTimes(8);
    // 9th create over the cap → no new spawn, an exit is sent instead.
    h.handleMessage(ws, { type: 'terminal.create', payload: { id: 't8' } });
    expect(spawnMock).toHaveBeenCalledTimes(8);
    expect(ws.sent).toContainEqual({ type: 'terminal.exit', payload: { id: 't8', exitCode: -1 } });
  });
});
