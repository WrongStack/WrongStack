/**
 * Serving the Next.js HQ dashboard (`packages/hq-next`), a static export.
 *
 * Its shape differs from the Vite build in four ways the server has to know:
 * one directory per route, content-hashed chunks under `_next/static`, React
 * Server Component payloads (`index.txt`) beside each page, and Next's
 * inline hydration scripts. Those are moved into files at build time
 * (`packages/hq-next/scripts/externalize-inline-scripts.mjs`); the server must
 * never widen HQ's `script-src 'self'` to let one run.
 */
import * as fs from 'node:fs/promises';
import * as http from 'node:http';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { setHqSecurityHeaders } from '../src/hq-server/auth.js';
import { serveHqStatic } from '../src/hq-static-serve.js';

const HYDRATION = 'self.__next_f.push([1,"route"])';

function scriptSrc(csp: string | null): string | undefined {
  return csp
    ?.split(';')
    .map((part) => part.trim())
    .find((part) => part.startsWith('script-src '));
}

describe('serveHqStatic — Next.js static export', () => {
  let distDir: string;
  let server: http.Server;
  let baseUrl: string;

  beforeAll(async () => {
    distDir = await fs.mkdtemp(path.join(os.tmpdir(), 'wrongstack-hq-next-'));
    const write = async (relative: string, body: string): Promise<void> => {
      await fs.mkdir(path.dirname(path.join(distDir, relative)), { recursive: true });
      await fs.writeFile(path.join(distDir, relative), body);
    };
    await write(
      'index.html',
      '<title>Overview</title><script src="/_next/static/chunks/app.js"></script>',
    );
    await write('work/index.html', `<title>Work</title><script>${HYDRATION}</script>`);
    await write('work/index.txt', '0:rsc-payload');
    await write('work/mailbox/index.html', '<title>Mailbox</title>');
    await write('404.html', '<title>Not found</title>');
    await write('work/__next.!KGRlc2sp/work/__PAGE__.txt', '1:segment');
    await write('work/__next.!KGRlc2sp/work/mailbox/__PAGE__.txt', '2:nested-segment');
    await write('work/__next.a/b.txt', 'must-not-serve-malformed-segment');
    await write('_next/static/chunks/app.js', 'next();');

    server = http.createServer(async (req, res) => {
      // The router sets the default security headers before static serving.
      setHqSecurityHeaders(res);
      const url = new URL(req.url ?? '/', 'http://127.0.0.1');
      const result = await serveHqStatic(req, res, url.pathname, distDir);
      if (!result.handled) {
        res.writeHead(599);
        res.end();
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

  it('serves each exported route from its own index.html, with or without the slash', async () => {
    for (const route of ['/work/', '/work']) {
      const response = await fetch(`${baseUrl}${route}`);
      expect(response.status).toBe(200);
      expect(response.headers.get('content-type')).toBe('text/html; charset=utf-8');
      expect(response.headers.get('cache-control')).toBe('no-cache');
      expect(await response.text()).toContain('<title>Work</title>');
    }
    const nested = await fetch(`${baseUrl}/work/mailbox/`);
    expect(await nested.text()).toBe('<title>Mailbox</title>');
  });

  it('answers an unknown route with the export 404 page, not the root page', async () => {
    const response = await fetch(`${baseUrl}/fleet/no-such-route/`);
    expect(response.status).toBe(404);
    expect(await response.text()).toBe('<title>Not found</title>');
  });

  it('revalidates route payloads and caches hashed chunks forever', async () => {
    const payload = await fetch(`${baseUrl}/work/index.txt`);
    expect(payload.headers.get('content-type')).toBe('text/plain; charset=utf-8');
    expect(payload.headers.get('cache-control')).toBe('no-cache');
    expect(await payload.text()).toBe('0:rsc-payload');

    const chunk = await fetch(`${baseUrl}/_next/static/chunks/app.js`);
    expect(chunk.headers.get('cache-control')).toBe('public, max-age=31536000, immutable');
  });

  it('serves segment prefetch payloads from the directory layout the export writes', async () => {
    const response = await fetch(`${baseUrl}/work/__next.!KGRlc2sp.work.__PAGE__.txt?_rsc=abc`);
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('text/plain; charset=utf-8');
    expect(response.headers.get('cache-control')).toBe('no-cache');
    expect(await response.text()).toBe('1:segment');
  });

  it('maps nested segment payload requests through the public static route', async () => {
    const response = await fetch(`${baseUrl}/work/__next.!KGRlc2sp.work.mailbox.__PAGE__.txt`);
    expect(response.status).toBe(200);
    expect(await response.text()).toBe('2:nested-segment');
  });

  it.each(['__next._tree.txt', '__next.a...b.txt', '__next.a..b.txt'])(
    'refuses malformed or non-segment payload mappings (%s)',
    async (name) => {
      const response = await fetch(`${baseUrl}/work/${name}`);
      expect(response.status).toBe(404);
      expect(await response.text()).toBe('<title>Not found</title>');
    },
  );

  it('never widens the CSP — an inline script in served HTML fails closed', async () => {
    // `work/index.html` deliberately still carries an inline script, as an
    // export that skipped the externalize step would.
    for (const route of ['/work/', '/', '/fleet/no-such-route/']) {
      const response = await fetch(`${baseUrl}${route}`);
      const csp = response.headers.get('content-security-policy') ?? '';
      expect(scriptSrc(csp)).toBe("script-src 'self' 'wasm-unsafe-eval'");
      expect(scriptSrc(csp)).not.toMatch(/'sha256-|'nonce-|'unsafe-inline'/);
    }
  });
});
