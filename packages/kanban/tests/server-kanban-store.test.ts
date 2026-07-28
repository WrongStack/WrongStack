/**
 * ServerKanbanStore — routing logic tests
 *
 * Covers the mode-based dispatch in call():
 *   file  → never connects, always direct()
 *   auto  → tries daemon, falls back to direct()
 *   server → requires daemon, throws on failure
 *   WRONGSTACK_KANBAN_SERVER=0 disables client connection
 */
import * as net from 'node:net';
import * as path from 'node:path';
import * as os from 'node:os';
import * as fs from 'node:fs/promises';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// ── Mock the client module before store imports ──────────────────
// vi.hoisted() ensures these exist before vi.mock() factory runs
const mockConn = vi.hoisted(() => ({
  request: vi.fn<(...args: any[]) => any>(),
  subscribe: vi.fn(),
}));
const mockGetConnection = vi.hoisted(() => vi.fn<(...args: any[]) => any>());
const mockIsAvailable = vi.hoisted(() => vi.fn<(...args: any[]) => any>());

vi.mock('../src/server/client.js', () => ({
  getKanbanServerConnection: mockGetConnection,
  isKanbanServerAvailable: mockIsAvailable,
}));

// Import after mock setup (vitest hoists vi.mock)
import { getServerKanbanStore } from '../src/server/kanban-store.js';
import { getKanbanServerConnection, type KanbanServerOperations } from '../src/server/client.js';

describe('ServerKanbanStore routing', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'kbn-store-'));
    vi.clearAllMocks();
    // Default: daemon available with working connection
    mockGetConnection.mockResolvedValue(mockConn);
    mockConn.request.mockResolvedValue([]);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    delete process.env['WRONGSTACK_KANBAN_MODE'];
    delete process.env['WRONGSTACK_KANBAN_SERVER'];
  });

  // ── file mode ──────────────────────────────────────────────────

  describe('mode=file', () => {
    it('never connects to daemon — always calls direct', async () => {
      process.env['WRONGSTACK_KANBAN_MODE'] = 'file';
      const store = getServerKanbanStore(tmpDir);
      const result = await store.listBoards();
      expect(getKanbanServerConnection).not.toHaveBeenCalled();
      // Direct call returns empty board list for empty tmpDir
      expect(Array.isArray(result)).toBe(true);
    });
  });

  // ── server mode ────────────────────────────────────────────────

  describe('mode=server', () => {
    it('routes through daemon when connection succeeds', async () => {
      process.env['WRONGSTACK_KANBAN_MODE'] = 'server';
      mockConn.request.mockResolvedValue([{ id: 'b1', title: 'Test' }]);
      const store = getServerKanbanStore(tmpDir);
      const result = await store.listBoards();
      expect(getKanbanServerConnection).toHaveBeenCalledWith(tmpDir);
      expect(mockConn.request).toHaveBeenCalledWith('listBoards', {});
      expect(result).toEqual([{ id: 'b1', title: 'Test' }]);
    });

    it('throws when daemon is unavailable (WRONGSTACK_KANBAN_SERVER=0)', async () => {
      process.env['WRONGSTACK_KANBAN_MODE'] = 'server';
      mockGetConnection.mockResolvedValue(null); // server disabled
      const store = getServerKanbanStore(tmpDir);
      await expect(store.listBoards()).rejects.toThrow(
        /Kanban server unavailable.*mode=server/,
      );
    });

    it('re-throws connection errors', async () => {
      process.env['WRONGSTACK_KANBAN_MODE'] = 'server';
      mockGetConnection.mockRejectedValue(new Error('connect ECONNREFUSED'));
      const store = getServerKanbanStore(tmpDir);
      await expect(store.listBoards()).rejects.toThrow(/connect ECONNREFUSED/);
    });
  });

  // ── auto mode ──────────────────────────────────────────────────

  describe('mode=auto (default)', () => {
    it('routes through daemon when available', async () => {
      mockConn.request.mockResolvedValue([{ id: 'b1', title: 'Daemon Board' }]);
      const store = getServerKanbanStore(tmpDir);
      const result = await store.listBoards();
      expect(getKanbanServerConnection).toHaveBeenCalledWith(tmpDir);
      expect(mockConn.request).toHaveBeenCalledWith('listBoards', {});
      expect(result).toEqual([{ id: 'b1', title: 'Daemon Board' }]);
    });

    it('falls back to direct when daemon is unavailable', async () => {
      mockGetConnection.mockResolvedValue(null); // WRONGSTACK_KANBAN_SERVER=0
      const store = getServerKanbanStore(tmpDir);
      const result = await store.listBoards();
      expect(Array.isArray(result)).toBe(true);
    });

    it('falls back to direct when connection fails', async () => {
      mockGetConnection.mockRejectedValue(new Error('connect ECONNREFUSED'));
      const store = getServerKanbanStore(tmpDir);
      const result = await store.listBoards();
      expect(Array.isArray(result)).toBe(true);
    });

    it('does NOT fall back to direct when request fails (avoids duplicate mutations)', async () => {
      // If the daemon dispatched a mutation but the IPC response was lost,
      // a fallback to `direct()` would re-execute the mutation and produce
      // duplicate boards/tasks/transitions. The error must surface so the
      // caller can decide whether to retry, not silently replay.
      mockGetConnection.mockResolvedValue(mockConn);
      mockConn.request.mockRejectedValue(new Error('Daemon internal error'));
      const store = getServerKanbanStore(tmpDir);
      await expect(store.listBoards()).rejects.toThrow(/Daemon internal error/);
    });
  });

  // ── integration with WRONGSTACK_KANBAN_SERVER env ──────────────

  describe('WRONGSTACK_KANBAN_SERVER=0', () => {
    it('returns null from getKanbanServerConnection and store falls back', async () => {
      process.env['WRONGSTACK_KANBAN_SERVER'] = '0';
      mockGetConnection.mockResolvedValue(null);
      const store = getServerKanbanStore(tmpDir);
      const result = await store.listBoards();
      expect(Array.isArray(result)).toBe(true);
    });
  });

  // ── method passthrough ─────────────────────────────────────────

  describe('method passthrough', () => {
    it('passes method name and params to daemon request', async () => {
      process.env['WRONGSTACK_KANBAN_MODE'] = 'server';
      mockConn.request.mockResolvedValue({ id: 'task-1', title: 'Test task' });
      const store = getServerKanbanStore(tmpDir);
      const result = await store.getTask('b1', 'task-1');
      expect(mockConn.request).toHaveBeenCalledWith('getTask', {
        boardId: 'b1',
        taskId: 'task-1',
      });
      expect(result).toEqual({ id: 'task-1', title: 'Test task' });
    });

    it('passes createBoard params correctly', async () => {
      process.env['WRONGSTACK_KANBAN_MODE'] = 'server';
      mockConn.request.mockResolvedValue({ id: 'b2', title: 'New Board' });
      const store = getServerKanbanStore(tmpDir);
      await store.createBoard({ title: 'New Board' });
      expect(mockConn.request).toHaveBeenCalledWith('createBoard', {
        title: 'New Board',
      });
    });

    it('routes setChain through the daemon with chain options', async () => {
      process.env['WRONGSTACK_KANBAN_MODE'] = 'server';
      mockConn.request.mockResolvedValue({ chainId: 'chain-1', tasks: [] });
      const store = getServerKanbanStore(tmpDir);
      await store.setChain('b1', ['t1', 't2'], {
        chainId: 'chain-1',
        enforceDependencies: false,
      });
      expect(mockConn.request).toHaveBeenCalledWith('setChain', {
        boardId: 'b1',
        taskIds: ['t1', 't2'],
        chainId: 'chain-1',
        enforceDependencies: false,
      });
    });

    it('routes getChain through the daemon by chainId or taskId', async () => {
      process.env['WRONGSTACK_KANBAN_MODE'] = 'server';
      mockConn.request.mockResolvedValue({ chainId: 'chain-1', tasks: [] });
      const store = getServerKanbanStore(tmpDir);
      await store.getChain('b1', { chainId: 'chain-1' });
      await store.getChain('b1', { taskId: 't1' });
      expect(mockConn.request).toHaveBeenNthCalledWith(1, 'getChain', {
        boardId: 'b1',
        chainId: 'chain-1',
      });
      expect(mockConn.request).toHaveBeenNthCalledWith(2, 'getChain', {
        boardId: 'b1',
        taskId: 't1',
      });
    });

    it('routes verifyTaskCompletion through the canonical daemon op', async () => {
      process.env['WRONGSTACK_KANBAN_MODE'] = 'server';
      mockConn.request.mockResolvedValue({ report: { verdict: 'passed' } });
      const store = getServerKanbanStore(tmpDir);
      await store.verifyTaskCompletion('b1', 't1', { persist: false });
      expect(mockConn.request).toHaveBeenCalledWith('verifyTaskCompletion', {
        boardId: 'b1',
        taskId: 't1',
        persist: false,
      });
    });

    it('keeps verifyCompletion typed as a legacy IPC alias', () => {
      const args: KanbanServerOperations['verifyCompletion']['args'] = {
        boardId: 'b1',
        taskId: 't1',
        persist: false,
      };
      expect(args).toEqual({ boardId: 'b1', taskId: 't1', persist: false });
    });
  });
});

// ── Protocol frame parsing tests (real net.Socket, mock server) ──

describe('Kanban protocol — net.Socket integration', () => {
  let helloServer: net.Server;
  let pingServer: net.Server;
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'kbn-proto-'));
  });

  afterEach(() => {
    pingServer?.close();
    helloServer?.close();
  });

  it('sends hello frame on connect (server to client)', async () => {
    helloServer = net.createServer((socket) => {
      socket.setEncoding('utf8');
      socket.write(JSON.stringify({
        type: 'hello',
        protocolVersion: 1,
        pid: process.pid,
        projectRoot: tmpDir,
        endpoint: 'test',
        startedAt: new Date().toISOString(),
      }) + '\n');
      socket.on('data', () => {});
    });

    const port = await new Promise<number>((resolve) => {
      helloServer.listen(0, '127.0.0.1', () => resolve((helloServer.address() as any).port));
    });

    const sock = net.createConnection({ port, host: '127.0.0.1' });
    sock.setEncoding('utf8');

    const hello = await new Promise<any>((resolve, reject) => {
      const timer = setTimeout(() => { sock.destroy(); reject(new Error('timeout')); }, 3000);
      let buf = '';
      sock.on('data', (chunk: string) => {
        buf += chunk;
        const nl = buf.indexOf('\n');
        if (nl !== -1) {
          clearTimeout(timer);
          resolve(JSON.parse(buf.slice(0, nl)));
          sock.destroy();
        }
      });
      sock.on('error', (err) => { clearTimeout(timer); reject(err); });
    });

    expect(hello.type).toBe('hello');
    expect(hello.protocolVersion).toBe(1);
    expect(hello.pid).toBe(process.pid);
  });

  it('sends a request frame and receives a response', async () => {
    pingServer = net.createServer((socket) => {
      socket.setEncoding('utf8');
      let buffer = '';
      socket.on('data', (chunk: string) => {
        buffer += chunk;
        const nl = buffer.indexOf('\n');
        if (nl === -1) return;
        const line = buffer.slice(0, nl);
        buffer = buffer.slice(nl + 1);
        try {
          const req = JSON.parse(line);
          if (req.method === 'ping') {
            socket.write(JSON.stringify({ id: req.id, ok: true, result: { status: 'ok', clients: 0, pendingRequests: 0 } }) + '\n');
          } else {
            socket.write(JSON.stringify({ id: req.id, ok: true, result: {} }) + '\n');
          }
        } catch {
          socket.write(JSON.stringify({ id: -1, error: { code: 'INVALID_INPUT', message: 'bad frame' } }) + '\n');
        }
      });
    });

    const port = await new Promise<number>((resolve) => {
      pingServer.listen(0, '127.0.0.1', () => resolve((pingServer.address() as any).port));
    });

    const sock = net.createConnection({ port, host: '127.0.0.1' });
    sock.setEncoding('utf8');

    const response = await new Promise<any>((resolve, reject) => {
      const timer = setTimeout(() => { sock.destroy(); reject(new Error('timeout')); }, 3000);
      let buf = '';
      sock.on('data', (chunk: string) => {
        buf += chunk;
        const nl = buf.indexOf('\n');
        if (nl !== -1) {
          clearTimeout(timer);
          resolve(JSON.parse(buf.slice(0, nl)));
          sock.destroy();
        }
      });
      sock.on('connect', () => {
        sock.write(JSON.stringify({ id: 1, method: 'ping', params: {} }) + '\n');
      });
      sock.on('error', (err) => { clearTimeout(timer); reject(err); });
    });

    expect(response).toMatchObject({ id: 1, ok: true });
    expect(response.result).toMatchObject({ status: 'ok' });
  });

  it('receives error frame for malformed request', async () => {
    pingServer = net.createServer((socket) => {
      socket.setEncoding('utf8');
      let buffer = '';
      socket.on('data', (chunk: string) => {
        buffer += chunk;
        const nl = buffer.indexOf('\n');
        if (nl === -1) return;
        const line = buffer.slice(0, nl);
        buffer = buffer.slice(nl + 1);
        try {
          const req = JSON.parse(line);
          socket.write(JSON.stringify({ id: req.id, ok: true, result: {} }) + '\n');
        } catch {
          socket.write(JSON.stringify({ id: -1, error: { code: 'INVALID_INPUT', message: 'bad frame' } }) + '\n');
        }
      });
    });

    const port = await new Promise<number>((resolve) => {
      pingServer.listen(0, '127.0.0.1', () => resolve((pingServer.address() as any).port));
    });

    const sock = net.createConnection({ port, host: '127.0.0.1' });
    sock.setEncoding('utf8');

    const response = await new Promise<any>((resolve, reject) => {
      const timer = setTimeout(() => { sock.destroy(); reject(new Error('timeout')); }, 3000);
      let buf = '';
      sock.on('data', (chunk: string) => {
        buf += chunk;
        const nl = buf.indexOf('\n');
        if (nl !== -1) {
          clearTimeout(timer);
          resolve(JSON.parse(buf.slice(0, nl)));
          sock.destroy();
        }
      });
      sock.on('connect', () => {
        sock.write('not valid json\n');
      });
      sock.on('error', (err) => { clearTimeout(timer); reject(err); });
    });

    expect(response).toMatchObject({ id: -1, error: { code: 'INVALID_INPUT' } });
  });
});
