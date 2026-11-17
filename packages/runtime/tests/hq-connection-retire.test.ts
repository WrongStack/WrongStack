import { afterEach, describe, expect, it, vi } from 'vitest';

let kanbanStops = 0;
let nextPublisher: unknown;

vi.mock('@wrongstack/hq', () => ({
  createHqPublisherFromEnv: () => nextPublisher,
  resolveHqConfig: (opts: {
    config?: { url?: string; token?: string };
    appConfig?: { hq?: { url?: string; token?: string } };
  }) => {
    const cfg = opts.config ?? opts.appConfig?.hq;
    const url = cfg?.url;
    if (!url) return undefined;
    return { url, token: cfg?.token ?? '', mode: 'static' };
  },
}));

vi.mock('../src/hq-host/kanban-hq-sync.js', () => ({
  createKanbanHqSync: () => ({
    attachPublisher: async () => {},
    stop: () => {
      kanbanStops++;
    },
    stats: () => ({}),
  }),
}));

vi.mock('../src/hq-host/sage-hq-sync.js', () => ({
  createSageHqSync: () => ({ stop: () => {} }),
}));

const { startHqHostConnection } = await import('../src/hq-host/connection.js');

afterEach(() => {
  vi.useRealTimers();
  kanbanStops = 0;
});

describe('startHqHostConnection retire on reconnect failure', () => {
  it('stops kanbanSync and calls onDisconnect when publisherKey changes and createHqHostPublisher returns undefined', async () => {
    vi.useFakeTimers();
    let currentUrl = 'http://127.0.0.1:4001';
    let disconnects = 0;

    nextPublisher = {
      project: { projectId: 'proj-1' },
      connect: () => {},
      close: () => {},
      refreshEndpoint: () => {},
    };

    const conn = startHqHostConnection({
      projectRoot: process.cwd(),
      ownKanbanSync: true,
      ownSageSync: false,
      retryIntervalMs: 100,
      getAppConfig: () => ({ hq: { enabled: true, url: currentUrl, token: 't1' } }) as never,
      onDisconnect: () => {
        disconnects++;
      },
    });

    try {
      expect(kanbanStops).toBe(0);
      currentUrl = 'http://127.0.0.1:4002';
      nextPublisher = undefined;
      await vi.advanceTimersByTimeAsync(110);

      expect(kanbanStops).toBe(1);
      expect(disconnects).toBe(1);
    } finally {
      conn.stop();
    }
  });
});
