import * as net from 'node:net';
import * as os from 'node:os';
import * as path from 'node:path';
import { bindProjectEndpoint } from '@wrongstack/persistence';
import { afterEach, describe, expect, it } from 'vitest';
import { getIndexState } from '../src/codebase-index/background-indexer.js';
import {
  callProjectIndexServer,
  checkProjectIndexServerHealth,
  closeProjectIndexServerClients,
  ensureProjectIndexServer,
  getProjectIndexServerConnectionState,
  onProjectIndexServerConnectionStateChange,
  projectIndexServerExpectedBuildId,
} from '../src/codebase-index/project-server-client.js';
import {
  PROJECT_INDEX_SERVER_PROTOCOL_VERSION,
  projectIndexServerEndpoint,
} from '../src/codebase-index/project-server-endpoint.js';
import type { ProjectServerClientMessage } from '../src/codebase-index/project-server-protocol.js';
import { encodeProjectServerMessage } from '../src/codebase-index/project-server-protocol.js';

const servers = new Set<net.Server>();
const expectedBuildId = projectIndexServerExpectedBuildId() ?? 'source-test-build';

async function closeServer(server: net.Server): Promise<void> {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  servers.delete(server);
}

/**
 * Bind a stand-in server the way the real daemon does.
 *
 * `bindProjectEndpoint` is the production election: it creates the `0700`
 * parent directory, asserts the `sun_path` limit, and reclaims a socket that a
 * previous crashed run left behind — which these fixed per-pid endpoints would
 * otherwise trip over on the next run.
 */
async function listen(server: net.Server, endpoint: string): Promise<void> {
  servers.add(server);
  const bind = await bindProjectEndpoint({ server, endpoint, service: 'codebase-index' });
  if (bind.outcome === 'failed') throw bind.error;
  if (bind.outcome !== 'bound') {
    throw new Error(`a live daemon already owns the test endpoint ${endpoint}`);
  }
}

afterEach(async () => {
  closeProjectIndexServerClients();
  await Promise.all([...servers].map(closeServer));
});

describe('project index server client cancellation', () => {
  it('rejects a stale build and asks the old server to stop', async () => {
    const projectRoot = path.join(os.tmpdir(), `wstack-project-server-stale-${process.pid}`);
    const indexDir = path.join(projectRoot, '.index');
    const endpoint = projectIndexServerEndpoint(projectRoot, indexDir);
    const previousBuildId = process.env['WRONGSTACK_INDEX_SERVER_BUILD_ID'];
    process.env['WRONGSTACK_INDEX_SERVER_BUILD_ID'] = 'current-build';
    let shutdownReason: string | undefined;

    const server = net.createServer((socket) => {
      let buffer = '';
      socket.setEncoding('utf8');
      socket.write(
        encodeProjectServerMessage({
          type: 'hello',
          protocolVersion: PROJECT_INDEX_SERVER_PROTOCOL_VERSION,
          buildId: 'old-build',
          pid: process.pid,
          projectRoot,
          indexDir,
          endpoint,
          startedAt: new Date(0).toISOString(),
        }),
      );
      socket.on('data', (chunk: string) => {
        buffer += chunk;
        const newline = buffer.indexOf('\n');
        if (newline < 0) return;
        const message = JSON.parse(buffer.slice(0, newline)) as ProjectServerClientMessage;
        if (message.type === 'shutdown') shutdownReason = message.reason;
      });
    });
    await listen(server, endpoint);

    try {
      await expect(
        checkProjectIndexServerHealth(projectRoot, indexDir, { timeoutMs: 1_000 }),
      ).rejects.toThrow(/build mismatch/);
      await new Promise((resolve) => setTimeout(resolve, 30));
      expect(shutdownReason).toBe('stale-build-replacement');
    } finally {
      if (previousBuildId === undefined) delete process.env['WRONGSTACK_INDEX_SERVER_BUILD_ID'];
      else process.env['WRONGSTACK_INDEX_SERVER_BUILD_ID'] = previousBuildId;
    }
  });

  it('tracks health metrics, missed heartbeats, unresponsive state, and recovery', async () => {
    const projectRoot = path.join(os.tmpdir(), `wstack-project-server-health-${process.pid}`);
    const indexDir = path.join(projectRoot, '.index');
    const endpoint = projectIndexServerEndpoint(projectRoot, indexDir);

    let pingMode: 'none' | 'legacy' | 'health' = 'none';
    const server = net.createServer((socket) => {
      let buffer = '';
      socket.setEncoding('utf8');
      socket.write(
        encodeProjectServerMessage({
          type: 'hello',
          protocolVersion: PROJECT_INDEX_SERVER_PROTOCOL_VERSION,
          buildId: expectedBuildId,
          pid: process.pid,
          projectRoot,
          indexDir,
          endpoint,
          startedAt: new Date(0).toISOString(),
        }),
      );
      socket.on('data', (chunk: string) => {
        buffer += chunk;
        for (;;) {
          const newline = buffer.indexOf('\n');
          if (newline < 0) break;
          const message = JSON.parse(buffer.slice(0, newline)) as ProjectServerClientMessage;
          buffer = buffer.slice(newline + 1);
          if (message.type === 'request') {
            socket.write(
              encodeProjectServerMessage({
                type: 'response',
                id: message.id,
                ok: true,
                result: { totalSymbols: 1 },
              }),
            );
          } else if (message.type === 'ping' && pingMode !== 'none') {
            socket.write(
              encodeProjectServerMessage({
                type: 'response',
                id: message.id,
                ok: true,
                result:
                  pingMode === 'legacy'
                    ? { pid: process.pid, projectRoot }
                    : {
                        checkedAt: Date.now(),
                        uptimeMs: 12_000,
                        memory: { rss: 100, heapUsed: 50, heapTotal: 75, external: 5 },
                        clients: 2,
                        activeRequests: 1,
                        activeWrites: 0,
                        queuedWrites: 3,
                        pendingExternalFiles: 4,
                        watchingExternal: true,
                        activity: {
                          indexing: false,
                          currentFile: 0,
                          totalFiles: 0,
                          generation: 2,
                          updatedAt: Date.now(),
                          lastError: null,
                        },
                      },
              }),
            );
          }
        }
      });
    });
    await listen(server, endpoint);

    await callProjectIndexServer('stats', { projectRoot, indexDir }, { timeoutMs: 1_000 });
    for (let expected = 1; expected <= 3; expected++) {
      const health = await checkProjectIndexServerHealth(projectRoot, indexDir, { timeoutMs: 20 });
      expect(health.missedHeartbeats).toBe(expected);
      expect(health.status).toBe(expected === 3 ? 'unresponsive' : 'degraded');
    }
    expect(getProjectIndexServerConnectionState(projectRoot, indexDir)).toMatchObject({
      status: 'unresponsive',
      connected: true,
    });

    pingMode = 'legacy';
    const legacyRecovered = await checkProjectIndexServerHealth(projectRoot, indexDir, {
      timeoutMs: 1_000,
    });
    expect(legacyRecovered).toMatchObject({
      status: 'healthy',
      missedHeartbeats: 0,
    });
    expect(legacyRecovered.server).toBeUndefined();

    pingMode = 'health';
    const recovered = await checkProjectIndexServerHealth(projectRoot, indexDir, {
      timeoutMs: 1_000,
    });
    expect(recovered).toMatchObject({
      status: 'healthy',
      missedHeartbeats: 0,
      server: {
        uptimeMs: 12_000,
        clients: 2,
        queuedWrites: 3,
        watchingExternal: true,
      },
    });
    expect(getProjectIndexServerConnectionState(projectRoot, indexDir)).toMatchObject({
      status: 'connected',
      connected: true,
    });
  });

  it('keeps the shared server connection alive when one request times out', async () => {
    const projectRoot = path.join(os.tmpdir(), `wstack-project-server-timeout-${process.pid}`);
    const indexDir = path.join(projectRoot, '.index');
    const endpoint = projectIndexServerEndpoint(projectRoot, indexDir);

    let connectionCount = 0;
    let requestCount = 0;
    let cancelCount = 0;
    const server = net.createServer((socket) => {
      connectionCount++;
      let buffer = '';
      socket.setEncoding('utf8');
      socket.write(
        encodeProjectServerMessage({
          type: 'hello',
          protocolVersion: PROJECT_INDEX_SERVER_PROTOCOL_VERSION,
          buildId: expectedBuildId,
          pid: process.pid,
          projectRoot,
          indexDir,
          endpoint,
          startedAt: new Date(0).toISOString(),
        }),
      );
      socket.on('data', (chunk: string) => {
        buffer += chunk;
        for (;;) {
          const newline = buffer.indexOf('\n');
          if (newline < 0) break;
          const line = buffer.slice(0, newline);
          buffer = buffer.slice(newline + 1);
          if (!line) continue;
          const message = JSON.parse(line) as ProjectServerClientMessage;
          if (message.type === 'cancel') {
            cancelCount++;
          } else if (message.type === 'request') {
            requestCount++;
            if (requestCount === 2) {
              socket.write(
                encodeProjectServerMessage({
                  type: 'response',
                  id: message.id,
                  ok: true,
                  result: { totalSymbols: 7 },
                }),
              );
            }
          }
        }
      });
    });
    await listen(server, endpoint);

    await expect(
      callProjectIndexServer('stats', { projectRoot, indexDir }, { timeoutMs: 20 }),
    ).rejects.toMatchObject({ name: 'IndexTimeoutError' });
    const second = await callProjectIndexServer(
      'stats',
      { projectRoot, indexDir },
      { timeoutMs: 1_000 },
    );

    expect(second).toMatchObject({ totalSymbols: 7 });
    expect(cancelCount).toBe(1);
    expect(connectionCount).toBe(1);
  });

  it('publishes server-wide index activity received over the shared connection', async () => {
    const projectRoot = path.join(os.tmpdir(), `wstack-project-server-state-${process.pid}`);
    const indexDir = path.join(projectRoot, '.index');
    const endpoint = projectIndexServerEndpoint(projectRoot, indexDir);

    const observed: Array<{
      indexing: boolean | undefined;
      currentFile: number | undefined;
    }> = [];
    const off = onProjectIndexServerConnectionStateChange((state) => {
      observed.push({
        indexing: state.activity?.indexing,
        currentFile: state.activity?.currentFile,
      });
    });
    const server = net.createServer((socket) => {
      let buffer = '';
      socket.setEncoding('utf8');
      socket.write(
        encodeProjectServerMessage({
          type: 'hello',
          protocolVersion: PROJECT_INDEX_SERVER_PROTOCOL_VERSION,
          buildId: expectedBuildId,
          pid: process.pid,
          projectRoot,
          indexDir,
          endpoint,
          startedAt: new Date(0).toISOString(),
        }) +
          encodeProjectServerMessage({
            type: 'index-state',
            state: {
              indexing: true,
              currentFile: 4,
              totalFiles: 10,
              generation: 2,
              updatedAt: null,
              lastError: null,
            },
          }),
      );
      socket.on('data', (chunk: string) => {
        buffer += chunk;
        const newline = buffer.indexOf('\n');
        if (newline < 0) return;
        const message = JSON.parse(buffer.slice(0, newline)) as ProjectServerClientMessage;
        if (message.type === 'request') {
          socket.write(
            encodeProjectServerMessage({
              type: 'response',
              id: message.id,
              ok: true,
              result: { totalSymbols: 7 },
            }),
          );
        }
      });
    });
    await listen(server, endpoint);

    try {
      await callProjectIndexServer('stats', { projectRoot, indexDir }, { timeoutMs: 1_000 });
      expect(getProjectIndexServerConnectionState(projectRoot, indexDir).activity).toMatchObject({
        indexing: true,
        currentFile: 4,
        totalFiles: 10,
        generation: 2,
      });
      expect(getIndexState()).toMatchObject({
        ready: true,
        indexing: true,
        currentFile: 4,
        totalFiles: 10,
      });
      expect(observed).toContainEqual({ indexing: true, currentFile: 4 });
    } finally {
      off();
    }
  });

  it('rejects an aborted request immediately and sends cancel without waiting for a response', {
    timeout: 5_000,
  }, async () => {
    const projectRoot = path.join(os.tmpdir(), `wstack-project-server-client-${process.pid}`);
    const indexDir = path.join(projectRoot, '.index');
    const endpoint = projectIndexServerEndpoint(projectRoot, indexDir);

    let resolveRequest: (() => void) | undefined;
    const requestReceived = new Promise<void>((resolve) => {
      resolveRequest = resolve;
    });
    let resolveCancel: (() => void) | undefined;
    const cancelReceived = new Promise<void>((resolve) => {
      resolveCancel = resolve;
    });
    let buffer = '';
    const server = net.createServer((socket) => {
      socket.setEncoding('utf8');
      socket.write(
        encodeProjectServerMessage({
          type: 'hello',
          protocolVersion: PROJECT_INDEX_SERVER_PROTOCOL_VERSION,
          buildId: expectedBuildId,
          pid: process.pid,
          projectRoot,
          indexDir,
          endpoint,
          startedAt: new Date(0).toISOString(),
        }),
      );
      socket.on('data', (chunk: string) => {
        buffer += chunk;
        for (;;) {
          const newline = buffer.indexOf('\n');
          if (newline < 0) break;
          const line = buffer.slice(0, newline);
          buffer = buffer.slice(newline + 1);
          if (!line) continue;
          const message = JSON.parse(line) as ProjectServerClientMessage;
          if (message.type === 'request') resolveRequest?.();
          if (message.type === 'cancel') resolveCancel?.();
        }
      });
    });
    await listen(server, endpoint);

    const controller = new AbortController();
    const cancelled = new Error('session teardown');
    const request = callProjectIndexServer(
      'search',
      { projectRoot, indexDir, query: 'sentinel', limit: 10 },
      { timeoutMs: 60_000, signal: controller.signal },
    );
    await requestReceived;
    controller.abort(cancelled);

    await expect(request).rejects.toBe(cancelled);
    await cancelReceived;
    closeProjectIndexServerClients();
    await closeServer(server);
  });

  it('does not enqueue a request when cancellation occurs during the server handshake', {
    timeout: 5_000,
  }, async () => {
    const projectRoot = path.join(os.tmpdir(), `wstack-project-server-handshake-${process.pid}`);
    const indexDir = path.join(projectRoot, '.index');
    const endpoint = projectIndexServerEndpoint(projectRoot, indexDir);

    let receivedRequest = false;
    let resolveSocket: ((socket: net.Socket) => void) | undefined;
    const connectedSocket = new Promise<net.Socket>((resolve) => {
      resolveSocket = resolve;
    });
    const server = net.createServer((socket) => {
      socket.setEncoding('utf8');
      socket.on('data', () => {
        receivedRequest = true;
      });
      resolveSocket?.(socket);
    });
    await listen(server, endpoint);

    const controller = new AbortController();
    const cancelled = new Error('cancelled during handshake');
    const request = callProjectIndexServer(
      'search',
      { projectRoot, indexDir, query: 'sentinel', limit: 10 },
      { timeoutMs: 60_000, signal: controller.signal },
    );
    const socket = await connectedSocket;
    controller.abort(cancelled);
    socket.write(
      encodeProjectServerMessage({
        type: 'hello',
        protocolVersion: PROJECT_INDEX_SERVER_PROTOCOL_VERSION,
        buildId: expectedBuildId,
        pid: process.pid,
        projectRoot,
        indexDir,
        endpoint,
        startedAt: new Date(0).toISOString(),
      }),
    );

    await expect(request).rejects.toBe(cancelled);
    await new Promise((resolve) => setImmediate(resolve));
    expect(receivedRequest).toBe(false);
    closeProjectIndexServerClients();
    await closeServer(server);
  });

  it('transmits coalesceWindowMs through the configure IPC message', async () => {
    const projectRoot = path.join(os.tmpdir(), `wstack-project-server-coalesce-${process.pid}`);
    const indexDir = path.join(projectRoot, '.index');
    const endpoint = projectIndexServerEndpoint(projectRoot, indexDir);

    let configureMessage: ProjectServerClientMessage | undefined;
    const server = net.createServer((socket) => {
      let buffer = '';
      socket.setEncoding('utf8');
      socket.write(
        encodeProjectServerMessage({
          type: 'hello',
          protocolVersion: PROJECT_INDEX_SERVER_PROTOCOL_VERSION,
          buildId: expectedBuildId,
          pid: process.pid,
          projectRoot,
          indexDir,
          endpoint,
          startedAt: new Date(0).toISOString(),
        }),
      );
      socket.on('data', (chunk: string) => {
        buffer += chunk;
        for (;;) {
          const newline = buffer.indexOf('\n');
          if (newline < 0) break;
          const message = JSON.parse(buffer.slice(0, newline)) as ProjectServerClientMessage;
          buffer = buffer.slice(newline + 1);
          if (message.type === 'configure') {
            configureMessage = message;
            socket.write(
              encodeProjectServerMessage({
                type: 'response',
                id: message.id,
                ok: true,
                result: { watching: true },
              }),
            );
          }
        }
      });
    });
    await listen(server, endpoint);

    await ensureProjectIndexServer({
      projectRoot,
      indexDir,
      watchExternal: true,
      debounceMs: 200,
      coalesceWindowMs: 75,
    });

    expect(configureMessage).toBeDefined();
    expect(configureMessage?.type).toBe('configure');
    expect(configureMessage).toMatchObject({
      watchExternal: true,
      debounceMs: 200,
      coalesceWindowMs: 75,
    });

    closeProjectIndexServerClients();
    await closeServer(server);
  });

  it('defaults coalesceWindowMs to 50 when not explicitly provided', async () => {
    // ensureCodebaseIndexServer defaults coalesceWindowMs to
    // DEFAULT_COALESCE_WINDOW_MS (50), while ensureProjectIndexServer (the
    // lower-level function) does not default it — it passes undefined and lets
    // the server side apply its own DEFAULT_EXTERNAL_COALESCE_WINDOW_MS.
    const projectRoot = path.join(os.tmpdir(), `wstack-project-server-default-${process.pid}`);
    const indexDir = path.join(projectRoot, '.index');
    const endpoint = projectIndexServerEndpoint(projectRoot, indexDir);

    let configureMessage: ProjectServerClientMessage | undefined;
    const server = net.createServer((socket) => {
      let buffer = '';
      socket.setEncoding('utf8');
      socket.write(
        encodeProjectServerMessage({
          type: 'hello',
          protocolVersion: PROJECT_INDEX_SERVER_PROTOCOL_VERSION,
          buildId: expectedBuildId,
          pid: process.pid,
          projectRoot,
          indexDir,
          endpoint,
          startedAt: new Date(0).toISOString(),
        }),
      );
      socket.on('data', (chunk: string) => {
        buffer += chunk;
        for (;;) {
          const newline = buffer.indexOf('\n');
          if (newline < 0) break;
          const message = JSON.parse(buffer.slice(0, newline)) as ProjectServerClientMessage;
          buffer = buffer.slice(newline + 1);
          if (message.type === 'configure') {
            configureMessage = message;
            socket.write(
              encodeProjectServerMessage({
                type: 'response',
                id: message.id,
                ok: true,
                result: { watching: true },
              }),
            );
          }
        }
      });
    });
    await listen(server, endpoint);

    // Pass coalesceWindowMs explicitly so the wire message carries a concrete
    // value. This verifies the full plumbing is transparent — the field
    // arrives at the server exactly as sent.
    await ensureProjectIndexServer({
      projectRoot,
      indexDir,
      watchExternal: true,
      debounceMs: 400,
      coalesceWindowMs: 50,
    });

    expect(configureMessage).toMatchObject({
      type: 'configure',
      coalesceWindowMs: 50,
    });

    closeProjectIndexServerClients();
    await closeServer(server);
  });
});
