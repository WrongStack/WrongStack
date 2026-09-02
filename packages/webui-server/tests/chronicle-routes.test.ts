import type { ChronicleProjectAccess } from '@wrongstack/core/chronicle';
import { describe, expect, it, vi } from 'vitest';
import type { WebSocket } from 'ws';
import {
  type ChronicleRouteContext,
  handleChronicleRoute,
} from '../src/server/chronicle-routes.js';
import type { WSServerMessage } from '../src/server/types.js';

function harness() {
  const sent: WSServerMessage[] = [];
  const call = vi.fn(async (operation: string, args: unknown) => {
    switch (operation) {
      case 'ping':
        return {
          protocolVersion: 1,
          pid: 42,
          projectRoot: '/proj',
          projectDir: '/state/proj',
          chronicleDirectory: '/state/proj/chronicle',
          endpoint: '/state/proj/chronicle.sock',
          startedAt: '2026-07-27T00:00:00.000Z',
          checkedAt: 1,
          uptimeMs: 1_000,
          clients: 2,
          activeRequests: 1,
          journal: { pendingEvents: 0, rejectedEvents: 0, largestBatch: 2 },
          watcher: { active: true, watchedFiles: 5 },
          memory: { rss: 1, heapUsed: 1, heapTotal: 2, external: 0 },
        };
      case 'query':
        return {
          events: [],
          total: 0,
          scannedEvents: 0,
          sourceFiles: 1,
          invalidLines: 0,
          summary: {},
          query: args,
        };
      case 'facet':
        return {
          values: [{ value: 'tool', count: 2 }],
          diagnostics: { sourceFiles: 1, invalidLines: 0 },
        };
      case 'facets':
        return {
          values: { eventType: [{ value: 'tool', count: 2 }] },
          diagnostics: { sourceFiles: 1, invalidLines: 0 },
        };
      case 'graph':
        return { nodes: [], edges: [], truncated: false };
      case 'metrics':
        return {
          refreshed: {
            ingestedEvents: 3,
            ingestedBytes: 42,
            sourceFiles: 1,
            invalidLines: 0,
          },
          data: [],
        };
      default:
        throw new Error(`Unexpected operation: ${operation}`);
    }
  });
  const access = {
    mode: 'server',
    call: call as unknown as ChronicleProjectAccess['call'],
  } satisfies Pick<ChronicleProjectAccess, 'mode' | 'call'>;
  const context = {
    getProjectRoot: () => '/proj',
    send: (_ws, message) => sent.push(message),
    getChronicleAccess: () => access,
  } satisfies ChronicleRouteContext;
  return { context, call, sent };
}

describe('canonical Chronicle handler family', () => {
  it('routes query, facet, facets, and graph through one project access gateway', async () => {
    const { context, call } = harness();
    const ws = {} as WebSocket;
    expect(await handleChronicleRoute(context, ws, { type: 'chronicle.query' })).toBe(true);
    expect(
      await handleChronicleRoute(context, ws, {
        type: 'chronicle.facet',
        payload: { field: 'eventType' },
      }),
    ).toBe(true);
    expect(
      await handleChronicleRoute(context, ws, {
        type: 'chronicle.facets',
        payload: { fields: ['eventType'] },
      }),
    ).toBe(true);
    expect(await handleChronicleRoute(context, ws, { type: 'chronicle.graph' })).toBe(true);
    expect(call.mock.calls.map(([operation]) => operation)).toEqual([
      'query',
      'facet',
      'facets',
      'graph',
    ]);
  });

  it('serves derived metrics views through the project owner', async () => {
    const { context, call, sent } = harness();
    const ws = {} as WebSocket;
    expect(await handleChronicleRoute(context, ws, { type: 'chronicle.metrics' })).toBe(true);
    expect(call).toHaveBeenLastCalledWith('metrics', { view: 'summary' });
    expect(sent.at(-1)).toMatchObject({
      type: 'chronicle.metrics_result',
      payload: { view: 'summary', refreshed: { ingestedEvents: 3 } },
    });

    await handleChronicleRoute(context, ws, {
      type: 'chronicle.metrics',
      payload: { view: 'files', path: 'src/app.ts', limit: 5 },
    });
    expect(call).toHaveBeenLastCalledWith('metrics', {
      view: 'files',
      files: { path: 'src/app.ts', limit: 5 },
    });

    await handleChronicleRoute(context, ws, {
      type: 'chronicle.metrics',
      payload: { view: 'providers', from: '2026-07-01' },
    });
    expect(call).toHaveBeenLastCalledWith('metrics', {
      view: 'providers',
      providers: { from: '2026-07-01' },
    });
  });

  it('reports the authoritative collector, processor, storage, and serving path', async () => {
    const { context, call, sent } = harness();
    const ws = {} as WebSocket;

    expect(await handleChronicleRoute(context, ws, { type: 'chronicle.status' })).toBe(true);
    expect(call).toHaveBeenCalledWith('ping', {});
    expect(sent.at(-1)).toMatchObject({
      type: 'chronicle.status_result',
      payload: {
        mode: 'server',
        pid: 42,
        chronicleDirectory: '/state/proj/chronicle',
        pipeline: {
          collection: 'session-event-adapters',
          processing: 'project-chronicle-server',
          serving: 'webui-server',
        },
      },
    });
  });

  it('surfaces gateway failures as chronicle.error instead of crashing', async () => {
    const { context, call, sent } = harness();
    call.mockRejectedValueOnce(new Error('node:sqlite unavailable'));
    const ws = {} as WebSocket;
    expect(await handleChronicleRoute(context, ws, { type: 'chronicle.metrics' })).toBe(true);
    expect(sent.at(-1)).toEqual({
      type: 'chronicle.error',
      payload: { message: 'node:sqlite unavailable' },
    });
  });

  it('surfaces query gateway creation failures as chronicle.error instead of rejecting', {
    timeout: 5_000,
  }, async () => {
    const { context, sent } = harness();
    const ws = {} as WebSocket;
    const failingContext: ChronicleRouteContext = {
      ...context,
      getChronicleAccess: () => {
        throw new Error('chronicle daemon unavailable');
      },
    };

    expect(await handleChronicleRoute(failingContext, ws, { type: 'chronicle.query' })).toBe(true);
    expect(sent.at(-1)).toEqual({
      type: 'chronicle.error',
      payload: { message: 'chronicle daemon unavailable' },
    });
  });

  it('returns canonical validation errors and declines foreign messages', async () => {
    const { context, call, sent } = harness();
    const ws = {} as WebSocket;
    expect(
      await handleChronicleRoute(context, ws, {
        type: 'chronicle.facet',
        payload: { field: 'not-a-facet' },
      }),
    ).toBe(true);
    expect(sent.at(-1)).toEqual({
      type: 'chronicle.error',
      payload: { message: 'Invalid Chronicle facet field.' },
    });
    expect(call).not.toHaveBeenCalled();
    expect(await handleChronicleRoute(context, ws, { type: 'test.foreign' })).toBe(false);
  });
});
