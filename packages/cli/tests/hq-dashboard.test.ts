// @vitest-environment jsdom

import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { HQ_AUTH_FILE_VERSION, writeHqAuthFile } from '@wrongstack/core/hq';
import { JSDOM } from 'jsdom';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { type HqServerHandle, startHqServer } from '../src/hq-server.js';

/**
 * Server-to-dashboard contract tests for the built React HQ application.
 * Component behavior lives in @wrongstack/webui-hq tests; this suite verifies
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

function assetPath(
  document: { querySelector: (s: string) => { getAttribute: (a: string) => string | null } | null },
  selector: string,
  attribute: 'href' | 'src',
): string {
  const value = document.querySelector(selector)?.getAttribute(attribute);
  expect(value).toMatch(/^\/assets\//);
  return value as string;
}

describe('HQ React dashboard delivery', () => {
  it('serves a local, split React shell with no CDN dependency', async () => {
    handle = await startServer();
    const response = await fetch(`http://127.0.0.1:${handle.port}/`);
    const html = await response.text();
    const document = new JSDOM(html).window.document as unknown as {
      querySelector: (
        s: string,
      ) => { textContent: string | null; getAttribute: (a: string) => string | null } | null;
      getElementById: (id: string) => unknown;
      querySelectorAll: (s: string) => unknown[];
    };

    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toContain('text/html');
    expect(document.querySelector('title')?.textContent).toContain('WrongStack HQ');
    expect(document.getElementById('root')).not.toBeNull();
    expect(document.getElementById('boot')).toBeNull();
    expect(html).not.toMatch(/https?:\/\//);

    const scriptPath = assetPath(document, 'script[type="module"]', 'src');
    const stylePath = assetPath(document, 'link[rel="stylesheet"]', 'href');
    expect(document.querySelectorAll('link[rel="modulepreload"]').length).toBeGreaterThan(0);

    const [scriptResponse, styleResponse] = await Promise.all([
      fetch(`http://127.0.0.1:${handle.port}${scriptPath}`),
      fetch(`http://127.0.0.1:${handle.port}${stylePath}`),
    ]);
    const [script, style] = await Promise.all([scriptResponse.text(), styleResponse.text()]);

    expect(scriptResponse.status).toBe(200);
    expect(scriptResponse.headers.get('content-type')).toContain('application/javascript');
    expect(script).toContain('hq-workbench');
    expect(script).toContain('/ws/browser');
    expect(script).not.toContain('hq-activity-rail');
    expect(styleResponse.status).toBe(200);
    expect(styleResponse.headers.get('content-type')).toContain('text/css');
    // The bundle carries the dashboard's own stylesheet (the SDD board's
    // react-flow CSS ships in the same file) — proves styling is served
    // locally, not from a CDN. The old .hq-secondary-nav class no longer
    // exists in the restyled shell.
    expect(style).toContain('.react-flow');
    expect(style).not.toContain('.hq-activity-rail');
  });

  it('returns the React shell for client-side routes', async () => {
    handle = await startServer();
    const [rootHtml, routeResponse] = await Promise.all([
      fetch(`http://127.0.0.1:${handle.port}/`).then((response) => response.text()),
      fetch(`http://127.0.0.1:${handle.port}/fleet/map`),
    ]);

    expect(routeResponse.status).toBe(200);
    expect(routeResponse.headers.get('content-type')).toContain('text/html');
    expect(await routeResponse.text()).toBe(rootHtml);
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
