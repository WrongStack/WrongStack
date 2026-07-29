import { describe, expect, it, vi } from 'vitest';
import type { WebSocket } from 'ws';
import {
  type ConnectionsHealthReport,
  handleConnectionsHealthRoute,
} from '../src/server/connections-health-route.js';
import type { WSServerMessage } from '../src/server/types.js';

const report: ConnectionsHealthReport = {
  checkedAt: 1,
  overall: 'healthy',
  backend: 'cli-embedded',
  projectRoot: '/project',
  services: [
    {
      id: 'webui',
      label: 'WebUI transport',
      status: 'healthy',
      required: true,
      mode: 'cli-embedded',
      detail: 'connected',
      ownerPid: 42,
    },
    {
      id: 'chronicle',
      label: 'Chronicle telemetry',
      status: 'healthy',
      required: true,
      mode: 'server',
      detail: 'one owner',
      ownerPid: 43,
      clients: 2,
      queuedWork: 0,
      watcher: { active: true, watchedFiles: 12 },
    },
  ],
};

describe('connections health route', () => {
  it('returns one normalized project-service report', async () => {
    const sent: WSServerMessage[] = [];
    const collect = vi.fn(async () => report);
    const handled = await handleConnectionsHealthRoute(
      {
        getProjectRoot: () => '/project',
        getIndexDir: () => undefined,
        backend: 'cli-embedded',
        collect,
        send: (_ws, message) => sent.push(message),
      },
      {} as WebSocket,
      { type: 'connections.health' },
    );

    expect(handled).toBe(true);
    expect(collect).toHaveBeenCalledOnce();
    expect(sent).toEqual([{ type: 'connections.health_result', payload: report }]);
  });

  it('surfaces collection failures without terminating the WebSocket route', async () => {
    const sent: WSServerMessage[] = [];
    const handled = await handleConnectionsHealthRoute(
      {
        getProjectRoot: () => '/project',
        getIndexDir: () => undefined,
        backend: 'standalone',
        collect: async () => {
          throw new Error('health probe failed');
        },
        send: (_ws, message) => sent.push(message),
      },
      {} as WebSocket,
      { type: 'connections.health' },
    );

    expect(handled).toBe(true);
    expect(sent).toEqual([
      { type: 'connections.health_error', payload: { message: 'health probe failed' } },
    ]);
  });

  it('declines unrelated messages', async () => {
    expect(
      await handleConnectionsHealthRoute(
        {
          getProjectRoot: () => '/project',
          getIndexDir: () => undefined,
          backend: 'standalone',
          send: vi.fn(),
        },
        {} as WebSocket,
        { type: 'chronicle.status' },
      ),
    ).toBe(false);
  });
});

describe('connections health kanban service', () => {
  it('reports a healthy kanban IPC row when ping returns the project-server status', async () => {
    vi.resetModules();
    const ping = vi.fn(async () => ({
      protocolVersion: 2,
      pid: 9001,
      projectRoot: '/project',
      endpoint: '\\\\.\\pipe\\wrongstack-kanban-v2-deadbeef',
      storage: 'sqlite' as const,
      databasePath: '/project/.wrongstack/kanbans/_kanban.sqlite',
      startedAt: new Date(Date.now() - 12_000).toISOString(),
      clients: 3,
      pendingRequests: 0,
    }));
    const getKanbanServerConnection = vi.fn(async () => ({
      request: (_method: string, _params: unknown, _opts?: unknown) => ping(),
    }));
    const getKanbanDir = vi.fn((root: string) => `${root}/.wrongstack/kanbans`);
    vi.doMock('@wrongstack/kanban', () => ({
      getKanbanServerConnection,
      getKanbanDir,
    }));
    const { collectConnectionsHealth: collectFresh } = await import(
      '../src/server/connections-health-route.js'
    );
    const fresh = await collectFresh({
      projectRoot: '/project',
      indexDir: undefined,
      backend: 'cli-embedded',
    });
    const kanban = fresh.services.find((service) => service.id === 'kanban');
    expect(kanban).toBeDefined();
    expect(kanban).toMatchObject({
      id: 'kanban',
      label: 'Kanban IPC',
      status: 'healthy',
      required: true,
      mode: 'project-server',
      ownerPid: 9001,
      clients: 3,
      activeRequests: 0,
      storage: '/project/.wrongstack/kanbans/_kanban.sqlite',
    });
    expect(typeof kanban?.latencyMs).toBe('number');
    expect(typeof kanban?.uptimeMs).toBe('number');
    expect((kanban?.uptimeMs ?? -1) >= 0).toBe(true);
  });

  it('reports an error row when the kanban daemon ping rejects', async () => {
    vi.resetModules();
    const getKanbanServerConnection = vi.fn(async () => ({
      request: () => Promise.reject(new Error('boom')),
    }));
    const getKanbanDir = vi.fn((root: string) => `${root}/.wrongstack/kanbans`);
    vi.doMock('@wrongstack/kanban', () => ({
      getKanbanServerConnection,
      getKanbanDir,
    }));
    const { collectConnectionsHealth: collectFresh } = await import(
      '../src/server/connections-health-route.js'
    );
    const fresh = await collectFresh({
      projectRoot: '/project',
      indexDir: undefined,
      backend: 'cli-embedded',
    });
    const kanban = fresh.services.find((service) => service.id === 'kanban');
    expect(kanban).toMatchObject({
      id: 'kanban',
      status: 'error',
      required: true,
      mode: 'project-server',
    });
    expect(kanban?.lastError).toBe('boom');
  });
});

describe('connections health mailbox service', () => {
  /**
   * Stand up the route over a fake mailbox client and hand back what the
   * constructor was actually given.
   */
  async function collectWithFakeMailbox(status: unknown) {
    vi.resetModules();
    const constructedWith: string[] = [];
    class FakeMailboxConnection {
      constructor(projectDir: string) {
        constructedWith.push(projectDir);
      }
      probeStatus() {
        return Promise.resolve(status);
      }
      getState() {
        return { endpoint: '\\\\.\\pipe\\fake' };
      }
      close() {}
    }
    vi.doMock('@wrongstack/core/coordination', () => ({
      isMailboxProjectServerAvailable: () => true,
      MailboxProjectServerConnection: FakeMailboxConnection,
    }));
    const { collectConnectionsHealth: collectFresh } = await import(
      '../src/server/connections-health-route.js'
    );
    const fresh = await collectFresh({
      projectRoot: '/project',
      indexDir: undefined,
      backend: 'cli-embedded',
    });
    return {
      mailbox: fresh.services.find((service) => service.id === 'mailbox'),
      constructedWith,
    };
  }

  /**
   * The bug this pins: SAGE and kanban are keyed on the repo root, the mailbox
   * owner on its data directory. Passing the root derived a different pipe
   * name than the running daemon, so `probeStatus()` saw nothing and a healthy
   * owner with live clients was reported as "sleeping" on every refresh.
   */
  it('probes the mailbox owner on the project data directory, not the repo root', async () => {
    const { resolveWstackPaths } = await import('@wrongstack/core/utils');
    const { constructedWith } = await collectWithFakeMailbox(null);

    expect(constructedWith).toEqual([resolveWstackPaths({ projectRoot: '/project' }).projectDir]);
    expect(constructedWith[0]).not.toBe('/project');
  });

  it('reports a healthy mailbox row when the owner answers with its status', async () => {
    const { mailbox } = await collectWithFakeMailbox({
      protocolVersion: 3,
      pid: 105348,
      endpoint: '\\\\.\\pipe\\wrongstack-mailbox-v3-abc',
      databasePath: '/data/_mailbox.sqlite',
      startedAt: new Date(Date.now() - 5_000).toISOString(),
      clients: 9,
      pendingRequests: 0,
    });

    expect(mailbox).toMatchObject({
      id: 'mailbox',
      status: 'healthy',
      required: true,
      mode: 'project-server',
      ownerPid: 105348,
      clients: 9,
      storage: '/data/_mailbox.sqlite',
    });
  });

  it('reports sleeping only when no owner answers', async () => {
    const { mailbox } = await collectWithFakeMailbox(null);
    expect(mailbox).toMatchObject({ id: 'mailbox', status: 'offline' });
  });
});
