import { mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setBrowserPrivateOrigin } from '@wrongstack/browser-tools/policy';
import type { Context } from '@wrongstack/core/agent';
import { describe, expect, it, vi } from 'vitest';
import { fetchTool } from '../src/fetch.js';
import { readUrlContentTool } from '../src/read-url-content.js';

describe('shared development origin allowance', () => {
  it('allows both HTTP reader tools for one approved origin and immediately revokes it', async () => {
    const root = await mkdtemp(join(tmpdir(), 'wstack-net-origin-'));
    vi.stubEnv('WRONGSTACK_HOME', join(root, 'home'));
    vi.stubEnv('WRONGSTACK_BROWSER_PRIVATE_ORIGINS', '');
    let otherRequests = 0;
    const other = createServer((_request, response) => {
      otherRequests++;
      response.end('other origin');
    });
    await new Promise<void>((resolve) => other.listen(0, '127.0.0.1', resolve));
    const otherOrigin = `http://127.0.0.1:${(other.address() as AddressInfo).port}`;
    const server = createServer((request, response) => {
      if (request.url === '/redirect') {
        response.writeHead(302, { location: otherOrigin });
        response.end();
        return;
      }
      response.setHeader('content-type', 'text/plain');
      response.end('local development content');
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const ctx = { cwd: root, projectRoot: root } as Context;
    const opts = { signal: new AbortController().signal };
    try {
      await expect(fetchTool.execute({ url: origin }, ctx, opts)).rejects.toThrow('/network allow');
      await setBrowserPrivateOrigin(root, origin, true);
      expect(
        (await fetchTool.execute({ url: origin, format: 'text' }, ctx, opts)).content,
      ).toContain('local development content');
      expect((await readUrlContentTool.execute({ url: origin }, ctx, opts)).content).toContain(
        'local development content',
      );
      await expect(fetchTool.execute({ url: `${origin}/redirect` }, ctx, opts)).rejects.toThrow(
        `/network allow ${otherOrigin}`,
      );
      expect(otherRequests).toBe(0);
      await setBrowserPrivateOrigin(root, origin, false);
      await expect(fetchTool.execute({ url: origin }, ctx, opts)).rejects.toThrow('/network allow');
      await expect(readUrlContentTool.execute({ url: origin }, ctx, opts)).rejects.toThrow(
        '/network allow',
      );
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      other.closeAllConnections();
      await new Promise<void>((resolve) => other.close(() => resolve()));
      vi.unstubAllEnvs();
      await rm(root, { recursive: true, force: true });
    }
  });
});
