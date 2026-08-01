/**
 * WS-028 — the SAGE daemon's auth gate actually refuses an unauthenticated peer.
 *
 * The daemon mints a per-process token and rejects any `request` whose
 * `meta.authToken` does not match. That gate was decorative: the token was a
 * field on `SageProjectServerInfo`, which IS the payload of the `hello` frame
 * the daemon sends to every socket that connects. Any same-UID process could
 * open the socket, read the token out of the greeting, and replay it — so the
 * "must have read the owner-only server.json" boundary the code documents did
 * not exist.
 *
 * These drive a real daemon over its real socket, because the finding was
 * about what crosses the wire.
 */
import { type ChildProcess, spawn } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import * as net from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  sageProjectServerEndpoint,
  sageProjectServerMetadataPath,
} from '../src/project-server-endpoint.js';
import type {
  SageProjectServerMessage,
  SageProjectServerMetadata,
} from '../src/project-server-protocol.js';

const SERVER_ENTRY = fileURLToPath(new URL('../dist/project-server.js', import.meta.url));

let projectRoot: string;
let child: ChildProcess | undefined;

async function waitFor<T>(fn: () => Promise<T | undefined>, timeoutMs = 15_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await fn();
    if (value !== undefined) return value;
    if (Date.now() > deadline) throw new Error('timed out waiting for the SAGE daemon');
    await new Promise((r) => setTimeout(r, 100));
  }
}

/** Open a raw socket and collect newline-delimited frames. */
function rawConnect(endpoint: string): Promise<{
  socket: net.Socket;
  next(predicate: (m: SageProjectServerMessage) => boolean): Promise<SageProjectServerMessage>;
}> {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(endpoint);
    const frames: SageProjectServerMessage[] = [];
    const waiters: Array<{
      predicate: (m: SageProjectServerMessage) => boolean;
      resolve: (m: SageProjectServerMessage) => void;
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
          const parsed = JSON.parse(line) as SageProjectServerMessage;
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
              res(frames.splice(existing, 1)[0] as SageProjectServerMessage);
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
  projectRoot = await mkdtemp(join(tmpdir(), 'sage-authgate-'));
});

afterEach(async () => {
  child?.kill();
  child = undefined;
  await new Promise((r) => setTimeout(r, 150));
  await rm(projectRoot, { recursive: true, force: true }).catch(() => undefined);
});

describe('SAGE daemon auth gate', () => {
  it('never puts the token on the wire, and refuses a peer that did not read server.json', async () => {
    child = spawn(process.execPath, [SERVER_ENTRY, '--project-root', projectRoot], {
      stdio: 'ignore',
      windowsHide: true,
    });

    const metadataPath = sageProjectServerMetadataPath(projectRoot);
    const metadata = await waitFor(async () => {
      try {
        return JSON.parse(await readFile(metadataPath, 'utf8')) as SageProjectServerMetadata;
      } catch {
        return undefined;
      }
    });
    expect(metadata.authToken).toMatch(/^[0-9a-f]{32}$/);

    const endpoint = sageProjectServerEndpoint(projectRoot);
    const conn = await waitFor(async () => {
      try {
        return await rawConnect(endpoint);
      } catch {
        return undefined;
      }
    });

    try {
      // 1. The greeting must not carry the secret. This is the finding.
      const hello = await conn.next((m) => m.type === 'hello');
      expect(Object.keys(hello)).not.toContain('authToken');
      expect((hello as Record<string, unknown>)['authToken']).toBeUndefined();

      // 2. A peer that only saw the greeting cannot issue a request.
      conn.socket.write(
        `${JSON.stringify({
          type: 'request',
          id: 1,
          op: 'ping',
          args: {},
          meta: { clientId: 'attacker' },
        })}\n`,
      );
      const denied = await conn.next((m) => m.type === 'response' && m.id === 1);
      expect(denied).toMatchObject({ ok: false, errorName: 'UnauthorizedSageRequest' });

      // 3. The same request WITH the token from the owner-only file succeeds —
      //    the gate refuses ignorance of the file, not everyone.
      conn.socket.write(
        `${JSON.stringify({
          type: 'request',
          id: 2,
          op: 'ping',
          args: {},
          meta: { clientId: 'legit', authToken: metadata.authToken },
        })}\n`,
      );
      const allowed = await conn.next((m) => m.type === 'response' && m.id === 2);
      expect(allowed).toMatchObject({ ok: true });

      // 4. `shutdown` is gated too — it stops the daemon for every client, so
      //    one unauthenticated frame used to be a project-wide DoS.
      conn.socket.write(`${JSON.stringify({ type: 'shutdown', id: 3 })}\n`);
      const shutdownDenied = await conn.next((m) => m.type === 'response' && m.id === 3);
      expect(shutdownDenied).toMatchObject({ ok: false, errorName: 'UnauthorizedSageRequest' });
    } finally {
      conn.socket.destroy();
    }
  }, 40_000);

  it('the real client authenticates by reading server.json, not the greeting', async () => {
    // The dist build, because the client spawns `./project-server.js` relative
    // to its own module URL — from TypeScript source that file does not exist
    // and `isSageProjectServerAvailable()` is false.
    // Resolved at runtime, matching the repo's mailbox-bridge tests: a static
    // `../dist/...` specifier is a build artifact, so the import guard rejects
    // it and CI cannot resolve it before a build.
    const { SageProjectServerConnection } = (await import(
      pathToFileURL(fileURLToPath(new URL('../dist/index.js', import.meta.url))).href
    )) as typeof import('../src/index.js');
    const connection = new SageProjectServerConnection(projectRoot);
    try {
      await connection.connect();
      // A round-trip that goes through the auth gate. Before the fix this
      // passed by replaying the token out of `hello`; it now passes only
      // because the client read the owner-only metadata file.
      const status = await connection.call('ping', {}, { meta: { clientId: 'roundtrip' } });
      expect(status.pid).toBeGreaterThan(0);
      expect(status.projectRoot).toBeTruthy();

      const metadata = JSON.parse(
        await readFile(sageProjectServerMetadataPath(projectRoot), 'utf8'),
      ) as SageProjectServerMetadata;
      expect(metadata.authToken).toMatch(/^[0-9a-f]{32}$/);
    } finally {
      await connection.shutdown('test-teardown').catch(() => undefined);
      connection.close();
    }
  }, 40_000);
});
