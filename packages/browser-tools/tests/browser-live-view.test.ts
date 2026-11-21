/**
 * The WebUI's live view of the agent's browser: a real Chromium, a CDP
 * screencast shared by viewers, and the session's console and network.
 */
import { existsSync } from 'node:fs';
import * as fs from 'node:fs/promises';
import * as http from 'node:http';
import * as os from 'node:os';
import * as path from 'node:path';
import { chromium } from '@playwright/test';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { BrowserSessionManager } from '../src/manager.js';
import type { BrowserFrame } from '../src/types.js';

const playwrightAvailable = (() => {
  try {
    return existsSync(chromium.executablePath());
  } catch {
    return false;
  }
})();

let tmp: string;
let server: http.Server;
let baseUrl: string;

beforeEach(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'wstack-browser-live-'));
  server = http.createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(`<!doctype html><html><head><title>Live Fixture</title></head><body>
      <div id="n">0</div>
      <button id="go" onclick="document.querySelector('#n').textContent = 'clicked'; console.log('clicked once')">Go</button>
    </body></html>`);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('fixture server did not bind');
  baseUrl = `http://127.0.0.1:${address.port}/`;
});

afterEach(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await fs.rm(tmp, { recursive: true, force: true });
});

const until = async (check: () => boolean, ms = 10_000) => {
  const end = Date.now() + ms;
  while (!check() && Date.now() < end) await new Promise((r) => setTimeout(r, 50));
  return check();
};

describe.skipIf(!playwrightAvailable)('BrowserSessionManager live view', () => {
  it('selects a real DOM element and screenshot without clicking or crossing conversations', async () => {
    const manager = new BrowserSessionManager({
      artifactRoot: path.join(tmp, 'artifacts'),
      allowedPrivateOrigins: [new URL(baseUrl).origin],
      operationTimeoutMs: 10_000,
    });
    const signal = new AbortController().signal;
    try {
      const opened = await manager.open('leader', { url: baseUrl, conversationId: 's1' }, signal);
      const point = (await manager.evaluate(
        opened.id,
        'leader',
        `(() => { const r=document.querySelector('#go').getBoundingClientRect(); return {x:(r.x+r.width/2)/innerWidth,y:(r.y+r.height/2)/innerHeight}; })()`,
        signal,
      )) as { x: number; y: number };
      const selected = await manager.pickElement(opened.id, 's1', { ...point, url: baseUrl });
      expect(selected).toMatchObject({
        browserId: opened.id,
        ownerId: 'leader',
        selector: '#go',
        tag: 'button',
        text: 'Go',
        url: baseUrl,
      });
      expect(selected.styles['font-size']).toBeTruthy();
      expect(Buffer.from(selected.image!.data, 'base64').subarray(0, 3)).toEqual(
        Buffer.from([0xff, 0xd8, 0xff]),
      );
      expect(
        await manager.evaluate(
          opened.id,
          'leader',
          "document.querySelector('#n').textContent",
          signal,
        ),
      ).toBe('0');
      await expect(
        manager.pickElement(opened.id, 'another-session', { ...point, url: baseUrl }),
      ).rejects.toThrow('conversation');
      await expect(
        manager.pickElement(opened.id, 's1', { ...point, url: 'https://stale.test/' }),
      ).rejects.toThrow('navigated');
      await expect(
        manager.pickElement(opened.id, 's1', { x: NaN, y: 0, url: baseUrl }),
      ).rejects.toThrow('coordinates');
    } finally {
      await manager.dispose();
    }
  });
  it('lists sessions with their conversation, and streams frames to every viewer', async () => {
    const manager = new BrowserSessionManager({
      artifactRoot: path.join(tmp, 'artifacts'),
      allowedPrivateOrigins: [new URL(baseUrl).origin],
      operationTimeoutMs: 10_000,
    });
    const signal = new AbortController().signal;
    try {
      const opened = await manager.open(
        'leader',
        { url: baseUrl, trace: false, conversationId: 'sess_a' },
        signal,
      );
      const listed = await manager.liveSessions();
      expect(listed).toEqual([
        expect.objectContaining({ id: opened.id, conversationId: 'sess_a', title: 'Live Fixture' }),
      ]);

      const first: BrowserFrame[] = [];
      const second: BrowserFrame[] = [];
      const stopFirst = await manager.watch(opened.id, (f) => first.push(f));
      const stopSecond = await manager.watch(opened.id, (f) => second.push(f));
      // The screencast starts with a frame of the page as it is.
      expect(await until(() => first.length > 0)).toBe(true);
      const frame = first[0] as BrowserFrame;
      expect(Buffer.from(frame.data, 'base64').subarray(0, 3)).toEqual(
        Buffer.from([0xff, 0xd8, 0xff]),
      );
      expect(frame.width).toBeGreaterThan(0);

      // A change on the page sends new frames, to both viewers.
      const before = second.length;
      await manager.click(opened.id, 'leader', '#go', signal);
      expect(await until(() => second.length > before)).toBe(true);

      const details = await manager.liveDetails(opened.id, 10);
      expect(details?.title).toBe('Live Fixture');
      expect(details?.console.map((c) => c.text)).toContain('clicked once');
      expect(details?.network[0]?.url).toBe(baseUrl);

      // The first viewer leaving does not stop the other's stream.
      await stopFirst();
      const count = first.length;
      const secondCount = second.length;
      await manager.evaluate(
        opened.id,
        'leader',
        "document.querySelector('#n').textContent = 'again'",
        signal,
      );
      expect(await until(() => second.length > secondCount)).toBe(true);
      expect(first.length).toBe(count);
      await stopSecond();

      await manager.close(opened.id, 'leader');
      expect(await manager.liveDetails(opened.id, 10)).toBeUndefined();
      await expect(manager.watch(opened.id, () => undefined)).rejects.toThrow('is not open');
    } finally {
      await manager.dispose();
    }
  }, 60_000);
});
