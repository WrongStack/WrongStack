import { render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DebugDashboard } from '../../src/components/DebugDashboard';

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('DebugDashboard codebase index health', () => {
  it('renders detached server health and memory from the system endpoint', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url.includes('/debug/watcher-metrics')) {
          return {
            ok: true,
            headers: { get: () => 'application/json' },
            json: async () => ({
              fileChangesDetected: 0,
              filesProcessed: 0,
              broadcastsSent: 0,
              debounceResets: 0,
              totalDebounceDelayMs: 0,
              activeProjects: 1,
              averageDebounceDelayMs: 0,
              watcherActive: true,
              timestamp: Date.now(),
            }),
          };
        }
        return {
          ok: true,
          json: async () => ({
            pid: 100,
            memoryUsage: { rss: 1, heapUsed: 1, heapTotal: 1, external: 0, arrayBuffers: 0 },
            heapLimit: 100,
            uptime: 10,
            cpuUsage: { user: 0, system: 0 },
            timestamp: Date.now(),
            codebaseIndexServer: {
              status: 'connected',
              connected: true,
              pid: 4242,
              health: {
                status: 'healthy',
                latencyMs: 7,
                missedHeartbeats: 0,
                server: {
                  uptimeMs: 12_000,
                  memory: {
                    rss: 64 * 1024 * 1024,
                    heapUsed: 16 * 1024 * 1024,
                    heapTotal: 32 * 1024 * 1024,
                  },
                  clients: 2,
                  activeRequests: 2,
                  activeWrites: 1,
                  queuedWrites: 3,
                  pendingExternalFiles: 4,
                  watchingExternal: true,
                  watchingClients: 1,
                },
              },
            },
          }),
        };
      }),
    );

    render(<DebugDashboard />);

    await waitFor(() => expect(screen.getByText('Codebase Index Server')).toBeTruthy());
    expect(screen.getByText('healthy')).toBeTruthy();
    expect(screen.getByText('64.0 MB')).toBeTruthy();
    expect(screen.getByText('2 requests')).toBeTruthy();
    expect(screen.getByText('1 owners · 4 pending')).toBeTruthy();
  });
});
