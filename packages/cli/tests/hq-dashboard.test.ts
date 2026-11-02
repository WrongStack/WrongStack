// @vitest-environment jsdom

import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { HQ_AUTH_FILE_VERSION, writeHqAuthFile } from '@wrongstack/hq';
import { JSDOM } from 'jsdom';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { type HqServerHandle, startHqServer } from '../src/hq-server.js';

/**
 * Server-to-dashboard contract tests for the built React HQ application.
 * Component behavior lives in @wrongstack/hq-next tests; this suite verifies
 * that the CLI exposes that build, its split assets, SPA fallback and gated
 * data plane correctly.
 */

let handle: HqServerHandle | null = null;
let dataDir: string;

beforeEach(async () => {
  dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'hq-dash-'));
});

afterEach(async () => {
  if (handle !== null) {
    await handle.close();
    handle = null;
  }
  await fs.rm(dataDir, { recursive: true, force: true });
});

function getPort(): number {
  return 30_000 + Math.floor(Math.random() * 10_000);
}

async function startServer(): Promise<HqServerHandle> {
  await writeHqAuthFile(dataDir, {
    version: HQ_AUTH_FILE_VERSION,
    updatedAt: new Date().toISOString(),
    browserTokens: [],
    clientTokens: [],
  });
  return startHqServer({ port: getPort(), dataDir });
}

/** Every `attribute` of `selector` in the page; each must be a local Next asset. */
function nextAssetPaths(
  document: { querySelectorAll: (s: string) => ArrayLike<{ getAttribute: (a: string) => string | null }> },
  selector: string,
  attribute: 'href' | 'src',
  prefix: string,
): string[] {
  const values = Array.from(document.querySelectorAll(selector), (el) => el.getAttribute(attribute));
  expect(values.length).toBeGreaterThan(0);
  for (const value of values) expect(value?.startsWith(prefix)).toBe(true);
  return values as string[];
}

describe('HQ React dashboard delivery', () => {
  it('serves the exported Next shell with local, immutable assets and no CDN dependency', async () => {
    handle = await startServer();
    const base = `http://127.0.0.1:${handle.port}`;
    const response = await fetch(`${base}/`);
    const html = await response.text();
    const document = new JSDOM(html).window.document;

    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toContain('text/html');
    expect(document.querySelector('title')?.textContent).toContain('WrongStack HQ');
    expect(document.getElementById('root')).not.toBeNull();
    expect(document.getElementById('boot')).toBeNull();
    expect(html).not.toMatch(/https?:\/\//);

    const scriptPaths = nextAssetPaths(document, 'script[src]', 'src', '/_next/static/');
    const stylePaths = nextAssetPaths(
      document,
      'link[rel="stylesheet"]',
      'href',
      '/_next/static/css/',
    );
    const scripts = await Promise.all(scriptPaths.map((p) => fetch(`${base}${p}`)));
    const styles = await Promise.all(stylePaths.map((p) => fetch(`${base}${p}`)));
    for (const r of scripts) {
      expect(r.status).toBe(200);
      expect(r.headers.get('content-type')).toContain('application/javascript');
      expect(r.headers.get('cache-control')).toContain('immutable');
    }
    for (const r of styles) {
      expect(r.status).toBe(200);
      expect(r.headers.get('content-type')).toContain('text/css');
      expect(r.headers.get('cache-control')).toContain('immutable');
    }
    const scriptText = (await Promise.all(scripts.map((r) => r.text()))).join('\n');
    const styleText = (await Promise.all(styles.map((r) => r.text()))).join('\n');
    // The shell's own chunks open the browser socket.
    expect(scriptText).toContain('/ws/browser');
    // The dashboard's own stylesheet (the SDD board's react-flow CSS ships
    // with it) is served locally, not from a CDN; the old activity rail is gone.
    expect(styleText).toContain('.react-flow');
    expect(styleText).not.toContain('.hq-activity-rail');
  });

  it('serves exported routes as their own pages and unknown routes as the not-found page', async () => {
    handle = await startServer();
    const base = `http://127.0.0.1:${handle.port}`;
    const [rootHtml, fleet, mobile, unknown] = await Promise.all([
      fetch(`${base}/`).then((response) => response.text()),
      fetch(`${base}/fleet/`),
      fetch(`${base}/mobile`),
      fetch(`${base}/fleet/map`),
    ]);

    for (const page of [fleet, mobile]) {
      expect(page.status).toBe(200);
      expect(page.headers.get('content-type')).toContain('text/html');
      const text = await page.text();
      expect(text).toContain('WrongStack HQ');
      // A route's own exported page, not the root shell under another URL.
      expect(text).not.toBe(rootHtml);
    }
    // Rendering the root page under an unknown URL would hydrate the wrong
    // route; the export's not-found page answers instead.
    expect(unknown.status).toBe(404);
    expect(unknown.headers.get('content-type')).toContain('text/html');
    expect(await unknown.text()).not.toBe(rootHtml);
  });

  it('keeps API routes out of the SPA fallback', async () => {
    handle = await startServer();
    const [fleetResponse, eventsResponse, sessionsResponse] = await Promise.all([
      fetch(`http://127.0.0.1:${handle.port}/api/fleet`),
      fetch(`http://127.0.0.1:${handle.port}/api/events?limit=2`),
      fetch(`http://127.0.0.1:${handle.port}/api/sessions`),
    ]);

    expect(fleetResponse.headers.get('content-type')).toContain('application/json');
    expect(eventsResponse.headers.get('content-type')).toContain('application/json');
    expect(sessionsResponse.headers.get('content-type')).toContain('application/json');

    const fleet = (await fleetResponse.json()) as { clients: unknown[]; totals: unknown };
    const events = (await eventsResponse.json()) as { events: unknown[] };
    const sessions = (await sessionsResponse.json()) as unknown[];
    expect(fleet.clients).toEqual([]);
    expect(fleet.totals).toBeTypeOf('object');
    expect(events.events).toEqual([]);
    expect(sessions).toBeInstanceOf(Array);
  });

  it('serves the auth gate publicly while protecting telemetry in token mode', async () => {
    const token = 'browser-token-for-test';
    await writeHqAuthFile(dataDir, {
      version: HQ_AUTH_FILE_VERSION,
      updatedAt: new Date().toISOString(),
      browserTokens: [{ id: 'browser-test', token, createdAt: new Date().toISOString() }],
      clientTokens: [],
    });
    handle = await startHqServer({ port: getPort(), dataDir });

    const shellResponse = await fetch(`http://127.0.0.1:${handle.port}/`);
    const unauthorized = await fetch(`http://127.0.0.1:${handle.port}/api/fleet`);
    const authorized = await fetch(`http://127.0.0.1:${handle.port}/api/fleet`, {
      headers: { Authorization: `Bearer ${token}` },
    });

    expect(shellResponse.status).toBe(200);
    expect(await shellResponse.text()).not.toContain(token);
    expect(unauthorized.status).toBe(401);
    expect(unauthorized.headers.get('content-type')).toContain('application/json');
    expect(authorized.status).toBe(200);
    expect(authorized.headers.get('content-type')).toContain('application/json');
  });
});
