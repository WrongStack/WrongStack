import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, expect, it, vi } from 'vitest';

const { packageGraphService } = vi.hoisted(() => ({ packageGraphService: vi.fn() }));
vi.mock('@wrongstack/tools', () => ({ packageGraphService }));
vi.mock('../src/server/codemap-cache.js', () => ({
  codemapCacheKey: (root: string, dir: string | undefined, scope: string) =>
    JSON.stringify([root, dir, scope]),
  indexDbVersion: () => 'test-generation',
  getCachedCodemapBody: () => undefined,
  setCachedCodemapBody: () => undefined,
}));

import { handleCodemapPackages } from '../src/server/codemap-handlers.js';

let server: ReturnType<typeof createServer> | undefined;
afterEach(async () => {
  if (server)
    await new Promise<void>((resolve, reject) =>
      server?.close((error) => (error ? reject(error) : resolve())),
    );
  server = undefined;
});

it('serves a >2 MiB graph over real bounded HTTP responses from one immutable snapshot', async () => {
  const graph = {
    nodes: [{ id: 'a', concept: 'İ🧭'.repeat(400_000) }, { id: 'b' }],
    edges: [{ source: 'a', target: 'b', weight: 5, refType: 'import' }],
  };
  packageGraphService.mockResolvedValueOnce(graph);
  server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    void handleCodemapPackages(res, { projectRoot: '/project' }, url.searchParams);
  });
  await new Promise<void>((resolve) => server?.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/codemap/packages`;
  let query = new URLSearchParams({ transfer: 'chunks' });
  const chunks: Buffer[] = [];
  for (let i = 0; i < 32; i++) {
    const response = await fetch(`${base}?${query}`, { signal: AbortSignal.timeout(5000) });
    expect(response.status).toBe(200);
    const text = await response.text();
    expect(Buffer.byteLength(text)).toBeLessThan(2 * 1024 * 1024);
    const page = JSON.parse(text);
    chunks.push(Buffer.from(page.chunk, 'base64'));
    if (page.nextOffset === null) break;
    query = new URLSearchParams({
      transfer: 'chunks',
      snapshot: page.snapshot,
      offset: String(page.nextOffset),
    });
  }
  expect(JSON.parse(Buffer.concat(chunks).toString('utf8'))).toEqual(graph);
  expect(packageGraphService).toHaveBeenCalledTimes(1);
});
