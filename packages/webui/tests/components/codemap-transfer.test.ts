import { afterEach, describe, expect, it, vi } from 'vitest';
import { fetchCodeMapGraph } from '../../../project-surfaces/src/atlas/fetch-code-map-graph';
import {
  continueGraphTransfer,
  startGraphTransfer,
} from '../../../webui-server/src/server/codemap-transfer';

const { request } = vi.hoisted(() => ({ request: vi.fn() }));
vi.mock('../../../project-surfaces/src/host', () => ({ surfaceFetch: request }));
afterEach(() => request.mockReset());

function wire(graph: object) {
  request.mockImplementation(async (resource: string) => {
    const url = new URL(resource, 'http://local');
    const scope = url.searchParams.get('package') ?? 'packages';
    const reply =
      continueGraphTransfer(scope, url.searchParams) ??
      startGraphTransfer(scope, JSON.stringify(graph), url.searchParams);
    expect(new TextEncoder().encode(reply.body).length).toBeLessThan(2 * 1024 * 1024);
    return {
      ok: reply.status === 200,
      status: reply.status,
      json: async () => JSON.parse(reply.body),
    };
  });
}

describe('CodeMap transfer client with the production server transport', () => {
  it('reassembles a >2 MiB Unicode graph without dropping enrichment or edges', async () => {
    const graph = {
      nodes: [{ id: 'a', label: 'İ🧭'.repeat(400_000), rank: 0.9 }, { id: 'b' }],
      edges: [{ source: 'a', target: 'b', refType: 'call', weight: 3 }],
    };
    wire(graph);
    await expect(
      fetchCodeMapGraph('/api/codemap/files?package=%40wrongstack%2Fcore', 'unavailable'),
    ).resolves.toEqual(graph);
    expect(request.mock.calls.length).toBeGreaterThan(1);
    for (const [url] of request.mock.calls) expect(url).toContain('package=%40wrongstack%2Fcore');
  });

  it('accepts small and legacy graphs in one request', async () => {
    const graph = { nodes: [{ id: 'a' }], edges: [] };
    wire(graph);
    await expect(fetchCodeMapGraph('/api/codemap/packages', 'unavailable')).resolves.toEqual(graph);
    expect(request).toHaveBeenCalledTimes(1);
  });

  it('restarts once on expiration without publishing or mixing a partial graph', async () => {
    const graph = { nodes: [{ id: 'a', label: 'x'.repeat(700_000) }], edges: [] };
    wire(graph);
    const normal = request.getMockImplementation();
    expect(normal).toBeDefined();
    let expired = false;
    request.mockImplementation(async (resource: string) => {
      if (resource.includes('snapshot=') && !expired) {
        expired = true;
        return { ok: false, status: 409, json: async () => ({ code: 'CODEMAP_SNAPSHOT_EXPIRED' }) };
      }
      return normal?.(resource);
    });
    await expect(fetchCodeMapGraph('/api/codemap/packages', 'unavailable')).resolves.toEqual(graph);
    expect(request).toHaveBeenCalledTimes(4);
  });

  it('bounds retries when snapshot retention is exhausted', async () => {
    request.mockResolvedValue({
      ok: false,
      status: 409,
      json: async () => ({
        code: 'CODEMAP_SNAPSHOT_EXPIRED',
        error: 'CodeMap transfer expired — reload the map.',
      }),
    });
    await expect(fetchCodeMapGraph('/api/codemap/packages', 'unavailable')).rejects.toThrow(
      'expired',
    );
    expect(request).toHaveBeenCalledTimes(2);
  });

  it('honors cancellation before requesting another chunk', async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(
      fetchCodeMapGraph('/api/codemap/packages', 'unavailable', controller.signal),
    ).rejects.toThrow();
    expect(request).not.toHaveBeenCalled();
  });

  it('stops a superseded load before the next page', async () => {
    wire({ nodes: [{ id: 'a', label: 'x'.repeat(700_000) }], edges: [] });
    await expect(
      fetchCodeMapGraph(
        '/api/codemap/packages',
        'unavailable',
        undefined,
        () => request.mock.calls.length > 0,
      ),
    ).rejects.toThrow('superseded');
    expect(request).toHaveBeenCalledTimes(1);
  });

  it.each([
    { offset: 1 },
    { totalBytes: 16 * 1024 * 1024 + 1 },
    { nextOffset: 0 },
    { snapshot: '' },
    { chunk: '' },
  ])('rejects corrupt transfer metadata: %j', async (patch) => {
    const reply = JSON.parse(
      startGraphTransfer(
        'scope',
        JSON.stringify({
          nodes: [{ id: 'a', label: 'x'.repeat(700_000) }],
          edges: [],
        }),
        new URLSearchParams({ transfer: 'chunks' }),
      ).body,
    );
    request.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ ...reply, ...patch }),
    });
    await expect(fetchCodeMapGraph('/api/codemap/packages', 'unavailable')).rejects.toThrow(
      'Invalid',
    );
    expect(request).toHaveBeenCalledTimes(1);
  });
});
