import { createCompatibilityTrustBoundary, type TrustBoundary } from '@wrongstack/core/security';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { WebSocket } from 'ws';

// Allow-all boundary for killAll tests (which use 'critical' risk, now denied
// by default from remote-client actors). kill (high) is still allowed by default.
const allowBoundary = createCompatibilityTrustBoundary({ denyCriticalRiskRemoteClient: false });

// Mock the registry the handlers reach via dynamic `@wrongstack/tools` import.
const registry = vi.hoisted(() => ({
  list: vi.fn(),
  bySession: vi.fn(),
  get: vi.fn(),
  kill: vi.fn(),
  killAll: vi.fn(),
  killSession: vi.fn(),
}));
vi.mock('@wrongstack/tools', () => ({ getProcessRegistry: () => registry }));

const { handleProcessKill, handleProcessKillAll, handleProcessList } = await import(
  '@wrongstack/webui-server'
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
    registry.bySession.mockReset();
    registry.get.mockReset();
    registry.kill.mockReset();
    registry.killAll.mockReset();
    registry.killSession.mockReset();
  });

  describe('handleProcessList', () => {
    it('projects the registry list into the wire shape', async () => {
      registry.list.mockReturnValue([
        {
          pid: 10,
          command: 'bash -c x',
          name: 'bash',
          startedAt: 5,
          killed: false,
          protected: true,
          background: true,
        },
        { pid: 11, command: 'rg foo', name: 'grep', startedAt: 6, killed: true, protected: false },
      ]);
      const ws = createMockWs();
      await handleProcessList(ws);
      expect(ws.sent).toHaveLength(1);
      expect(ws.sent[0]).toEqual({
        type: 'process.list',
        payload: {
          processes: [
            {
              pid: 10,
              command: 'bash -c x',
              tool: 'bash',
              startedAt: 5,
              status: 'running',
              protected: true,
              background: true,
            },
            {
              pid: 11,
              command: 'rg foo',
              tool: 'grep',
              startedAt: 6,
              status: 'killed',
              protected: false,
            },
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

    it('lists only the named session’s processes and stamps the reply', async () => {
      registry.bySession.mockReturnValue([
        {
          pid: 10,
          command: 'bash -c x',
          name: 'bash',
          startedAt: 5,
          killed: false,
          sessionId: 'sess_a',
        },
      ]);
      const ws = createMockWs();
      await handleProcessList(ws, { payload: { sessionId: 'sess_a' } });
      expect(registry.bySession).toHaveBeenCalledWith('sess_a');
      expect(registry.list).not.toHaveBeenCalled();
      expect(ws.sent[0]?.payload.sessionId).toBe('sess_a');
      expect(ws.sent[0]?.payload.processes).toEqual([
        {
          pid: 10,
          command: 'bash -c x',
          tool: 'bash',
          startedAt: 5,
          status: 'running',
          sessionId: 'sess_a',
        },
      ]);
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
      await handleProcessKill(ws, { pid: 42 }, allowBoundary);
      expect(registry.kill).not.toHaveBeenCalled();
      expect(ws.sent[0]?.payload.success).toBe(false);
      expect(String(ws.sent[0]?.payload.message)).toContain('protected');
    });

    it('kills an unprotected process', async () => {
      registry.get.mockReturnValue({ protected: false });
      const ws = createMockWs();
      await handleProcessKill(ws, { pid: 42 }, allowBoundary);
      expect(registry.kill).toHaveBeenCalledWith(42);
      expect(ws.sent[0]?.payload.success).toBe(true);
    });

    it('refuses to kill a process owned by another session', async () => {
      registry.get.mockReturnValue({ protected: false, sessionId: 'sess_a' });
      const ws = createMockWs();
      await handleProcessKill(ws, { pid: 42, sessionId: 'sess_b' }, allowBoundary);
      expect(registry.kill).not.toHaveBeenCalled();
      expect(ws.sent[0]?.payload.success).toBe(false);
      expect(String(ws.sent[0]?.payload.message)).toContain('another session');
    });

    it('routes termination through TrustBoundary before touching the registry', async () => {
      const evaluate = vi.fn(async () => ({ kind: 'deny' as const, reason: 'policy denied' }));
      const boundary: TrustBoundary = { evaluate };
      registry.get.mockReturnValue({ protected: false });
      const ws = createMockWs();

      await handleProcessKill(ws, { pid: 42 }, boundary);

      expect(registry.kill).not.toHaveBeenCalled();
      expect(evaluate).toHaveBeenCalledWith(
        expect.objectContaining({
          surface: 'webui',
          capability: 'process.terminate',
          subject: { kind: 'process', id: '42', attributes: { operation: 'kill' } },
          risk: 'high',
        }),
      );
      expect(String(ws.sent[0]?.payload.message)).toContain('policy denied');
    });
  });

  describe('handleProcessKillAll', () => {
    it('kills all and confirms', async () => {
      const ws = createMockWs();
      await handleProcessKillAll(ws, allowBoundary);
      expect(registry.killAll).toHaveBeenCalledOnce();
      expect(ws.sent[0]?.payload.success).toBe(true);
    });

    it('kill-all for a named session does not touch the other tabs', async () => {
      const ws = createMockWs();
      await handleProcessKillAll(ws, allowBoundary, undefined, undefined, { sessionId: 'sess_b' });
      expect(registry.killSession).toHaveBeenCalledWith('sess_b');
      expect(registry.killAll).not.toHaveBeenCalled();
    });
  });
});
