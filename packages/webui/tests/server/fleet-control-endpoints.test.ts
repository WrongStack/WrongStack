/**
 * End-to-end tests for the Fleet HQ two-way control endpoints, against a real
 * SessionRegistry file + GlobalMailbox in a temp WrongStack home:
 *   - POST /api/sessions/:id/message  (type + priority delivery)
 *   - GET  /api/sessions/:id/mailbox  (human↔leader thread)
 *   - POST /api/sessions/:id/interrupt (control message)
 *   - POST /api/fleet/broadcast       (fan-out to live sessions)
 *
 * Session ids contain a literal '/', so the requests percent-encode it — these
 * tests also exercise the decodeSessionId path through to the registry lookup.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { createHttpServer } from '../../src/server/http-server.js';

const SESSION_ID = '2026-06-19/sess_01JX2S9V7T5M6N7P8Q9R0STXVW';
const ENC = encodeURIComponent(SESSION_ID);

let globalRoot: string;
let projectRoot: string;
let distDir: string;
let server: import('node:http').Server;
let baseUrl: string;

beforeAll(async () => {
  globalRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'webui-fleet-'));
  projectRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'webui-proj-'));
  distDir = await fs.mkdtemp(path.join(os.tmpdir(), 'webui-fleet-dist-'));
  await fs.writeFile(path.join(distDir, 'index.html'), '<!doctype html><title>x</title>');

  // Resolve the project's slug the same way the server does, so the entry's
  // projectSlug matches resolveWstackPaths' projectDir (the mailbox location).
  const { resolveWstackPaths } = await import('@wrongstack/core');
  const paths = resolveWstackPaths({ projectRoot, globalRoot });

  const entry = {
    sessionId: SESSION_ID,
    projectSlug: path.basename(paths.projectDir),
    projectName: 'TestProj',
    projectRoot,
    workingDir: projectRoot,
    gitBranch: 'main',
    clientType: 'tui',
    status: 'active',
    pid: 999_999, // not this test process — broadcast falls back to all sessions
    startedAt: new Date('2026-06-19T12:00:00Z').toISOString(),
    lastHeartbeatAt: new Date().toISOString(),
    agentCount: 1,
    agents: [
      {
        id: 'leader',
        name: 'leader',
        status: 'streaming',
        iterations: 0,
        toolCalls: 0,
        lastActivityAt: new Date().toISOString(),
      },
    ],
  };
  await fs.writeFile(
    path.join(globalRoot, 'session-registry.json'),
    JSON.stringify({ [SESSION_ID]: entry }),
  );

  server = createHttpServer({ host: '127.0.0.1', distDir, wsPort: 9998, globalRoot });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const addr = server.address();
  if (!addr || typeof addr === 'string') throw new Error('bad listen address');
  baseUrl = `http://127.0.0.1:${addr.port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await Promise.all([
    fs.rm(globalRoot, { recursive: true, force: true }),
    fs.rm(projectRoot, { recursive: true, force: true }),
    fs.rm(distDir, { recursive: true, force: true }),
  ]);
});

describe('Fleet HQ control endpoints', () => {
  it('delivers a typed/prioritized message and reflects it in the thread', async () => {
    const post = await fetch(`${baseUrl}/api/sessions/${ENC}/message`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: 'please switch to plan B', type: 'ask', priority: 'normal' }),
    });
    expect(post.status).toBe(200);
    const sent = (await post.json()) as { ok: boolean; id: string; type: string };
    expect(sent.ok).toBe(true);
    expect(sent.type).toBe('ask');
    expect(sent.id).toBeTruthy();

    const thr = await fetch(`${baseUrl}/api/sessions/${ENC}/mailbox`);
    expect(thr.status).toBe(200);
    const body = (await thr.json()) as {
      thread: Array<{ id: string; type: string; body: string; fromLeader: boolean; readByLeader: string | null }>;
    };
    const found = body.thread.find((m) => m.id === sent.id);
    expect(found).toBeDefined();
    expect(found?.type).toBe('ask');
    expect(found?.body).toBe('please switch to plan B');
    expect(found?.fromLeader).toBe(false);
    expect(found?.readByLeader).toBeNull(); // nobody read it yet
  });

  it('falls back to a default type for an unknown type value', async () => {
    const post = await fetch(`${baseUrl}/api/sessions/${ENC}/message`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: 'hi', type: 'bogus' }),
    });
    const sent = (await post.json()) as { type: string };
    expect(sent.type).toBe('steer');
  });

  it('rejects an empty message', async () => {
    const post = await fetch(`${baseUrl}/api/sessions/${ENC}/message`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: '   ' }),
    });
    expect(post.status).toBe(400);
  });

  it('sends a control message on interrupt', async () => {
    const post = await fetch(`${baseUrl}/api/sessions/${ENC}/interrupt`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ reason: 'stop please' }),
    });
    expect(post.status).toBe(200);

    const thr = await fetch(`${baseUrl}/api/sessions/${ENC}/mailbox`);
    const body = (await thr.json()) as { thread: Array<{ type: string; body: string }> };
    const control = body.thread.find((m) => m.type === 'control');
    expect(control).toBeDefined();
    expect(control?.body).toBe('stop please');
  });

  it('broadcasts to every live session', async () => {
    const post = await fetch(`${baseUrl}/api/fleet/broadcast`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: 'all hands' }),
    });
    expect(post.status).toBe(200);
    const res = (await post.json()) as { ok: boolean; delivered: number; targets: number };
    expect(res.ok).toBe(true);
    expect(res.delivered).toBeGreaterThanOrEqual(1);
    expect(res.targets).toBeGreaterThanOrEqual(1);
  });

  it('404s for an unknown session', async () => {
    const post = await fetch(`${baseUrl}/api/sessions/nope-not-real/message`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: 'x' }),
    });
    expect(post.status).toBe(404);
  });
});
