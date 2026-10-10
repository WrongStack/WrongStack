import { render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DebugDashboard } from '../../src/components/DebugDashboard';

afterEach(() => {
  vi.unstubAllGlobals();
});

import { i18n } from '../../src/i18n';

// Minimal /debug/system payload for the watcher-card cases below. Omitting
// codebaseIndexServer/processes keeps the rendered surface small so the
// assertions cannot collide with unrelated text.
const systemPayload = () => ({
  pid: 100,
  memoryUsage: { rss: 1, heapUsed: 1, heapTotal: 1, external: 0, arrayBuffers: 0 },
  heapLimit: 100,
  uptime: 10,
  cpuUsage: { user: 0, system: 0 },
  timestamp: Date.now(),
});

const watcherPayload = {
  fileChangesDetected: 0,
  filesProcessed: 0,
  broadcastsSent: 0,
  debounceResets: 0,
  totalDebounceDelayMs: 0,
  activeProjects: 1,
  averageDebounceDelayMs: 0,
  watcherActive: true,
  timestamp: Date.now(),
};

describe('DebugDashboard codebase index health', () => {
  // Pin the language before rendering: the component renders t()-derived
  // labels, and an unpinned translator can race initialization into raw keys.
  beforeEach(async () => {
    await i18n.changeLanguage('en');
  });
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
    expect(await screen.findByText('healthy')).toBeTruthy();
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

  // Regression guards for the three-state watcher card. A metrics endpoint
  // that never delivers usable JSON is NOT evidence the watcher stopped, but
  // the two-way boolean rendered every one of these as "Stopped" — which is
  // how a stale server build (503), a dev-server HTML response, and an auth
  // failure all became indistinguishable from a dead watcher.
  it('renders the watcher status as unavailable, not stopped, when the metrics endpoint 503s', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        if (String(input).includes('/debug/watcher-metrics')) {
          return {
            ok: false,
            status: 503,
            headers: { get: () => 'application/json' },
            json: async () => ({ error: 'File watcher metrics not available' }),
          };
        }
        return { ok: true, json: async () => systemPayload() };
      }),
    );

    render(<DebugDashboard />);

    // All four File Watcher cards report the unavailable state together.
    await waitFor(() => expect(screen.getAllByText('Unavailable')).toHaveLength(4));
    expect(screen.queryByText('Stopped')).toBeNull();
  });

  it('renders the watcher status as unavailable when the metrics endpoint returns non-JSON', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        if (String(input).includes('/debug/watcher-metrics')) {
          // A Vite dev server answers an unproxied path with index.html: 200
          // but text/html, so `res.ok` alone would have claimed "Running".
          return {
            ok: true,
            headers: { get: () => 'text/html' },
            json: async () => ({}),
          };
        }
        return { ok: true, json: async () => systemPayload() };
      }),
    );

    render(<DebugDashboard />);

    // All four File Watcher cards report the unavailable state together.
    await waitFor(() => expect(screen.getAllByText('Unavailable')).toHaveLength(4));
    expect(screen.queryByText('Stopped')).toBeNull();
  });

  it('still renders the watcher status as stopped when the watcher reports itself inactive', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        if (String(input).includes('/debug/watcher-metrics')) {
          return {
            ok: true,
            headers: { get: () => 'application/json' },
            json: async () => ({ ...watcherPayload, watcherActive: false }),
          };
        }
        return { ok: true, json: async () => systemPayload() };
      }),
    );

    render(<DebugDashboard />);

    await waitFor(() => expect(screen.getByText('Stopped')).toBeTruthy());
    expect(screen.queryByText('Unavailable')).toBeNull();
  });

  // The three numeric cards had the same conflation as the status card: `?? 0`
  // turned a failed fetch into a confident zero, so a 503 rendered as a
  // healthy watcher that happened to have done no work.
  it('renders every File Watcher card as unavailable, not zero, when the metrics endpoint fails', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        if (String(input).includes('/debug/watcher-metrics')) {
          return {
            ok: false,
            status: 503,
            headers: { get: () => 'application/json' },
            json: async () => ({ error: 'File watcher metrics not available' }),
          };
        }
        return { ok: true, json: async () => systemPayload() };
      }),
    );

    render(<DebugDashboard />);

    // All four cards in the File Watcher section share the failure: watcher
    // status, active projects, file changes, files processed.
    await waitFor(() => expect(screen.getAllByText('Unavailable')).toHaveLength(4));
    expect(screen.queryByText('Stopped')).toBeNull();
  });

  it('renders the File Watcher counters with real readings when metrics arrive', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        if (String(input).includes('/debug/watcher-metrics')) {
          return {
            ok: true,
            headers: { get: () => 'application/json' },
            json: async () => ({
              ...watcherPayload,
              activeProjects: 3,
              fileChangesDetected: 42,
              filesProcessed: 7,
            }),
          };
        }
        return { ok: true, json: async () => systemPayload() };
      }),
    );

    render(<DebugDashboard />);

    await waitFor(() => expect(screen.getByText('Running')).toBeTruthy());
    expect(screen.getByText('3')).toBeTruthy();
    expect(screen.getByText('42')).toBeTruthy();
    expect(screen.getByText('7')).toBeTruthy();
    expect(screen.queryByText('Unavailable')).toBeNull();
  });
});
