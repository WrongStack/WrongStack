import { afterEach, describe, expect, it, vi } from 'vitest';
import type { WebSocket } from 'ws';

// Mock the registry the handlers reach via dynamic `@wrongstack/tools` import.
const registry = vi.hoisted(() => ({
  list: vi.fn(),
  get: vi.fn(),
  kill: vi.fn(),
  killAll: vi.fn(),
}));
vi.mock('@wrongstack/tools', () => ({ getProcessRegistry: () => registry }));

const { handleProcessKill, handleProcessKillAll, handleProcessList } = await import(
  '../../src/server/process-handlers.js'
);

/** Minimal ws mock that records parsed JSON sends. */
function createMockWs() {
  const ws = {
    readyState: 1,
    sent: [] as Array<{ type: string; payload: Record<string, unknown> }>,
    send(data: string) {
      this.sent.push(JSON.parse(data));
    },
  } as never as WebSocket & { sent: Array<{ type: string; payload: Record<string, unknown> }> };
  return ws;
}

describe('process WebSocket handlers', () => {
  afterEach(() => {
    registry.list.mockReset();
    registry.get.mockReset();
    registry.kill.mockReset();
    registry.killAll.mockReset();
  });

  describe('handleProcessList', () => {
    it('projects the registry list into the wire shape', async () => {
      registry.list.mockReturnValue([
        { pid: 10, command: 'bash -c x', name: 'bash', startedAt: 5, killed: false, protected: true },
        { pid: 11, command: 'rg foo', name: 'grep', startedAt: 6, killed: true, protected: false },
      ]);
      const ws = createMockWs();
      await handleProcessList(ws);
      expect(ws.sent).toHaveLength(1);
      expect(ws.sent[0]).toEqual({
        type: 'process.list',
        payload: {
          processes: [
            { pid: 10, command: 'bash -c x', tool: 'bash', startedAt: 5, status: 'running', protected: true },
            { pid: 11, command: 'rg foo', tool: 'grep', startedAt: 6, status: 'killed', protected: false },
          ],
        },
      });
    });

    it('sends an empty list if the registry throws', async () => {
      registry.list.mockImplementation(() => {
        throw new Error('boom');
      });
      const ws = createMockWs();
      await handleProcessList(ws);
      expect(ws.sent[0]).toEqual({ type: 'process.list', payload: { processes: [] } });
    });
  });

  describe('handleProcessKill', () => {
    it('rejects an invalid payload without touching the registry', async () => {
      const ws = createMockWs();
      await handleProcessKill(ws, { pid: -1 });
      expect(registry.kill).not.toHaveBeenCalled();
      expect(ws.sent[0]?.payload.success).toBe(false);
    });

    it('refuses to kill a protected process', async () => {
      registry.get.mockReturnValue({ protected: true });
      const ws = createMockWs();
      await handleProcessKill(ws, { pid: 42 });
      expect(registry.kill).not.toHaveBeenCalled();
      expect(ws.sent[0]?.payload.success).toBe(false);
      expect(String(ws.sent[0]?.payload.message)).toContain('protected');
    });

    it('kills an unprotected process', async () => {
      registry.get.mockReturnValue({ protected: false });
      const ws = createMockWs();
      await handleProcessKill(ws, { pid: 42 });
      expect(registry.kill).toHaveBeenCalledWith(42);
      expect(ws.sent[0]?.payload.success).toBe(true);
    });
  });

  describe('handleProcessKillAll', () => {
    it('kills all and confirms', async () => {
      const ws = createMockWs();
      await handleProcessKillAll(ws);
      expect(registry.killAll).toHaveBeenCalledOnce();
      expect(ws.sent[0]?.payload.success).toBe(true);
    });
  });
});
