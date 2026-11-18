import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { createHttpServer } from '@wrongstack/webui-server';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const TOKEN = 'test-body-validation-token';

describe('Fleet HQ API handlers non-object JSON and oversize body handling', () => {
  let globalRoot: string;
  let distDir: string;
  let server: import('node:http').Server;
  let baseUrl: string;

  beforeAll(async () => {
    globalRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'webui-body-global-'));
    distDir = await fs.mkdtemp(path.join(os.tmpdir(), 'webui-body-dist-'));
    await fs.writeFile(path.join(distDir, 'index.html'), '<!doctype html><title>x</title>');

    server = createHttpServer({ host: '127.0.0.1', distDir, globalRoot, apiToken: TOKEN });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const addr = server.address();
    if (!addr || typeof addr === 'string') throw new Error('bad listen address');
    baseUrl = `http://127.0.0.1:${addr.port}`;
  });

  afterAll(async () => {
    if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
    await fs.rm(globalRoot, { recursive: true, force: true });
    await fs.rm(distDir, { recursive: true, force: true });
  });

  const postJson = (route: string, body: string) =>
    fetch(`${baseUrl}${route}`, {
      method: 'POST',
      headers: {
        'x-ws-token': TOKEN,
        'content-type': 'application/json',
      },
      body,
    });

  it('returns 400 JSON instead of 500 TypeError for literal null, array, or primitive JSON bodies', async () => {
    for (const route of [
      '/api/sessions/s1/message',
      '/api/sessions/s1/interrupt',
      '/api/fleet/broadcast',
    ]) {
      for (const raw of ['null', '42', '[]', '"str"']) {
        const res = await postJson(route, raw);
        expect(res.status, `${route} ${raw}`).toBe(400);
        await expect(res.json()).resolves.toEqual({ error: 'Invalid request body' });
      }
    }
  });

  it('returns 413 JSON cleanly without resetting socket when body exceeds 64 KB', async () => {
    const oversized = JSON.stringify({ text: 'x'.repeat(70_000), reason: 'y'.repeat(70_000) });
    for (const route of [
      '/api/sessions/s1/message',
      '/api/sessions/s1/interrupt',
      '/api/fleet/broadcast',
    ]) {
      const res = await postJson(route, oversized);
      expect(res.status, route).toBe(413);
      await expect(res.json()).resolves.toEqual({ error: 'Request body too large' });
    }
  });
});
