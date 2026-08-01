/**
 * WS-027 — the mailbox project daemon refuses an unauthenticated peer.
 *
 * This daemon owns the project's message bus AND its credential store, and it
 * had no handshake credential at all: anything that could open the socket
 * could send mail as any agent, read every message, and issue or revoke
 * credentials. The 0600 socket was the entire boundary — which only excludes
 * OTHER users, and on Windows named pipes does not even do that.
 *
 * A token now travels only in the daemon's owner-only metadata file, so a
 * caller must prove it could read that file before it may act. It is
 * deliberately NOT in the `hello` frame: `hello` goes to every socket that
 * connects, which is precisely how the SAGE daemon ended up handing out its
 * own credential (WS-028).
 *
 * Driven over the real socket, because the finding is about what crosses it.
 */
import { type ChildProcess, spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import * as net from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  mailboxProjectServerEndpoint,
  mailboxProjectServerMetadataPath,
} from '../../src/coordination/mailbox-project-server-endpoint.js';
import type { MailboxProjectServerMetadata } from '../../src/coordination/mailbox-project-server-protocol.js';

// This drives a real daemon over its real socket, so it needs the built
// `dist/` entry points. `dist/` is gitignored and the CI test job runs from
// source with no build step, so — like the repo's other dist-dependent daemon
// tests — the suite skips unless the artifacts exist.
const SERVER_ENTRY = fileURLToPath(
  new URL('../../dist/coordination/mailbox-project-server.js', import.meta.url),
);
const CORE_INDEX = fileURLToPath(new URL('../../dist/coordination/index.js', import.meta.url));
const distReady = existsSync(SERVER_ENTRY) && existsSync(CORE_INDEX);

let projectDir: string;
let child: ChildProcess | undefined;

async function waitFor<T>(fn: () => Promise<T | undefined>, timeoutMs = 20_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await fn();
    if (value !== undefined) return value;
    if (Date.now() > deadline) throw new Error('timed out waiting for the mailbox daemon');
    await new Promise((r) => setTimeout(r, 100));
  }
}

interface RawConn {
  socket: net.Socket;
  next(predicate: (m: Record<string, unknown>) => boolean): Promise<Record<string, unknown>>;
}

function rawConnect(endpoint: string): Promise<RawConn> {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(endpoint);
    const frames: Array<Record<string, unknown>> = [];
    const waiters: Array<{
      predicate: (m: Record<string, unknown>) => boolean;
      resolve: (m: Record<string, unknown>) => void;
    }> = [];
    let buffer = '';
    socket.setEncoding('utf8');
    socket.on('data', (chunk: string) => {
      buffer += chunk;
      let idx = buffer.indexOf('\n');
      while (idx !== -1) {
        const line = buffer.slice(0, idx).trim();
        buffer = buffer.slice(idx + 1);
        if (line) {
          const parsed = JSON.parse(line) as Record<string, unknown>;
          frames.push(parsed);
          const hit = waiters.findIndex((w) => w.predicate(parsed));
          if (hit !== -1) waiters.splice(hit, 1)[0]?.resolve(parsed);
        }
        idx = buffer.indexOf('\n');
      }
    });
    socket.on('error', reject);
    socket.once('connect', () =>
      resolve({
        socket,
        next: (predicate) =>
          new Promise((res, rej) => {
            const existing = frames.findIndex(predicate);
            if (existing !== -1) {
              res(frames.splice(existing, 1)[0] as Record<string, unknown>);
              return;
            }
            const timer = setTimeout(() => rej(new Error('frame wait timed out')), 8_000);
            waiters.push({
              predicate,
              resolve: (m) => {
                clearTimeout(timer);
                res(m);
              },
            });
          }),
      }),
    );
  });
}

beforeEach(async () => {
  projectDir = await mkdtemp(join(tmpdir(), 'mailbox-authgate-'));
});

afterEach(async () => {
  child?.kill();
  child = undefined;
  await new Promise((r) => setTimeout(r, 200));
  await rm(projectDir, { recursive: true, force: true }).catch(() => undefined);
});

describe.skipIf(!distReady)('mailbox project daemon auth gate (WS-027)', () => {
  it('greets without a secret and refuses a peer that did not read the metadata file', async () => {
    child = spawn(process.execPath, [SERVER_ENTRY, '--project-dir', projectDir], {
      stdio: 'ignore',
      windowsHide: true,
    });

    const metadata = await waitFor(async () => {
      try {
        return JSON.parse(
          await readFile(mailboxProjectServerMetadataPath(projectDir), 'utf8'),
        ) as MailboxProjectServerMetadata;
      } catch {
        return undefined;
      }
    });
    expect(metadata.authToken).toMatch(/^[0-9a-f]{32}$/);

    const conn = await waitFor(async () => {
      try {
        return await rawConnect(mailboxProjectServerEndpoint(projectDir));
      } catch {
        return undefined;
      }
    });

    try {
      // 1. The greeting must not carry the secret.
      const hello = await conn.next((m) => m['type'] === 'hello');
      expect(Object.keys(hello)).not.toContain('authToken');

      // 2. A peer that only saw the greeting cannot act. `send` is the sharp
      //    edge: it injects a message into the project's agent bus.
      conn.socket.write(
        `${JSON.stringify({
          type: 'request',
          id: 1,
          op: 'send',
          args: { input: { from: 'attacker', to: 'leader', body: 'do this', type: 'task' } },
        })}\n`,
      );
      const denied = await conn.next((m) => m['type'] === 'response' && m['id'] === 1);
      expect(denied).toMatchObject({ ok: false, errorName: 'UnauthorizedMailboxRequest' });

      // 3. Credential administration is behind the same gate.
      conn.socket.write(
        `${JSON.stringify({ type: 'request', id: 2, op: 'credentialList', args: {} })}\n`,
      );
      const credentialsDenied = await conn.next((m) => m['type'] === 'response' && m['id'] === 2);
      expect(credentialsDenied).toMatchObject({ ok: false });

      // 4. Same request WITH the token from the owner-only file succeeds — the
      //    gate refuses ignorance of the file, not everyone.
      conn.socket.write(
        `${JSON.stringify({
          type: 'request',
          id: 3,
          op: 'ping',
          args: {},
          authToken: metadata.authToken,
        })}\n`,
      );
      const allowed = await conn.next((m) => m['type'] === 'response' && m['id'] === 3);
      expect(allowed).toMatchObject({ ok: true });

      // 5. `shutdown` is gated too — it stops the bus for the whole project.
      conn.socket.write(`${JSON.stringify({ type: 'shutdown', id: 4 })}\n`);
      const shutdownDenied = await conn.next((m) => m['type'] === 'response' && m['id'] === 4);
      expect(shutdownDenied).toMatchObject({ ok: false, errorName: 'UnauthorizedMailboxRequest' });
    } finally {
      conn.socket.destroy();
    }
  }, 45_000);

  it('the real client authenticates by reading the metadata file', async () => {
    const { MailboxProjectServerConnection } = (await import(
      fileURLToPath(new URL('../../dist/coordination/index.js', import.meta.url))
    )) as typeof import('../../src/coordination/index.js');
    const connection = new MailboxProjectServerConnection(projectDir);
    try {
      await connection.connect();
      // A round-trip through the gate. It passes only because the client read
      // the owner-only metadata file — there is nothing on the wire to copy.
      const status = await connection.call('ping', {});
      expect(status.pid).toBeGreaterThan(0);
    } finally {
      await connection.shutdown('test-teardown').catch(() => undefined);
      connection.close();
    }
  }, 45_000);

  it('invalidates a stale cached token on refusal and recovers by re-reading the metadata', async () => {
    // The WS-027 race the bounded retry exists to absorb: the client holds a
    // token the daemon no longer accepts (a restarted daemon mints a new one;
    // a crashed predecessor's `.mailbox-server.json` can be read before the
    // winner overwrites it). Without invalidate-on-refusal + bounded retry,
    // every request on that connection is refused forever.
    child = spawn(process.execPath, [SERVER_ENTRY, '--project-dir', projectDir], {
      stdio: 'ignore',
      windowsHide: true,
    });
    const metadata = await waitFor(async () => {
      try {
        return JSON.parse(
          await readFile(mailboxProjectServerMetadataPath(projectDir), 'utf8'),
        ) as MailboxProjectServerMetadata;
      } catch {
        return undefined;
      }
    });
    expect(metadata.authToken).toMatch(/^[0-9a-f]{32}$/);

    const { MailboxProjectServerConnection } = (await import(
      fileURLToPath(new URL('../../dist/coordination/index.js', import.meta.url))
    )) as typeof import('../../src/coordination/index.js');
    const connection = new MailboxProjectServerConnection(projectDir);
    try {
      await connection.connect();
      expect((await connection.call('ping', {})).pid).toBeGreaterThan(0);

      // Force the sticky-stale-token state: the cached token no longer matches
      // the daemon's. The next request is refused with
      // `UnauthorizedMailboxRequest`; `onMessage` drops the cache and the
      // bounded retry re-reads the owner-only file (still the real token) and
      // succeeds on the same connection.
      (connection as unknown as { authToken: string | undefined }).authToken = 'f'.repeat(32);
      const recovered = await connection.call('ping', {});
      expect(recovered.pid).toBeGreaterThan(0);
    } finally {
      await connection.shutdown('stale-token-teardown').catch(() => undefined);
      connection.close();
    }
  }, 45_000);
});
