import * as fs from 'node:fs/promises';
import type { AddressInfo } from 'node:net';
import * as os from 'node:os';
import * as path from 'node:path';
import { SqliteMemoryPort } from '@wrongstack/sage';
import { afterEach, describe, expect, it } from 'vitest';
import { startWebuiHttpBridge } from '../../src/webui-server/http-bridge.js';

/**
 * The Memory Manager's ranked search and search links are HTTP routes
 * (`/api/memory/search-page`, `/api/memory/resolve/:id`). They read the host's
 * memory store through `getMemoryStore`, which the CLI host never passed to the
 * HTTP server, so both answered 503 on every real host. This boots the real
 * CLI bridge over a real SQLite store.
 */
describe('CLI WebUI host: ranked memory search routes', () => {
  const cleanups: Array<() => Promise<unknown> | unknown> = [];
  afterEach(async () => {
    while (cleanups.length > 0) await cleanups.pop()?.();
  });

  it('serves search pages and search links from the host memory store, without session rows', async () => {
    const projectRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'webui-memory-search-'));
    cleanups.push(() => fs.rm(projectRoot, { recursive: true, force: true }));
    const store = new SqliteMemoryPort({ projectRoot });
    await store.initialize();
    cleanups.push(() => store.close());

    const shared = await store.rememberSage({
      text: 'Harbor lantern: the demo service listens on port 8080.',
      kind: 'fact',
    });
    const owned = await store.rememberSage({
      text: 'Harbor lantern scratch: the reviewer is pinned to port 9292.',
      kind: 'fact',
      scope: 'session',
      ownerSessionId: 'session-other',
    });

    // The HTTP server only starts when a frontend dist is present.
    const distDir = path.join(projectRoot, 'dist');
    await fs.mkdir(distDir);
    await fs.writeFile(path.join(distDir, 'index.html'), '<!doctype html><title>t</title>');

    const token = 'memory-search-token';
    const bridge = await startWebuiHttpBridge({
      opts: {
        agent: { ctx: { meta: {} } },
        frontendDistDir: distDir,
        memoryStore: store,
      } as never,
      surface: 'webui',
      host: '127.0.0.1',
      httpPort: 0,
      strictPort: false,
      globalRoot: path.join(projectRoot, 'global'),
      wsToken: token,
      publicUrl: undefined,
      publicWsUrl: undefined,
      requireToken: true,
      getSessionAgents: () => undefined,
      onFleetPing: () => undefined,
      broadcast: () => undefined,
      onPortRebound: () => undefined,
    });
    cleanups.push(() => new Promise<void>((resolve) => bridge.wss.close(() => resolve())));
    const handle = bridge.httpServer;
    expect(handle).not.toBeNull();
    if (!handle) return;
    cleanups.push(() => new Promise<void>((resolve) => handle.server.close(() => resolve())));
    cleanups.push(
      () =>
        new Promise<void>((resolve) =>
          bridge.ipv6LoopbackServer ? bridge.ipv6LoopbackServer.close(() => resolve()) : resolve(),
        ),
    );
    const { port } = handle.server.address() as AddressInfo;
    const get = async (route: string) => {
      const response = await fetch(`http://127.0.0.1:${port}${route}`, {
        headers: { 'x-ws-token': token },
      });
      return { status: response.status, text: await response.text() };
    };

    const page = await get('/api/memory/search-page?q=harbor%20lantern&limit=20');
    expect(page.status).toBe(200);
    const body = JSON.parse(page.text) as { hits: Array<{ id: string }>; totalCandidates: number };
    expect(body.hits.map((hit) => hit.id)).toEqual([shared.id]);
    expect(body.totalCandidates).toBe(1);
    expect(page.text).not.toContain(owned.id);

    const visible = await get(`/api/memory/resolve/${shared.id}`);
    expect(visible.status).toBe(200);
    expect(JSON.parse(visible.text)).toMatchObject({ memory: { id: shared.id } });

    // Hidden and nonexistent ids answer identically.
    const absent = await get('/api/memory/resolve/01HZZZZZZZZZZZZZZZZZZZZZZZ');
    expect(absent.status).toBe(404);
    expect(await get(`/api/memory/resolve/${owned.id}`)).toEqual(absent);
  });
});
