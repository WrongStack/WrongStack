import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createMailboxCredential } from '../../src/coordination/mailbox-credential-store.js';
import { MailboxProjectServerConnection } from '../../src/coordination/mailbox-project-server-client.js';
import {
  mailboxProjectServerEndpoint,
  mailboxProjectServerKey,
  mailboxProjectServerMetadataPath,
} from '../../src/coordination/mailbox-project-server-endpoint.js';
import {
  encodeMailboxProjectServerMessage,
  isMailboxProjectServerClientMessage,
  isMailboxProjectServerMessage,
  MAILBOX_PROJECT_SERVER_PROTOCOL_VERSION,
} from '../../src/coordination/mailbox-project-server-protocol.js';
import { getSharedProjectMailbox, RemoteMailbox } from '../../src/coordination/remote-mailbox.js';

let projectDir: string;

beforeEach(async () => {
  projectDir = await fs.mkdtemp(path.join(os.tmpdir(), 'mailbox-project-server-'));
});

afterEach(async () => {
  await fs.rm(projectDir, { recursive: true, force: true }).catch(() => {});
});

describe('mailbox project server identity and protocol', () => {
  it('uses one deterministic endpoint for equivalent project state paths', () => {
    const equivalent = path.join(projectDir, '.', 'nested', '..');
    expect(mailboxProjectServerKey(equivalent)).toBe(mailboxProjectServerKey(projectDir));
    expect(mailboxProjectServerEndpoint(equivalent)).toBe(mailboxProjectServerEndpoint(projectDir));
  });

  it('frames protocol messages as newline-delimited JSON', () => {
    const encoded = encodeMailboxProjectServerMessage({ type: 'heartbeat' });
    expect(MAILBOX_PROJECT_SERVER_PROTOCOL_VERSION).toBe(4);
    expect(encoded.endsWith('\n')).toBe(true);
    expect(JSON.parse(encoded)).toEqual({ type: 'heartbeat' });
  });

  it('rejects malformed and unknown IPC client envelopes', () => {
    expect(isMailboxProjectServerClientMessage({ type: 'heartbeat' })).toBe(true);
    expect(
      isMailboxProjectServerClientMessage({
        type: 'request',
        id: 1,
        op: 'query',
        args: { query: {} },
      }),
    ).toBe(true);
    expect(
      isMailboxProjectServerClientMessage({
        type: 'request',
        id: 2,
        op: 'deleteDatabase',
        args: {},
      }),
    ).toBe(false);
    expect(
      isMailboxProjectServerClientMessage({
        type: 'request',
        id: 3,
        op: 'credentialVerify',
        args: { credentialId: 'id-only' },
      }),
    ).toBe(false);
    expect(isMailboxProjectServerClientMessage({ type: 'shutdown', id: '2' })).toBe(false);
    expect(isMailboxProjectServerClientMessage(null)).toBe(false);
  });

  it('rejects malformed IPC server envelopes', () => {
    expect(
      isMailboxProjectServerMessage({
        type: 'response',
        id: 1,
        ok: true,
        result: { ok: true },
      }),
    ).toBe(true);
    expect(isMailboxProjectServerMessage({ type: 'response', id: '1', ok: true })).toBe(false);
    expect(isMailboxProjectServerMessage({ type: 'hello', protocolVersion: 3 })).toBe(false);
  });
});

describe('RemoteMailbox single-owner IPC', () => {
  it('evicts an explicitly closed process-shared wrapper before reuse', async () => {
    const first = getSharedProjectMailbox(projectDir);
    expect(getSharedProjectMailbox(projectDir)).toBe(first);
    await first.close();
    const replacement = getSharedProjectMailbox(projectDir);
    expect(replacement).not.toBe(first);
    await replacement.close();
  });

  it('reference-counts the shared process connection across independent wrappers', async () => {
    const previousInline = process.env['WRONGSTACK_MAILBOX_INLINE'];
    delete process.env['WRONGSTACK_MAILBOX_INLINE'];
    const first = new RemoteMailbox(projectDir);
    const second = new RemoteMailbox(projectDir);
    try {
      await Promise.all([first.initialize(), second.initialize()]);
      const ownerPid = (await first.status()).pid;
      await first.close();
      const sent = await second.send({
        from: 'leader@refcount',
        to: 'worker@refcount',
        type: 'note',
        subject: 'still-connected',
        body: 'the second wrapper retains the shared IPC connection',
      });
      expect((await second.status()).pid).toBe(ownerPid);
      expect((await second.query({ to: 'worker@refcount' }))[0]?.id).toBe(sent.id);
    } finally {
      await first.close();
      await second.close();
      const control = new MailboxProjectServerConnection(projectDir);
      await control.shutdown('refcount-test-complete').catch(() => undefined);
      control.close();
      if (previousInline === undefined) {
        delete process.env['WRONGSTACK_MAILBOX_INLINE'];
      } else {
        process.env['WRONGSTACK_MAILBOX_INLINE'] = previousInline;
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  });

  it('elects one owner, shares messages, and keeps leased clients alive with heartbeats', async () => {
    const previousLease = process.env['WRONGSTACK_MAILBOX_SERVER_CLIENT_LEASE_MS'];
    const previousHeartbeat = process.env['WRONGSTACK_MAILBOX_CLIENT_HEARTBEAT_MS'];
    const previousInline = process.env['WRONGSTACK_MAILBOX_INLINE'];
    process.env['WRONGSTACK_MAILBOX_SERVER_CLIENT_LEASE_MS'] = '300';
    process.env['WRONGSTACK_MAILBOX_CLIENT_HEARTBEAT_MS'] = '50';
    delete process.env['WRONGSTACK_MAILBOX_INLINE'];
    const first = new RemoteMailbox({ projectDir, isolatedConnection: true });
    const second = new RemoteMailbox({ projectDir, isolatedConnection: true });
    try {
      await Promise.all([first.initialize(), second.initialize()]);
      const firstStatus = await first.status();
      const sent = await first.send({
        from: 'leader@test',
        to: 'worker@test',
        type: 'note',
        subject: 'single-owner',
        body: 'shared over IPC',
      });
      const received = await second.query({ to: 'worker@test', limit: 10 });
      await first.registerAgent({
        agentId: 'worker@test',
        sessionId: 'ipc-session',
        name: 'IPC worker',
        role: 'worker',
      });
      await second.registerClient({
        clientId: 'tui@test',
        sessionId: 'ipc-session',
        name: 'IPC TUI',
        source: 'tui',
      });
      await new Promise((resolve) => setTimeout(resolve, 700));
      const secondStatus = await second.status();

      expect(secondStatus.pid).toBe(firstStatus.pid);
      expect(secondStatus.clients).toBe(2);
      expect(secondStatus.storageKind).toBe('sqlite');
      expect(secondStatus.databasePath).toBe(path.join(projectDir, '_mailbox.sqlite'));
      expect(received.some((message) => message.id === sent.id)).toBe(true);
      await expect(fs.access(path.join(projectDir, '_mailbox.jsonl'))).rejects.toThrow();
      await expect(fs.access(path.join(projectDir, '_mailbox.registry.json'))).rejects.toThrow();
      await expect(fs.access(path.join(projectDir, '_mailbox.clients.json'))).rejects.toThrow();
    } finally {
      if (previousLease === undefined) {
        delete process.env['WRONGSTACK_MAILBOX_SERVER_CLIENT_LEASE_MS'];
      } else {
        process.env['WRONGSTACK_MAILBOX_SERVER_CLIENT_LEASE_MS'] = previousLease;
      }
      if (previousHeartbeat === undefined) {
        delete process.env['WRONGSTACK_MAILBOX_CLIENT_HEARTBEAT_MS'];
      } else {
        process.env['WRONGSTACK_MAILBOX_CLIENT_HEARTBEAT_MS'] = previousHeartbeat;
      }
      if (previousInline === undefined) {
        delete process.env['WRONGSTACK_MAILBOX_INLINE'];
      } else {
        process.env['WRONGSTACK_MAILBOX_INLINE'] = previousInline;
      }
      await first.close();
      await second.close();
      const control = new MailboxProjectServerConnection(projectDir);
      await control.shutdown('test-complete').catch(() => undefined);
      control.close();
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  });

  it('keeps fan-out completion actor-scoped until every recipient completes', async () => {
    const previousInline = process.env['WRONGSTACK_MAILBOX_INLINE'];
    delete process.env['WRONGSTACK_MAILBOX_INLINE'];
    const mailbox = new RemoteMailbox({ projectDir, isolatedConnection: true });
    try {
      await mailbox.initialize();
      await mailbox.registerAgent({
        agentId: 'worker@one',
        sessionId: 'fanout-session',
        name: 'Worker one',
        role: 'worker',
      });
      await mailbox.registerAgent({
        agentId: 'worker@two',
        sessionId: 'fanout-session',
        name: 'Worker two',
        role: 'worker',
      });
      const sent = await mailbox.send({
        from: 'leader@fanout',
        to: '*',
        type: 'broadcast',
        subject: 'actor-scoped completion',
        body: 'both workers must complete this',
      });

      await mailbox.ack({
        messageId: sent.id,
        readerId: 'worker@one',
        completed: true,
        outcome: 'one done',
      });

      expect(
        (await mailbox.query({ incompleteOnly: true })).map((message) => message.id),
      ).toContain(sent.id);
      expect(
        (await mailbox.query({ limit: 10 })).find((message) => message.id === sent.id),
      ).toMatchObject({ completed: false });
      expect(
        (await mailbox.query({ limit: 10, includeReceiptState: true })).find(
          (message) => message.id === sent.id,
        ),
      ).toMatchObject({
        completed: false,
        recipientState: {
          'worker@one': {
            completedBy: 'worker@one',
            outcome: 'one done',
          },
        },
      });
      expect(
        (await mailbox.query({ unreadBy: 'worker@two', incompleteOnly: true })).map(
          (message) => message.id,
        ),
      ).toContain(sent.id);

      await mailbox.ack({
        messageId: sent.id,
        readerId: 'worker@two',
        completed: true,
        outcome: 'two done',
      });
      expect(
        (await mailbox.query({ incompleteOnly: true })).map((message) => message.id),
      ).not.toContain(sent.id);
      expect(
        (await mailbox.query({ limit: 10 })).find((message) => message.id === sent.id),
      ).toMatchObject({ completed: true });
    } finally {
      await mailbox.close();
      const control = new MailboxProjectServerConnection(projectDir);
      await control.shutdown('fanout-test-complete').catch(() => undefined);
      control.close();
      if (previousInline === undefined) {
        delete process.env['WRONGSTACK_MAILBOX_INLINE'];
      } else {
        process.env['WRONGSTACK_MAILBOX_INLINE'] = previousInline;
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  });

  it('imports legacy JSONL and registries once, then persists every operation in SQLite', async () => {
    // The JSONL writer is gone, so the fixture is written by hand. That is
    // the point of this test: users upgrading from the file-based mailbox
    // still have these files on disk, and the owner has to carry them into
    // SQLite exactly once.
    const legacyMessage = {
      id: 'legacy-import-1',
      from: 'leader@legacy',
      to: 'worker@legacy',
      type: 'assign',
      subject: 'legacy-import',
      body: 'must survive storage migration',
      priority: 'normal',
      timestamp: new Date(Date.now() - 60_000).toISOString(),
      readBy: {},
      completed: false,
    };
    const nowIso = new Date().toISOString();
    await fs.writeFile(
      path.join(projectDir, '_mailbox.jsonl'),
      [
        JSON.stringify(legacyMessage),
        JSON.stringify({
          __mailboxReceipt: 2,
          messageId: legacyMessage.id,
          actorId: 'worker@legacy',
          timestamp: nowIso,
          read: true,
          completed: true,
          outcome: 'done before migration',
        }),
        '',
      ].join(String.fromCharCode(10)),
      'utf8',
    );
    await fs.writeFile(
      path.join(projectDir, '_mailbox.registry.json'),
      JSON.stringify({
        'worker@legacy': {
          agentId: 'worker@legacy',
          sessionId: 'legacy-session',
          name: 'Legacy worker',
          role: 'worker',
          status: 'idle',
          iterations: 0,
          toolCalls: 0,
          registeredAt: nowIso,
          lastSeenAt: nowIso,
        },
      }),
      'utf8',
    );
    await fs.writeFile(
      path.join(projectDir, '_mailbox.clients.json'),
      JSON.stringify({
        'client@legacy': {
          clientId: 'client@legacy',
          sessionId: 'legacy-session',
          name: 'Legacy TUI',
          source: 'tui',
          registeredAt: nowIso,
          lastSeenAt: nowIso,
        },
      }),
      'utf8',
    );
    // Same story as the mailbox above: the writer that produced
    // `_mailbox_credentials.json` is gone, so the fixture is built from the
    // credential factory and written out by hand. `createMailboxCredential`
    // mints the record without touching storage, which is exactly what a
    // pre-SQLite install left on disk.
    const legacyCredential = createMailboxCredential({
      principalId: 'worker@legacy',
      projectId: path.basename(projectDir),
      kind: 'agent',
      capabilities: ['mail.read.self'],
      ttlMs: 60_000,
    });
    await fs.writeFile(
      path.join(projectDir, '_mailbox_credentials.json'),
      `${JSON.stringify(legacyCredential.credential)}${String.fromCharCode(10)}`,
      'utf8',
    );

    const legacyJsonlPath = path.join(projectDir, '_mailbox.jsonl');
    const legacyBefore = await fs.readFile(legacyJsonlPath, 'utf8');
    const legacyCredentialPath = path.join(projectDir, '_mailbox_credentials.json');
    const credentialsBefore = await fs.readFile(legacyCredentialPath, 'utf8');
    const previousInline = process.env['WRONGSTACK_MAILBOX_INLINE'];
    delete process.env['WRONGSTACK_MAILBOX_INLINE'];
    const mailbox = new RemoteMailbox({ projectDir, isolatedConnection: true });
    try {
      await mailbox.initialize();
      const imported = await mailbox.query({
        to: 'worker@legacy',
        includeReceiptState: true,
      });
      expect(imported).toHaveLength(1);
      expect(imported[0]?.readBy['worker@legacy']).toBeDefined();
      expect(await mailbox.getAgentStatuses()).toEqual([
        expect.objectContaining({ agentId: 'worker@legacy', online: true }),
      ]);
      expect(await mailbox.getClientStatuses()).toEqual([
        expect.objectContaining({ clientId: 'client@legacy', online: true }),
      ]);
      expect(
        await mailbox.credentialVerify(
          legacyCredential.credential.credentialId,
          legacyCredential.secret,
        ),
      ).toMatchObject({ valid: true });
      const sqliteCredential = await mailbox.credentialIssue({
        principalId: 'worker@sqlite',
        projectId: path.basename(projectDir),
        kind: 'agent',
        capabilities: ['mail.read.self'],
        ttlMs: 60_000,
      });
      expect(
        await mailbox.credentialVerify(
          sqliteCredential.credential.credentialId,
          sqliteCredential.secret,
        ),
      ).toMatchObject({ valid: true });

      const sqliteOnly = await mailbox.send({
        from: 'leader@sqlite',
        to: 'worker@sqlite',
        type: 'note',
        subject: 'sqlite-only',
        body: 'must not be appended to JSONL',
      });
      await mailbox.ack({
        messageId: sqliteOnly.id,
        readerId: 'worker@sqlite',
        completed: true,
      });
    } finally {
      await mailbox.close();
      const control = new MailboxProjectServerConnection(projectDir);
      await control.shutdown('migration-test-complete').catch(() => undefined);
      control.close();
      if (previousInline === undefined) {
        delete process.env['WRONGSTACK_MAILBOX_INLINE'];
      } else {
        process.env['WRONGSTACK_MAILBOX_INLINE'] = previousInline;
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }

    expect(await fs.readFile(legacyJsonlPath, 'utf8')).toBe(legacyBefore);
    expect(await fs.readFile(legacyCredentialPath, 'utf8')).toBe(credentialsBefore);
    const databasePath = path.join(projectDir, '_mailbox.sqlite');
    const db = new DatabaseSync(databasePath);
    try {
      expect(
        (db.prepare('SELECT COUNT(*) AS count FROM messages').get() as { count: number }).count,
      ).toBe(2);
      expect(
        (
          db.prepare('SELECT COUNT(*) AS count FROM message_receipts').get() as {
            count: number;
          }
        ).count,
      ).toBe(2);
      expect(
        (
          db
            .prepare("SELECT value FROM mailbox_meta WHERE key = 'legacy_files_imported'")
            .get() as { value: string }
        ).value,
      ).toBeTruthy();
      expect(
        (db.prepare('SELECT COUNT(*) AS count FROM credentials').get() as { count: number }).count,
      ).toBe(2);
    } finally {
      db.close();
    }
  });

  it('stops the owner after the last client disconnects and idle time elapses', async () => {
    const previousIdle = process.env['WRONGSTACK_MAILBOX_SERVER_IDLE_MS'];
    const previousInline = process.env['WRONGSTACK_MAILBOX_INLINE'];
    process.env['WRONGSTACK_MAILBOX_SERVER_IDLE_MS'] = '150';
    delete process.env['WRONGSTACK_MAILBOX_INLINE'];
    const mailbox = new RemoteMailbox({ projectDir, isolatedConnection: true });
    try {
      await mailbox.initialize();
      expect((await mailbox.status()).pid).toBeGreaterThan(0);
      const metadataPath = mailboxProjectServerMetadataPath(projectDir);
      const readyDeadline = Date.now() + 2_000;
      let metadataReady = false;
      while (Date.now() < readyDeadline) {
        try {
          await fs.access(metadataPath);
          metadataReady = true;
          break;
        } catch {
          await new Promise((resolve) => setTimeout(resolve, 25));
        }
      }
      expect(metadataReady).toBe(true);
      await mailbox.close();
      const deadline = Date.now() + 3_000;
      while (Date.now() < deadline) {
        try {
          await fs.access(metadataPath);
        } catch {
          break;
        }
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      await expect(fs.access(metadataPath)).rejects.toThrow();
    } finally {
      await mailbox.close();
      if (previousIdle === undefined) {
        delete process.env['WRONGSTACK_MAILBOX_SERVER_IDLE_MS'];
      } else {
        process.env['WRONGSTACK_MAILBOX_SERVER_IDLE_MS'] = previousIdle;
      }
      if (previousInline === undefined) {
        delete process.env['WRONGSTACK_MAILBOX_INLINE'];
      } else {
        process.env['WRONGSTACK_MAILBOX_INLINE'] = previousInline;
      }
    }
  });

  it('completes an explicit shutdown while the requesting IPC socket is open', async () => {
    const previousInline = process.env['WRONGSTACK_MAILBOX_INLINE'];
    delete process.env['WRONGSTACK_MAILBOX_INLINE'];
    const mailbox = new RemoteMailbox({ projectDir, isolatedConnection: true });
    const control = new MailboxProjectServerConnection(projectDir);
    try {
      await mailbox.initialize();
      const metadataPath = mailboxProjectServerMetadataPath(projectDir);
      const readyDeadline = Date.now() + 2_000;
      while (Date.now() < readyDeadline) {
        try {
          await fs.access(metadataPath);
          break;
        } catch {
          await new Promise((resolve) => setTimeout(resolve, 25));
        }
      }
      await mailbox.close();
      const result = await control.shutdown('explicit-shutdown-regression');
      expect(result.stopped).toBe(true);

      const stoppedDeadline = Date.now() + 3_000;
      while (Date.now() < stoppedDeadline) {
        try {
          await fs.access(metadataPath);
          await new Promise((resolve) => setTimeout(resolve, 25));
        } catch {
          break;
        }
      }
      await expect(fs.access(metadataPath)).rejects.toThrow();
    } finally {
      await mailbox.close().catch(() => undefined);
      control.close();
      if (previousInline === undefined) {
        delete process.env['WRONGSTACK_MAILBOX_INLINE'];
      } else {
        process.env['WRONGSTACK_MAILBOX_INLINE'] = previousInline;
      }
    }
  });
});

describe('WS-025 credential verifier redaction at the IPC boundary', () => {
  it('never returns the verifier over credentialGet, credentialList, or credentialVerify', async () => {
    const previousInline = process.env['WRONGSTACK_MAILBOX_INLINE'];
    delete process.env['WRONGSTACK_MAILBOX_INLINE'];
    const mailbox = new RemoteMailbox({ projectDir, isolatedConnection: true });
    try {
      await mailbox.initialize();

      // Issuance legitimately returns the full credential plus the secret once;
      // capture the verifier so we can assert it never crosses the wire again.
      const issued = await mailbox.credentialIssue({
        principalId: 'worker@redact',
        projectId: path.basename(projectDir),
        kind: 'agent',
        capabilities: ['mail.read.self'],
        ttlMs: 60_000,
      });
      const verifier = issued.credential.verifier;
      expect(verifier).toMatch(/^[0-9a-f]{64}$/);
      const credentialId = issued.credential.credentialId;

      // Read surfaces must be redacted.
      const fetched = await mailbox.credentialGet(credentialId);
      expect(fetched).not.toBeNull();
      expect(JSON.stringify(fetched)).not.toContain(verifier);
      const listed = await mailbox.credentialList();
      expect(listed.length).toBeGreaterThan(0);
      expect(JSON.stringify(listed)).not.toContain(verifier);

      // Verify a REVOKED credential with a garbage secret: this exercises the
      // store branch that embeds the full record before the HMAC check — the
      // exact path the audit flagged. The IPC response must drop it entirely.
      await mailbox.credentialRevoke(credentialId, 'redaction-regression', 'tester@redact');
      const invalid = await mailbox.credentialVerify(credentialId, 'not-the-real-secret');
      expect(invalid.valid).toBe(false);
      expect(invalid.credential).toBeUndefined();
      expect(JSON.stringify(invalid)).not.toContain(verifier);

      // Verify with the CORRECT secret: the valid branch must also strip the
      // verifier. We issue a fresh credential (the previous one is revoked).
      const issued2 = await mailbox.credentialIssue({
        principalId: 'valid@redact',
        projectId: path.basename(projectDir),
        kind: 'agent',
        capabilities: ['mail.read.self'],
        ttlMs: 60_000,
      });
      const valid = await mailbox.credentialVerify(issued2.credential.credentialId, issued2.secret);
      expect(valid.valid).toBe(true);
      expect(valid.credential).toBeDefined();
      expect(valid.credential?.credentialId).toBe(issued2.credential.credentialId);
      // The verifier must be absent even on the valid path.
      expect('verifier' in (valid.credential ?? {})).toBe(false);
      expect('verifierAlgorithm' in (valid.credential ?? {})).toBe(false);
      expect(JSON.stringify(valid)).not.toContain(issued2.credential.verifier);
    } finally {
      await mailbox.close();
      const control = new MailboxProjectServerConnection(projectDir);
      await control.shutdown('redaction-regression-complete').catch(() => undefined);
      control.close();
      if (previousInline === undefined) {
        delete process.env['WRONGSTACK_MAILBOX_INLINE'];
      } else {
        process.env['WRONGSTACK_MAILBOX_INLINE'] = previousInline;
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  });
});

// ── broadcast authentication (WS-098) ───────────────────────────────────────

/**
 * Sockets joined the daemon's `clients` set on `connection`, before presenting
 * any credential, and `broadcast()` wrote to every member — so a local process
 * that never read the owner-only metadata file still received the live event
 * stream, `mailbox.message_sent` (with `from`/`to`/`subject`) included.
 *
 * There was NO test asserting cross-process event delivery at all, which is why
 * gating the broadcast was risky to land: a regression would have been silent.
 * This exercises the real IPC path — two independent connections, one only
 * listening — so a broken gate fails here rather than in production.
 */
describe('mailbox IPC event broadcast (WS-098)', () => {
  it('delivers events over IPC to a connection that only listens', async () => {
    const previousInline = process.env['WRONGSTACK_MAILBOX_INLINE'];
    delete process.env['WRONGSTACK_MAILBOX_INLINE'];

    const listener = new MailboxProjectServerConnection(projectDir);
    const sender = new RemoteMailbox(projectDir);
    const seen: string[] = [];

    try {
      // `connect()` is the path RemoteMailbox uses fire-and-forget when it is
      // built purely for the event stream. It must be enough on its own to
      // start receiving broadcasts.
      await listener.connect();
      listener.onEvent((event) => seen.push(event));

      await sender.initialize();
      await sender.send({
        from: 'leader@bcast',
        to: 'worker@bcast',
        type: 'note',
        subject: 'broadcast-reaches-listening-clients',
        body: 'x',
      });

      // Poll rather than sleep a fixed amount: the broadcast is asynchronous,
      // and a fixed delay is either flaky or needlessly slow.
      const deadline = Date.now() + 5_000;
      while (seen.length === 0 && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 50));
      }
      expect(seen.some((e) => e.startsWith('mailbox.'))).toBe(true);
    } finally {
      listener.close();
      await sender.close().catch(() => undefined);
      const control = new MailboxProjectServerConnection(projectDir);
      await control.shutdown('broadcast-test-complete').catch(() => undefined);
      control.close();
      if (previousInline === undefined) delete process.env['WRONGSTACK_MAILBOX_INLINE'];
      else process.env['WRONGSTACK_MAILBOX_INLINE'] = previousInline;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }, 30_000);
});
