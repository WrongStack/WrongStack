import { existsSync } from 'node:fs';
import * as fs from 'node:fs/promises';
import * as http from 'node:http';
import type { AddressInfo } from 'node:net';
import * as os from 'node:os';
import * as path from 'node:path';
import { chromium } from '@playwright/test';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { BrowserSessionManager } from '../src/manager.js';

/**
 * Found by driving the browser tools against a local page (audit 2026-09-15):
 * - a navigation redirected to a blocked address resolved successfully (the
 *   network proxy answers with a 403 page), reporting the blocked address as
 *   the session URL;
 * - `evaluate` of a never-settling expression had no timeout;
 * - Playwright call-log errors carried raw ANSI colour codes.
 */
const playwrightAvailable = (() => {
  try {
    return existsSync(chromium.executablePath());
  } catch {
    return false;
  }
})();

function listen(server: http.Server): Promise<number> {
  return new Promise((resolve) =>
    server.listen(0, '127.0.0.1', () => resolve((server.address() as AddressInfo).port)),
  );
}

let tmp: string;
let app: http.Server;
let forbidden: http.Server;
let origin: string;
let forbiddenOrigin: string;
let forbiddenConnections = 0;

beforeEach(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'wstack-browser-guard-'));
  forbiddenConnections = 0;
  forbidden = http.createServer((_req, res) => res.end('forbidden'));
  forbidden.on('connection', () => {
    forbiddenConnections += 1;
  });
  forbiddenOrigin = `http://127.0.0.1:${await listen(forbidden)}`;
  app = http.createServer((req, res) => {
    if (req.url === '/redirect') {
      res.writeHead(302, { location: `${forbiddenOrigin}/` });
      res.end();
      return;
    }
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end('<title>Guard Fixture</title><button id="b">b</button>');
  });
  origin = `http://127.0.0.1:${await listen(app)}`;
});

afterEach(async () => {
  await new Promise<void>((resolve) => app.close(() => resolve()));
  await new Promise<void>((resolve) => forbidden.close(() => resolve()));
  await fs.rm(tmp, { recursive: true, force: true });
});

describe.skipIf(!playwrightAvailable)('BrowserSessionManager guard regressions', () => {
  it('refuses a navigation that redirects to a blocked address', async () => {
    const manager = new BrowserSessionManager({
      artifactRoot: path.join(tmp, 'artifacts'),
      allowedPrivateOrigins: [origin],
      operationTimeoutMs: 10_000,
    });
    const signal = new AbortController().signal;
    try {
      const opened = await manager.open('leader', { url: `${origin}/`, trace: false }, signal);
      await expect(
        manager.navigate(opened.id, 'leader', `${origin}/redirect`, signal),
      ).rejects.toThrow(/redirected to a blocked address/);
      await expect(
        manager.navigate(opened.id, 'leader', `${origin}/redirect`, signal),
      ).rejects.toThrow(`/browser allow ${forbiddenOrigin}`);
      const [session] = await manager.list('leader');
      expect(session?.url).toBe('about:blank');
      expect(forbiddenConnections).toBe(0);
    } finally {
      await manager.dispose();
    }
  }, 30_000);

  it('keeps the allow command in blocked subresource evidence', async () => {
    const manager = new BrowserSessionManager({
      artifactRoot: path.join(tmp, 'artifacts'),
      allowedPrivateOrigins: [origin],
    });
    const signal = new AbortController().signal;
    try {
      const opened = await manager.open('leader', { url: origin, trace: false }, signal);
      await manager.evaluate(
        opened.id,
        'leader',
        `fetch(${JSON.stringify(forbiddenOrigin)}).catch(() => 'blocked')`,
        signal,
      );
      const snapshot = await manager.snapshot(opened.id, 'leader', signal);
      expect(
        snapshot.network.some(
          (entry) => entry.failed && entry.error?.includes(`/browser allow ${forbiddenOrigin}`),
        ),
      ).toBe(true);
      expect(forbiddenConnections).toBe(0);
    } finally {
      await manager.dispose();
    }
  }, 30_000);

  it('bounds an evaluation that never settles', async () => {
    const manager = new BrowserSessionManager({
      artifactRoot: path.join(tmp, 'artifacts'),
      allowedPrivateOrigins: [origin],
      operationTimeoutMs: 1_000,
    });
    const signal = new AbortController().signal;
    try {
      const opened = await manager.open('leader', { url: `${origin}/`, trace: false }, signal);
      const started = Date.now();
      await expect(
        manager.evaluate(opened.id, 'leader', 'new Promise(() => {})', signal),
      ).rejects.toThrow(/did not settle within 1000ms/);
      expect(Date.now() - started).toBeLessThan(5_000);
      // The session still works afterwards.
      await expect(manager.evaluate(opened.id, 'leader', '1 + 1', signal)).resolves.toBe(2);
    } finally {
      await manager.dispose();
    }
  }, 30_000);

  it('strips ANSI colour codes from Playwright call-log errors', async () => {
    const manager = new BrowserSessionManager({
      artifactRoot: path.join(tmp, 'artifacts'),
      allowedPrivateOrigins: [origin],
      operationTimeoutMs: 300,
    });
    const signal = new AbortController().signal;
    try {
      const opened = await manager.open('leader', { url: `${origin}/`, trace: false }, signal);
      const error = await manager.click(opened.id, 'leader', '#missing', signal).then(
        () => undefined,
        (err: unknown) => err as Error,
      );
      expect(error?.message).toMatch(/Timeout 300ms exceeded/);
      expect(error?.message).not.toContain(String.fromCharCode(27));
    } finally {
      await manager.dispose();
    }
  }, 30_000);
});
