import { mkdtempSync, rmSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

const handleCodemapPackages = vi.hoisted(() =>
  vi.fn(async (res: import('node:http').ServerResponse, _deps: unknown) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ marker: 'codemap-packages' }));
  }),
);

vi.mock('../src/server/codemap-handlers.js', () => ({
  handleCodemapFiles: vi.fn(),
  handleCodemapPackages,
  handleCodemapSymbols: vi.fn(),
}));

import { type StaticServeHandle, startStaticServe } from '../src/server/frontend-static-serve.js';

/**
 * End-to-end proof of the indexDir chain on the CLI-embedded host:
 * `startStaticServe` → `createHttpServer` → `handleApiRoutes` →
 * `handleCodemapPackages`, over a real socket. The router side alone is pinned
 * in api-router.gaps.test.ts; this closes the gap where the host silently
 * dropped the option before it ever reached the router.
 */
describe('startStaticServe real HTTP → /api/codemap/packages', () => {
  let handle: StaticServeHandle | null = null;
  let distDir: string | null = null;

  afterEach(async () => {
    if (handle) {
      const { server } = handle;
      await new Promise<void>((resolve) => server.close(() => resolve()));
      handle = null;
    }
    if (distDir) rmSync(distDir, { recursive: true, force: true });
    distDir = null;
  });

  it('delivers the indexDir given to startStaticServe to handleCodemapPackages', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'ws-static-serve-'));
    distDir = dir;
    const projectRoot = path.join(dir, 'project');
    const indexDir = path.join(dir, 'custom-index');

    handle = await startStaticServe(
      {
        host: '127.0.0.1',
        httpPort: 0,
        globalRoot: path.join(dir, '.wrongstack'),
        projectRoot,
        indexDir,
        deferListen: false,
      },
      { resolveDist: () => dir },
    );
    expect(handle).not.toBeNull();
    const { port } = handle!.server.address() as AddressInfo;

    const res = await fetch(`http://127.0.0.1:${port}/api/codemap/packages`);

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ marker: 'codemap-packages' });
    expect(handleCodemapPackages).toHaveBeenCalledTimes(1);
    expect(handleCodemapPackages).toHaveBeenCalledWith(
      expect.anything(),
      {
        projectRoot,
        indexDir,
      },
      new URLSearchParams(),
    );
  });
});
