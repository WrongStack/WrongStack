/**
 * ServerKanbanStore — routing logic tests
 *
 * IPC is the only client transport:
 *   available daemon → request
 *   unavailable/disabled daemon → fail closed
 */

import * as fs from 'node:fs/promises';
import * as net from 'node:net';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

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

import { getKanbanServerConnection } from '../src/server/client.js';
// Import after mock setup (vitest hoists vi.mock)
import { getServerKanbanStore } from '../src/server/kanban-store.js';
import { encodeKanbanDomainValue } from '../src/server/protocol.js';

/** Session that owns the chain write this suite routes. */
const CHAIN_EVENT_CONTEXT = { sessionId: '2026-08-26/sess_01TESTSERVERSTORE0000000' };

describe('ServerKanbanStore routing', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'kbn-store-'));
    vi.clearAllMocks();
    // Default: daemon available with working connection
    mockGetConnection.mockResolvedValue(mockConn);
    mockConn.request.mockResolvedValue(encodeKanbanDomainValue([]));
  });

  afterEach(() => {
    vi.restoreAllMocks();
    delete process.env['WRONGSTACK_KANBAN_SERVER'];
  });

  describe('IPC routing', () => {
    it('routes through daemon when connection succeeds', async () => {
      mockConn.request.mockResolvedValue(encodeKanbanDomainValue([{ id: 'b1', title: 'Test' }]));
      const store = getServerKanbanStore(tmpDir);
      const result = await store.listBoards();
      expect(getKanbanServerConnection).toHaveBeenCalledWith(tmpDir);
      expect(mockConn.request).toHaveBeenCalledWith('domainCall', {
        operation: 'listBoards',
        wireArgs: encodeKanbanDomainValue([]),
      });
      expect(result).toEqual([{ id: 'b1', title: 'Test' }]);
    });

    it('throws when daemon is unavailable (WRONGSTACK_KANBAN_SERVER=0)', async () => {
      mockGetConnection.mockResolvedValue(null); // server disabled
      const store = getServerKanbanStore(tmpDir);
      await expect(store.listBoards()).rejects.toThrow(/Kanban server unavailable.*require.*IPC/i);
    });

    it('re-throws connection errors', async () => {
      mockGetConnection.mockRejectedValue(new Error('connect ECONNREFUSED'));
      const store = getServerKanbanStore(tmpDir);
      await expect(store.listBoards()).rejects.toThrow(/connect ECONNREFUSED/);
    });
  });

  describe('default routing', () => {
    it('routes through daemon when available', async () => {
      mockConn.request.mockResolvedValue(
        encodeKanbanDomainValue([{ id: 'b1', title: 'Daemon Board' }]),
      );
      const store = getServerKanbanStore(tmpDir);
      const result = await store.listBoards();
      expect(getKanbanServerConnection).toHaveBeenCalledWith(tmpDir);
      expect(mockConn.request).toHaveBeenCalledWith('domainCall', {
        operation: 'listBoards',
        wireArgs: encodeKanbanDomainValue([]),
      });
      expect(result).toEqual([{ id: 'b1', title: 'Daemon Board' }]);
    });

    it('fails closed when daemon is unavailable', async () => {
      mockGetConnection.mockResolvedValue(null); // WRONGSTACK_KANBAN_SERVER=0
      const store = getServerKanbanStore(tmpDir);
      await expect(store.listBoards()).rejects.toThrow(/require.*IPC/i);
    });

    it('fails closed when connection fails', async () => {
      mockGetConnection.mockRejectedValue(new Error('connect ECONNREFUSED'));
      const store = getServerKanbanStore(tmpDir);
      await expect(store.listBoards()).rejects.toThrow(/connect ECONNREFUSED/);
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
    it('returns null from getKanbanServerConnection and store rejects', async () => {
      process.env['WRONGSTACK_KANBAN_SERVER'] = '0';
      mockGetConnection.mockResolvedValue(null);
      const store = getServerKanbanStore(tmpDir);
      await expect(store.listBoards()).rejects.toThrow(/require.*IPC/i);
    });
  });

  // ── method passthrough ─────────────────────────────────────────

  describe('method passthrough', () => {
    it('passes method name and params to daemon request', async () => {
      mockConn.request.mockResolvedValue(
        encodeKanbanDomainValue({ id: 'task-1', title: 'Test task' }),
      );
      const store = getServerKanbanStore(tmpDir);
      const result = await store.getTask('b1', 'task-1');
      expect(mockConn.request).toHaveBeenCalledWith('domainCall', {
        operation: 'getTask',
        wireArgs: encodeKanbanDomainValue(['b1', 'task-1']),
      });
      expect(result).toEqual({ id: 'task-1', title: 'Test task' });
    });

    it('passes createBoard params correctly', async () => {
      mockConn.request.mockResolvedValue(encodeKanbanDomainValue({ id: 'b2', title: 'New Board' }));
      const store = getServerKanbanStore(tmpDir);
      await store.createBoard({ title: 'New Board' });
      expect(mockConn.request).toHaveBeenCalledWith('domainCall', {
        operation: 'createBoard',
        wireArgs: encodeKanbanDomainValue([{ title: 'New Board' }]),
      });
    });

    it('routes setChain through the daemon with chain options', async () => {
      mockConn.request.mockResolvedValue(
        encodeKanbanDomainValue({ chainId: 'chain-1', tasks: [] }),
      );
      const store = getServerKanbanStore(tmpDir);
      await store.setChain(
        'b1',
        ['t1', 't2'],
        { chainId: 'chain-1', enforceDependencies: false },
        CHAIN_EVENT_CONTEXT,
      );
      expect(mockConn.request).toHaveBeenCalledWith('domainCall', {
        operation: 'setTaskChain',
        wireArgs: encodeKanbanDomainValue([
          'b1',
          {
            taskIds: ['t1', 't2'],
            chainId: 'chain-1',
            enforceDependencies: false,
          },
          CHAIN_EVENT_CONTEXT,
        ]),
      });
    });

    it('routes getChain through the daemon by chainId or taskId', async () => {
      mockConn.request.mockResolvedValue(
        encodeKanbanDomainValue({ chainId: 'chain-1', tasks: [] }),
      );
      const store = getServerKanbanStore(tmpDir);
      await store.getChain('b1', { chainId: 'chain-1' });
      await store.getChain('b1', { taskId: 't1' });
      expect(mockConn.request).toHaveBeenNthCalledWith(1, 'domainCall', {
        operation: 'getTaskChain',
        wireArgs: encodeKanbanDomainValue(['b1', 'chain-1']),
      });
      expect(mockConn.request).toHaveBeenNthCalledWith(2, 'domainCall', {
        operation: 'getTaskChain',
        wireArgs: encodeKanbanDomainValue(['b1', 't1']),
      });
    });

    it('routes verifyTaskCompletion through the canonical daemon op', async () => {
      mockConn.request.mockResolvedValue(
        encodeKanbanDomainValue({ report: { verdict: 'passed' } }),
      );
      const store = getServerKanbanStore(tmpDir);
      await store.verifyTaskCompletion('b1', 't1', { persist: false });
      expect(mockConn.request).toHaveBeenCalledWith('domainCall', {
        operation: 'verifyTaskCompletion',
        wireArgs: encodeKanbanDomainValue(['b1', 't1', { persist: false }]),
      });
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
      socket.write(
        JSON.stringify({
          type: 'hello',
          protocolVersion: 1,
          pid: process.pid,
          projectRoot: tmpDir,
          endpoint: 'test',
          startedAt: new Date().toISOString(),
        }) + '\n',
      );
      socket.on('data', () => {});
    });

    const port = await new Promise<number>((resolve) => {
      helloServer.listen(0, '127.0.0.1', () => resolve((helloServer.address() as any).port));
    });

    const sock = net.createConnection({ port, host: '127.0.0.1' });
    sock.setEncoding('utf8');

    const hello = await new Promise<any>((resolve, reject) => {
      const timer = setTimeout(() => {
        sock.destroy();
        reject(new Error('timeout'));
      }, 3000);
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
      sock.on('error', (err) => {
        clearTimeout(timer);
        reject(err);
      });
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
            socket.write(
              JSON.stringify({
                id: req.id,
                ok: true,
                result: { status: 'ok', clients: 0, pendingRequests: 0 },
              }) + '\n',
            );
          } else {
            socket.write(JSON.stringify({ id: req.id, ok: true, result: {} }) + '\n');
          }
        } catch {
          socket.write(
            JSON.stringify({ id: -1, error: { code: 'INVALID_INPUT', message: 'bad frame' } }) +
              '\n',
          );
        }
      });
    });

    const port = await new Promise<number>((resolve) => {
      pingServer.listen(0, '127.0.0.1', () => resolve((pingServer.address() as any).port));
    });

    const sock = net.createConnection({ port, host: '127.0.0.1' });
    sock.setEncoding('utf8');

    const response = await new Promise<any>((resolve, reject) => {
      const timer = setTimeout(() => {
        sock.destroy();
        reject(new Error('timeout'));
      }, 3000);
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
      sock.on('error', (err) => {
        clearTimeout(timer);
        reject(err);
      });
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
          socket.write(
            JSON.stringify({ id: -1, error: { code: 'INVALID_INPUT', message: 'bad frame' } }) +
              '\n',
          );
        }
      });
    });

    const port = await new Promise<number>((resolve) => {
      pingServer.listen(0, '127.0.0.1', () => resolve((pingServer.address() as any).port));
    });

    const sock = net.createConnection({ port, host: '127.0.0.1' });
    sock.setEncoding('utf8');

    const response = await new Promise<any>((resolve, reject) => {
      const timer = setTimeout(() => {
        sock.destroy();
        reject(new Error('timeout'));
      }, 3000);
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
      sock.on('error', (err) => {
        clearTimeout(timer);
        reject(err);
      });
    });

    expect(response).toMatchObject({ id: -1, error: { code: 'INVALID_INPUT' } });
  });
});
