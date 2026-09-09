import * as fs from 'node:fs/promises';
import * as http from 'node:http';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { serveHqStatic } from '../src/hq-static-serve.js';

describe('serveHqStatic', () => {
  let distDir: string;
  let server: http.Server;
  let baseUrl: string;

  beforeAll(async () => {
    distDir = await fs.mkdtemp(path.join(os.tmpdir(), 'wrongstack-hq-static-'));
    await fs.mkdir(path.join(distDir, 'assets'));
    await fs.writeFile(path.join(distDir, 'index.html'), '<!doctype html><title>HQ</title>');
    await fs.writeFile(path.join(distDir, 'assets', 'app.js'), 'console.log("hq");');
    await fs.writeFile(path.join(distDir, 'manifest.webmanifest'), '{"start_url":"/mobile"}');

    server = http.createServer(async (req, res) => {
      const url = new URL(req.url ?? '/', 'http://127.0.0.1');
      const result = await serveHqStatic(req, res, url.pathname, distDir);
      if (!result.handled) {
        res.writeHead(404);
        res.end('Not found');
      }
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Server did not bind');
    baseUrl = `http://127.0.0.1:${address.port}`;
  });

  afterAll(async () => {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
    await fs.rm(distDir, { recursive: true, force: true });
  });

  it('serves hashed assets with immutable browser caching', async () => {
    const response = await fetch(`${baseUrl}/assets/app.js`);

    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('application/javascript; charset=utf-8');
    expect(response.headers.get('cache-control')).toBe('public, max-age=31536000, immutable');
    expect(Number(response.headers.get('content-length'))).toBeGreaterThan(0);
    expect(await response.text()).toBe('console.log("hq");');
  });

  it('serves the mobile manifest with the installable-app MIME type', async () => {
    const response = await fetch(`${baseUrl}/manifest.webmanifest`);

    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('application/manifest+json; charset=utf-8');
    expect(await response.json()).toEqual({ start_url: '/mobile' });
  });

  it('serves the SPA fallback without caching HTML', async () => {
    const response = await fetch(`${baseUrl}/fleet/session-1`);

    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('text/html; charset=utf-8');
    expect(response.headers.get('cache-control')).toBe('no-cache');
    expect(await response.text()).toContain('<title>HQ</title>');
  });

  it('rejects decoded paths that escape the dist directory', async () => {
    const request = { url: '/' } as http.IncomingMessage;
    const response = {} as http.ServerResponse;

    await expect(
      serveHqStatic(request, response, '/%2e%2e/%2e%2e/secret.txt', distDir),
    ).resolves.toEqual({ handled: false });
  });

  it('returns unhandled for malformed percent encoding', async () => {
    const request = { url: '/' } as http.IncomingMessage;
    const response = {} as http.ServerResponse;

    await expect(serveHqStatic(request, response, '/bad%', distDir)).resolves.toEqual({
      handled: false,
    });
  });
});
