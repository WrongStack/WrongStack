/**
 * WS-027 — the chronicle project daemon refuses an unauthenticated peer.
 *
 * This daemon owns the project's chronicle: the durable record of what every
 * agent did. It had no handshake credential at all, so any process that could
 * open the socket could read that history or append to it. The 0600 socket was
 * the entire boundary — which only excludes OTHER users, and on Windows named
 * pipes does not even do that.
 *
 * Driven over the real socket, because the finding is about what crosses it.
 */
import { type ChildProcess, spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import * as net from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  chronicleProjectServerEndpoint,
  chronicleProjectServerMetadataPath,
} from '../../src/chronicle/project-server-endpoint.js';
import type { ChronicleProjectServerMetadata } from '../../src/chronicle/project-server-protocol.js';

// Needs the built `dist/` entry point. `dist/` is gitignored and the CI test
// job runs from source with no build step, so — like the repo's other
// dist-dependent daemon tests — this suite skips unless the artifact exists.
const SERVER_ENTRY = fileURLToPath(
  new URL('../../dist/chronicle/project-server.js', import.meta.url),
);
const distReady = existsSync(SERVER_ENTRY);

let projectRoot: string;
let projectDir: string;
let globalRoot: string;
let child: ChildProcess | undefined;

async function waitFor<T>(fn: () => Promise<T | undefined>, timeoutMs = 20_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await fn();
    if (value !== undefined) return value;
    if (Date.now() > deadline) throw new Error('timed out waiting for the chronicle daemon');
    await new Promise((r) => setTimeout(r, 100));
  }
}

/** One request/response over a raw socket, optionally carrying a token. */
function rawRequest(
  endpoint: string,
  request: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(endpoint);
    socket.setEncoding('utf8');
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new Error('timed out waiting for a chronicle response'));
    }, 10_000);
    let buffer = '';
    let sent = false;
    socket.on('data', (chunk: string) => {
      buffer += chunk;
      for (;;) {
        const nl = buffer.indexOf('\n');
        if (nl === -1) return;
        const line = buffer.slice(0, nl);
        buffer = buffer.slice(nl + 1);
        if (!line.trim()) continue;
        const frame = JSON.parse(line) as Record<string, unknown>;
        // The daemon holds `hello` until its metadata is on disk, so this is
        // also the readiness signal — send only after it arrives.
        if (frame['type'] === 'hello') {
          if (!sent) {
            sent = true;
            socket.write(`${JSON.stringify(request)}\n`);
          }
          continue;
        }
        if (frame['type'] === 'event') continue;
        clearTimeout(timer);
        socket.destroy();
        resolve(frame);
        return;
      }
    });
    socket.on('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
  });
}

beforeEach(async () => {
  projectRoot = await mkdtemp(join(tmpdir(), 'chronicle-authgate-'));
  // The endpoint and the metadata path are both keyed on `projectDir`, which
  // is the per-project state directory, not the repo root.
  projectDir = join(projectRoot, '.state');
  globalRoot = join(projectRoot, '.global');
  await mkdir(projectDir, { recursive: true });
  await mkdir(globalRoot, { recursive: true });
});

function spawnDaemon(): ChildProcess {
  return spawn(
    process.execPath,
    [
      SERVER_ENTRY,
      '--project-root',
      projectRoot,
      '--global-root',
      globalRoot,
      '--project-id',
      'authgate-project',
      '--project-dir',
      projectDir,
      '--workspace-id',
      'authgate-workspace',
    ],
    { stdio: 'ignore', windowsHide: true },
  );
}

afterEach(async () => {
  child?.kill();
  child = undefined;
  await new Promise((r) => setTimeout(r, 200));
  await rm(projectRoot, { recursive: true, force: true }).catch(() => undefined);
});

describe.skipIf(!distReady)('chronicle project daemon auth gate (WS-027)', () => {
  it('greets without a secret and refuses a peer that did not read the metadata file', async () => {
    child = spawnDaemon();

    const metadata = await waitFor(async () => {
      try {
        return JSON.parse(
          await readFile(chronicleProjectServerMetadataPath(projectDir), 'utf8'),
        ) as ChronicleProjectServerMetadata;
      } catch {
        return undefined;
      }
    });
    expect(metadata.authToken).toMatch(/^[0-9a-f]{32}$/);
    // The greeting payload on disk is the same object minus the secret — the
    // daemon builds metadata as `{...serverInfo, authToken}`.
    expect(metadata.pid).toBeGreaterThan(0);

    const endpoint = chronicleProjectServerEndpoint(projectDir);

    // 1. A peer with no credential cannot read the project's history.
    const denied = await waitFor(async () => {
      try {
        return await rawRequest(endpoint, { type: 'request', id: 1, op: 'ping', args: {} });
      } catch {
        return undefined;
      }
    });
    expect(denied).toMatchObject({
      ok: false,
      errorName: 'UnauthorizedChronicleRequest',
    });

    // 2. The same request WITH the token from the owner-only file succeeds —
    //    the gate refuses ignorance of the file, not everyone.
    const allowed = await rawRequest(endpoint, {
      type: 'request',
      id: 2,
      op: 'ping',
      args: {},
      authToken: metadata.authToken,
    });
    expect(allowed).toMatchObject({ ok: true });

    // 3. A wrong token is refused — the gate is a comparison, not a presence
    //    check.
    const wrong = await rawRequest(endpoint, {
      type: 'request',
      id: 3,
      op: 'ping',
      args: {},
      authToken: 'f'.repeat(32),
    });
    expect(wrong).toMatchObject({ ok: false, errorName: 'UnauthorizedChronicleRequest' });

    // 4. `shutdown` is gated too — it stops the daemon for every client.
    const shutdownDenied = await rawRequest(endpoint, { type: 'shutdown', id: 4 });
    expect(shutdownDenied).toMatchObject({
      ok: false,
      errorName: 'UnauthorizedChronicleRequest',
    });
  }, 45_000);

  it('never puts the token in the greeting', async () => {
    child = spawnDaemon();
    await waitFor(async () => {
      try {
        await readFile(chronicleProjectServerMetadataPath(projectDir), 'utf8');
        return true;
      } catch {
        return undefined;
      }
    });

    const endpoint = chronicleProjectServerEndpoint(projectDir);
    const hello = await waitFor(async () => {
      try {
        return await new Promise<Record<string, unknown>>((resolve, reject) => {
          const socket = net.createConnection(endpoint);
          socket.setEncoding('utf8');
          const timer = setTimeout(() => {
            socket.destroy();
            reject(new Error('no hello'));
          }, 8_000);
          let buffer = '';
          socket.on('data', (chunk: string) => {
            buffer += chunk;
            const nl = buffer.indexOf('\n');
            if (nl === -1) return;
            clearTimeout(timer);
            const frame = JSON.parse(buffer.slice(0, nl)) as Record<string, unknown>;
            socket.destroy();
            resolve(frame);
          });
          socket.on('error', (error) => {
            clearTimeout(timer);
            reject(error);
          });
        });
      } catch {
        return undefined;
      }
    });

    expect(hello['type']).toBe('hello');
    // The SAGE daemon shipped its token here (WS-028). This one must not.
    expect(Object.keys(hello)).not.toContain('authToken');
  }, 45_000);
});
