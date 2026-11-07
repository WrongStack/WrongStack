import * as fs from 'node:fs/promises';
import * as http from 'node:http';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { browserPrivateOrigins } from '../src/browser/policy.js';
import { withServedProjectFile } from '../src/design-reference-serve.js';

let root: string;
beforeAll(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'ws-serve-'));
  await fs.mkdir(path.join(root, 'site', 'assets'), { recursive: true });
  await fs.mkdir(path.join(root, '.git'));
  await fs.writeFile(path.join(root, 'site', 'index.html'), '<link href="assets/a.css">');
  await fs.writeFile(path.join(root, 'site', 'assets', 'a.css'), 'body{}');
  await fs.writeFile(path.join(root, '.env'), 'TOKEN=secret');
  await fs.writeFile(path.join(root, '.git', 'config'), '[core]');
  await fs.writeFile(path.join(root, 'credentials.json'), '{"key":"secret"}');
  await fs.writeFile(path.join(root, 'notes.txt'), 'secret');
});
afterAll(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

function get(url: string, host?: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const req = http.request(
      { hostname: u.hostname, port: u.port, path: u.pathname, headers: host ? { host } : {} },
      (res) => {
        res.resume();
        resolve(res.statusCode ?? 0);
      },
    );
    req.on('error', reject);
    req.end();
  });
}

describe('withServedProjectFile', () => {
  it('serves the page and its assets, nothing a page could exfiltrate', async () => {
    await withServedProjectFile(root, 'site/index.html', async (url) => {
      const origin = new URL(url).origin;
      expect(new URL(url).pathname).toBe('/site/index.html');
      expect(await get(url)).toBe(200);
      expect(await get(`${origin}/site/assets/a.css`)).toBe(200);
      for (const p of [
        '/.env',
        '/.git/config',
        '/credentials.json',
        '/notes.txt',
        '/site/%2e%2e/.env',
      ]) {
        expect(await get(`${origin}${p}`), p).toBe(404);
      }
      // Another Host (DNS rebinding, a proxy rewrite) gets nothing.
      expect(await get(url, 'evil.example')).toBe(404);
    });
  });

  it('closes the server when the call returns', async () => {
    let seen = '';
    await withServedProjectFile(root, 'site/index.html', async (url) => {
      seen = url;
    });
    await expect(get(seen)).rejects.toThrow();
  });

  it('refuses a page inside a dot directory', async () => {
    await fs.mkdir(path.join(root, '.design'), { recursive: true });
    await fs.writeFile(path.join(root, '.design', 'x.html'), '<h1>x</h1>');
    await expect(withServedProjectFile(root, '.design/x.html', async () => 1)).rejects.toThrow(
      /\.html file inside the project root/,
    );
  });

  it('normalizes double-leading-slash request paths and refreshes browserPrivateOrigins when WRONGSTACK_BROWSER_PRIVATE_ORIGINS changes (F78)', async () => {
    await withServedProjectFile(root, 'site/index.html', async (url) => {
      const u = new URL(url);
      const status = await new Promise<number>((resolve, reject) => {
        const req = http.request(
          {
            hostname: u.hostname,
            port: u.port,
            path: '//site/assets/a.css',
            headers: { host: u.host },
          },
          (res) => {
            res.resume();
            resolve(res.statusCode ?? 0);
          },
        );
        req.on('error', reject);
        req.end();
      });
      expect(status).toBe(200);
    });

    const prevEnv = process.env['WRONGSTACK_BROWSER_PRIVATE_ORIGINS'];
    try {
      delete process.env['WRONGSTACK_BROWSER_PRIVATE_ORIGINS'];
      const live = browserPrivateOrigins(root);
      expect(live).toEqual([]);
      process.env['WRONGSTACK_BROWSER_PRIVATE_ORIGINS'] = 'http://localhost:4321';
      expect(browserPrivateOrigins(root)).toEqual(['http://localhost:4321']);
    } finally {
      if (prevEnv === undefined) delete process.env['WRONGSTACK_BROWSER_PRIVATE_ORIGINS'];
      else process.env['WRONGSTACK_BROWSER_PRIVATE_ORIGINS'] = prevEnv;
    }
  });
});
