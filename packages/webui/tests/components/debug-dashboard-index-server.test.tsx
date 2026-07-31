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
            processes: [
              {
                pid: 777,
                surface: 'tui',
                ts: '2026-07-31T00:00:00.000Z',
                memory: {
                  rss: 512 * 1024 * 1024,
                  heapUsed: 220 * 1024 * 1024,
                  heapTotal: 300 * 1024 * 1024,
                  retainedHeapUsed: 180 * 1024 * 1024,
                },
                signal: 'js-retention',
                heapGrowthBytesPerHour: 12 * 1024 * 1024,
                rssGrowthBytesPerHour: -4 * 1024 * 1024,
                workload: {
                  messages: 117,
                  historyEntries: 208,
                  historyMountedEntries: 17,
                  appRenders: 21_618,
                  metricsDroppedObservations: 7,
                },
                resources: {
                  active: 35,
                  types: 'Timeout=14,PipeWrap=8',
                },
                hqQueue: {
                  entries: 1,
                  bytes: 4096,
                  maxBytes: 16 * 1024 * 1024,
                  droppedFrames: 2,
                  droppedBytes: 8192,
                  coalescedFrames: 42,
                  coalescedBytes: 1024 * 1024,
                },
                hqSnapshot: {
                  inFlight: true,
                  pending: true,
                  timerScheduled: false,
                },
              },
            ],
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
    expect(screen.getByText('Live WrongStack Processes')).toBeTruthy();
    expect(screen.getByText('PID 777')).toBeTruthy();
    expect(screen.getByText(/17\/208 history mounted/u)).toBeTruthy();
    expect(screen.getByText(/7 metric drops/u)).toBeTruthy();
    expect(screen.getByText('42 coalesced · 2 dropped')).toBeTruthy();
    expect(screen.getByText('snapshot in-flight')).toBeTruthy();
  });
});
