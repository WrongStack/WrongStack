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
const tailBackgroundLog = vi.hoisted(() => vi.fn());
vi.mock('@wrongstack/tools', () => ({ getProcessRegistry: () => registry, tailBackgroundLog }));

const { handleProcessKill, handleProcessKillAll, handleProcessList, handleProcessOutput } =
  await import('@wrongstack/webui-server');

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

  describe('handleProcessOutput', () => {
    afterEach(() => {
      tailBackgroundLog.mockReset();
    });

    it('sends the tail of the log file the registry recorded for the pid', () => {
      registry.get.mockReturnValue({ pid: 7, sessionId: 's1', logFile: '/p/bg-logs/x.log' });
      tailBackgroundLog.mockReturnValue(['ready on :5173']);
      const ws = createMockWs();
      handleProcessOutput(ws, { pid: 7, lines: 12, sessionId: 's1' });
      expect(tailBackgroundLog).toHaveBeenCalledWith('/p/bg-logs/x.log', 12);
      expect(ws.sent[0]).toEqual({
        type: 'process.output',
        payload: { pid: 7, lines: ['ready on :5173'], sessionId: 's1' },
      });
    });

    it("refuses another session's process", () => {
      registry.get.mockReturnValue({ pid: 7, sessionId: 's2', logFile: '/p/bg-logs/x.log' });
      const ws = createMockWs();
      handleProcessOutput(ws, { pid: 7, sessionId: 's1' });
      expect(tailBackgroundLog).not.toHaveBeenCalled();
      expect(ws.sent[0]?.payload['success']).toBe(false);
    });

    it('answers gone for a process that has exited', () => {
      registry.get.mockReturnValue(undefined);
      const ws = createMockWs();
      handleProcessOutput(ws, { pid: 7 });
      expect(ws.sent[0]).toEqual({
        type: 'process.output',
        payload: { pid: 7, lines: [], gone: true },
      });
    });

    it('rejects a bad pid or line count', () => {
      const ws = createMockWs();
      handleProcessOutput(ws, { pid: -1 });
      handleProcessOutput(ws, { pid: 7, lines: 5000 });
      expect(ws.sent.map((m) => m.payload['success'])).toEqual([false, false]);
      expect(registry.get).not.toHaveBeenCalled();
    });
  });

  describe('handleProcessList', () => {
    it("adds the session's recently ended processes with their reported exit", async () => {
      registry.bySession.mockReturnValue([]);
      const recentlyEnded = vi.fn(() => [
        {
          pid: 12,
          name: 'bash',
          command: 'npm test',
          startedAt: 5,
          endedAt: 9,
          exitCode: 1,
          signal: null,
          killed: false,
          background: true,
          sessionId: 's1',
        },
      ]);
      Object.assign(registry, { recentlyEnded });
      try {
        const ws = createMockWs();
        await handleProcessList(ws, { payload: { sessionId: 's1' } });
        expect(recentlyEnded).toHaveBeenCalledWith('s1');
        expect(ws.sent[0]?.payload['ended']).toEqual([
          {
            pid: 12,
            command: 'npm test',
            tool: 'bash',
            startedAt: 5,
            endedAt: 9,
            exitCode: 1,
            signal: null,
            killed: false,
            background: true,
            sessionId: 's1',
          },
        ]);
      } finally {
        delete (registry as { recentlyEnded?: unknown }).recentlyEnded;
      }
    });
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
          logFile: '/p/bg-logs/x.log',
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
              hasOutput: true,
            },
            {
              pid: 11,
              command: 'rg foo',
              tool: 'grep',
              startedAt: 6,
              status: 'killed',
              protected: false,
              hasOutput: false,
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
          hasOutput: false,
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
