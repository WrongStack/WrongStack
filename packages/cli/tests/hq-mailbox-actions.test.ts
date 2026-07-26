/**
 * Tests for `POST /api/mailbox/messages/:mailId/action` on the HQ server —
 * the server side of the Mailbox view's per-message action buttons
 * (mark-read / acknowledge / reopen / soft-delete / restore).
 *
 * The target project mailbox is resolved SERVER-SIDE from sessionId or
 * projectId via the SessionRegistry (same trust model as /api/mailbox-send);
 * projectId matches either the registry projectSlug or the
 * sha256(projectRoot)[:12] hash HQ publishers stamp on event envelopes.
 */

import { createHash } from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { GlobalMailbox, resolveProjectDir } from '@wrongstack/core/coordination';
import { HQ_AUTH_FILE_VERSION, writeHqAuthFile } from '@wrongstack/core/hq';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { type HqServerHandle, startHqServer } from '../src/hq-server.js';

let handle: HqServerHandle | null = null;
let tempRoot: string;
let dataDir: string;

beforeEach(async () => {
  // Keep the HQ data dir one level below a per-test global root. The server
  // resolves the SessionRegistry from dirname(dataDir); placing dataDir
  // directly in os.tmpdir made every parallel test worker share the same
  // os.tmpdir/session-registry.json file.
  tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'hq-mb-actions-'));
  dataDir = path.join(tempRoot, 'hq');
  await fs.mkdir(dataDir, { recursive: true });
});

afterEach(async () => {
  if (handle) {
    await handle.close();
    handle = null;
  }
  await fs.rm(tempRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
});

function getPort(): number {
  return 30_000 + Math.floor(Math.random() * 10_000);
}

async function startOpenHqServer(): Promise<HqServerHandle> {
  await writeHqAuthFile(dataDir, {
    version: HQ_AUTH_FILE_VERSION,
    updatedAt: new Date().toISOString(),
    browserTokens: [],
    clientTokens: [],
  });
  handle = await startHqServer({ port: getPort(), dataDir });
  return handle;
}

/** Seed a live session so the route can resolve a projectRoot. */
async function seedSession(
  globalRoot: string,
  sessionId: string,
  projectSlug: string,
  projectRoot: string,
): Promise<() => Promise<void>> {
  const { SessionRegistry } = await import('@wrongstack/core/storage');
  const registry = new SessionRegistry(globalRoot);
  await registry.register({
    sessionId,
    projectSlug,
    projectRoot,
    projectName: projectSlug,
    workingDir: projectRoot,
    pid: process.pid,
    startedAt: new Date().toISOString(),
  });
  return async () => {
    await registry.unregister().catch(() => {});
  };
}

interface Seeded {
  mailbox: GlobalMailbox;
  mailId: string;
  cleanup: () => Promise<void>;
  projectRoot: string;
}

/** Seed a session + one open mailbox message; return its id and the mailbox. */
async function seedMessage(sessionId: string, slug: string): Promise<Seeded> {
  const globalRoot = path.dirname(dataDir);
  const projectRoot = path.join(dataDir, slug);
  await fs.mkdir(projectRoot, { recursive: true });
  const cleanup = await seedSession(globalRoot, sessionId, slug, projectRoot);
  const mailbox = new GlobalMailbox(resolveProjectDir(projectRoot, globalRoot));
  const sent = await mailbox.send({
    from: 'leader@x',
    to: 'operator@sess-1',
    type: 'ask',
    subject: 'Need a decision',
    body: 'Which port should HQ bind?',
    priority: 'normal',
  });
  return { mailbox, mailId: sent.id, cleanup, projectRoot };
}

function actionUrl(h: HqServerHandle, mailId: string): string {
  return `http://127.0.0.1:${h.port}/api/mailbox/messages/${encodeURIComponent(mailId)}/action`;
}

async function postAction(h: HqServerHandle, mailId: string, body: unknown): Promise<Response> {
  return fetch(actionUrl(h, mailId), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

describe('HQ mailbox message actions (POST /api/mailbox/messages/:id/action)', () => {
  it('acknowledges a message: marks it read + completed by the actor', async () => {
    const h = await startOpenHqServer();
    const { mailbox, mailId, cleanup } = await seedMessage('sess-ack-1', 'act-project');
    try {
      const res = await postAction(h, mailId, {
        action: 'acknowledge',
        readerId: 'hq-operator',
        sessionId: 'sess-ack-1',
      });
      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        action: string;
        mailId: string;
        changed: boolean;
        message: unknown;
      };
      expect(body).toMatchObject({ action: 'acknowledge', mailId, changed: true, message: null });

      const msgs = await mailbox.query({ to: 'operator@sess-1' });
      const found = msgs.find((m) => m.id === mailId);
      expect(found?.completed).toBe(true);
      expect(found?.completedBy).toBe('hq-operator');
      expect(found?.readBy['hq-operator']).toBeTruthy();
    } finally {
      await cleanup();
    }
  });

  it('soft-deletes and restores a message', async () => {
    const h = await startOpenHqServer();
    const { mailbox, mailId, cleanup } = await seedMessage('sess-del-1', 'del-project');
    try {
      const del = await postAction(h, mailId, {
        action: 'soft-delete',
        readerId: 'hq-operator',
        sessionId: 'sess-del-1',
      });
      expect(del.status).toBe(200);
      // Soft-deleted messages drop out of the default query.
      const afterDelete = await mailbox.query({ to: 'operator' });
      expect(afterDelete.find((m) => m.id === mailId)).toBeUndefined();

      const restore = await postAction(h, mailId, {
        action: 'restore',
        readerId: 'hq-operator',
        sessionId: 'sess-del-1',
      });
      expect(restore.status).toBe(200);
      const afterRestore = await mailbox.query({ to: 'operator@sess-1' });
      expect(afterRestore.find((m) => m.id === mailId)).toBeTruthy();
    } finally {
      await cleanup();
    }
  });

  it('resolves the project from the sha-derived HQ projectId', async () => {
    // HQ event envelopes stamp projectId = sha256(projectRoot)[:12] — the
    // Mailbox view only has THAT id, so the route must accept it.
    const h = await startOpenHqServer();
    const { mailbox, mailId, cleanup, projectRoot } = await seedMessage(
      'sess-sha-1',
      'sha-project',
    );
    try {
      const shaProjectId = createHash('sha256').update(projectRoot).digest('hex').slice(0, 12);
      const res = await postAction(h, mailId, {
        action: 'mark-read',
        readerId: 'hq-operator',
        projectId: shaProjectId,
      });
      expect(res.status).toBe(200);
      const msgs = await mailbox.query({ to: 'operator@sess-1' });
      expect(msgs.find((m) => m.id === mailId)?.readBy['hq-operator']).toBeTruthy();
    } finally {
      await cleanup();
    }
  });

  it('returns 404 for an unknown mailId', async () => {
    const h = await startOpenHqServer();
    const { cleanup } = await seedMessage('sess-404-1', 'missing-mail-project');
    try {
      const res = await postAction(h, 'no-such-mail-id', {
        action: 'mark-read',
        readerId: 'hq-operator',
        sessionId: 'sess-404-1',
      });
      expect(res.status).toBe(404);
    } finally {
      await cleanup();
    }
  });

  it('returns 404 when the project cannot be resolved', async () => {
    const h = await startOpenHqServer();
    const res = await postAction(h, 'some-mail', {
      action: 'mark-read',
      readerId: 'hq-operator',
      projectId: 'unknown-project',
    });
    expect(res.status).toBe(404);
  });

  it('returns 400 for a malformed request', async () => {
    const h = await startOpenHqServer();
    const badAction = await postAction(h, 'm1', {
      action: 'explode',
      readerId: 'x',
      projectId: 'p',
    });
    expect(badAction.status).toBe(400);
    const noReader = await postAction(h, 'm1', { action: 'mark-read', projectId: 'p' });
    expect(noReader.status).toBe(400);
    const noTarget = await postAction(h, 'm1', { action: 'mark-read', readerId: 'x' });
    expect(noTarget.status).toBe(400);
  });

  it('requires a browser token in token mode', async () => {
    const browserToken = 'mb-actions-browser-token';
    await writeHqAuthFile(dataDir, {
      version: HQ_AUTH_FILE_VERSION,
      updatedAt: new Date().toISOString(),
      browserTokens: [{ id: 'bt-1', token: browserToken, createdAt: new Date().toISOString() }],
      clientTokens: [],
    });
    handle = await startHqServer({ port: getPort(), dataDir });

    const bare = await postAction(handle, 'm1', {
      action: 'mark-read',
      readerId: 'x',
      projectId: 'p',
    });
    expect(bare.status).toBe(401);

    // With the token the request passes auth (and 404s on the unknown project).
    const authed = await fetch(actionUrl(handle, 'm1'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + browserToken },
      body: JSON.stringify({ action: 'mark-read', readerId: 'x', projectId: 'p' }),
    });
    expect(authed.status).toBe(404);
  });
});
