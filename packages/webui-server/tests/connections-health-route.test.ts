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
