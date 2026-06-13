import { afterEach, describe, expect, it, vi } from 'vitest';
import type { WebSocket } from 'ws';

// Mock the tools registry before importing the handlers.
const registry = {
  list: vi.fn(() => [] as Array<Record<string, unknown>>),
  get: vi.fn((_pid: number) => undefined as Record<string, unknown> | undefined),
  kill: vi.fn(),
  killAll: vi.fn(),
};
vi.mock('@wrongstack/tools', () => ({ getProcessRegistry: () => registry }));

const { handleProcessKill, handleProcessKillAll, handleProcessList } = await import(
  '../../src/webui-server/ws-handlers/index.js'
);
type WsServerMessage = import('../../src/webui-server/ws-handlers/index.js').WsServerMessage;

/**
 * PR 5i of Issue #30: process ws-handler unit tests. The global process
 * registry is mocked so no real children are spawned or killed.
 */

const FAKE_WS = {} as WebSocket;

function makeCtx() {
  const sent: WsServerMessage[] = [];
  return {
    ctx: {
      send: (_ws: WebSocket, m: WsServerMessage) => sent.push(m),
      broadcast: () => {},
      log: () => {},
    },
    sent,
  };
}
const lastOf = (msgs: WsServerMessage[], type: string) =>
  msgs.filter((m) => m.type === type).at(-1);
const result = (sent: WsServerMessage[]) =>
  sent.filter((m) => m.type === 'key.operation_result').at(-1)?.payload as
    | { success: boolean; message: string }
    | undefined;

afterEach(() => {
  vi.clearAllMocks();
  registry.list.mockReturnValue([]);
  registry.get.mockReturnValue(undefined);
});

describe('handleProcessList', () => {
  it('maps the registry entries to the wire shape', () => {
    registry.list.mockReturnValue([
      { pid: 7, command: 'sleep 1', name: 'bash', startedAt: 1, killed: false, protected: false },
      { pid: 8, command: 'serve', name: 'bash', startedAt: 2, killed: true, protected: true },
    ]);
    const { ctx, sent } = makeCtx();
    handleProcessList(ctx, FAKE_WS);
    const procs = (
      lastOf(sent, 'process.list')?.payload as { processes: Array<Record<string, unknown>> }
    ).processes;
    expect(procs).toEqual([
      {
        pid: 7,
        command: 'sleep 1',
        tool: 'bash',
        startedAt: 1,
        status: 'running',
        protected: false,
      },
      { pid: 8, command: 'serve', tool: 'bash', startedAt: 2, status: 'killed', protected: true },
    ]);
  });

  it('degrades to an empty list when the registry throws', () => {
    registry.list.mockImplementation(() => {
      throw new Error('boom');
    });
    const { ctx, sent } = makeCtx();
    handleProcessList(ctx, FAKE_WS);
    expect((lastOf(sent, 'process.list')?.payload as { processes: unknown[] }).processes).toEqual(
      [],
    );
  });
});

describe('handleProcessKill', () => {
  it('kills a normal process', () => {
    registry.get.mockReturnValue({ protected: false });
    const { ctx, sent } = makeCtx();
    handleProcessKill(ctx, FAKE_WS, 42);
    expect(registry.kill).toHaveBeenCalledWith(42);
    expect(result(sent)).toMatchObject({ success: true });
  });

  it('refuses to kill a protected process', () => {
    registry.get.mockReturnValue({ protected: true });
    const { ctx, sent } = makeCtx();
    handleProcessKill(ctx, FAKE_WS, 9);
    expect(registry.kill).not.toHaveBeenCalled();
    expect(result(sent)).toMatchObject({ success: false });
    expect(result(sent)?.message).toContain('protected');
  });
});

describe('handleProcessKillAll', () => {
  it('kills all and reports success', () => {
    const { ctx, sent } = makeCtx();
    handleProcessKillAll(ctx, FAKE_WS);
    expect(registry.killAll).toHaveBeenCalledTimes(1);
    expect(result(sent)).toMatchObject({ success: true, message: 'All processes killed' });
  });
});
