/**
 * WS-027 — the codebase-index project daemon refuses an unauthenticated peer.
 *
 * This daemon reads every file in the repository and answers content queries
 * over the resulting index. It had no handshake credential at all, so any
 * process that could open the socket could search the whole codebase through
 * it, or drive a reindex. The 0600 socket was the entire boundary — which only
 * excludes OTHER users, and on Windows named pipes does not even do that.
 *
 * Driven over the real socket, because the finding is about what crosses it.
 * Skips without a build, like the sibling idle-lifecycle test: `dist/` is
 * gitignored and the CI test job runs from source.
 */
import { type ChildProcess, spawn } from 'node:child_process';
import * as fsSync from 'node:fs';
import * as fs from 'node:fs/promises';
import * as net from 'node:net';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { projectIndexServerEndpoint } from '../src/codebase-index/project-server-endpoint.js';
import type { ProjectIndexServerMetadata } from '../src/codebase-index/project-server-protocol.js';

const distServer = fileURLToPath(
  new URL('../dist/codebase-index/project-server.js', import.meta.url),
);
const coreDist = fileURLToPath(new URL('../../core/dist/index.js', import.meta.url));
const distReady = fsSync.existsSync(distServer) && fsSync.existsSync(coreDist);

const children: ChildProcess[] = [];
const roots: string[] = [];

afterEach(async () => {
  for (const child of children.splice(0)) child.kill();
  await new Promise((r) => setTimeout(r, 200));
  for (const root of roots.splice(0)) {
    await fs.rm(root, { recursive: true, force: true }).catch(() => undefined);
  }
});

async function waitFor<T>(fn: () => Promise<T | undefined>, timeoutMs = 20_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await fn();
    if (value !== undefined) return value;
    if (Date.now() >= deadline) throw new Error('timed out waiting for the index daemon');
    await new Promise((r) => setTimeout(r, 100));
  }
}

/**
 * One request/response over a raw socket. Sends after `hello`, which the
 * daemon holds until its metadata file is on disk — so it doubles as the
 * readiness signal.
 */
function rawRequest(
  endpoint: string,
  request: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(endpoint);
    socket.setEncoding('utf8');
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new Error('timed out waiting for an index response'));
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
        if (frame['type'] === 'hello') {
          if (!sent) {
            sent = true;
            socket.write(`${JSON.stringify(request)}\n`);
          }
          continue;
        }
        if (frame['type'] === 'index-state' || frame['type'] === 'progress') continue;
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

async function startDaemon(): Promise<{ endpoint: string; metadataPath: string }> {
  const projectRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'wstack-index-authgate-'));
  roots.push(projectRoot);
  const indexDir = path.join(projectRoot, '.index');
  const endpoint = projectIndexServerEndpoint(projectRoot, indexDir);
  children.push(
    spawn(process.execPath, [distServer, '--project-root', projectRoot, '--index-dir', indexDir], {
      env: { ...process.env, WRONGSTACK_INDEX_SERVER_IDLE_MS: '30000' },
      stdio: 'ignore',
      windowsHide: true,
    }),
  );
  return { endpoint, metadataPath: path.join(indexDir, 'server.json') };
}

describe.skipIf(!distReady)('codebase-index daemon auth gate (WS-027)', () => {
  it('refuses index queries from a peer that did not read the metadata file', async () => {
    const { endpoint, metadataPath } = await startDaemon();

    const metadata = await waitFor(async () => {
      try {
        return JSON.parse(await fs.readFile(metadataPath, 'utf8')) as ProjectIndexServerMetadata;
      } catch {
        return undefined;
      }
    });
    expect(metadata.authToken).toMatch(/^[0-9a-f]{32}$/);

    // 1. `ping` is the cheapest probe and was fully open; it reports index
    //    health, which already tells a caller the daemon is worth attacking.
    const denied = await waitFor(async () => {
      try {
        return await rawRequest(endpoint, { type: 'ping', id: 1 });
      } catch {
        return undefined;
      }
    });
    expect(denied).toMatchObject({ ok: false, errorName: 'UnauthorizedIndexRequest' });

    // 2. The finding proper: searching the user's codebase through the daemon.
    const searchDenied = await rawRequest(endpoint, {
      type: 'request',
      id: 2,
      op: 'search',
      args: { query: 'password' },
    });
    expect(searchDenied).toMatchObject({ ok: false, errorName: 'UnauthorizedIndexRequest' });

    // 3. `configure` mutates daemon-wide watcher behaviour.
    const configureDenied = await rawRequest(endpoint, {
      type: 'configure',
      id: 3,
      watchExternal: true,
      debounceMs: 0,
    });
    expect(configureDenied).toMatchObject({ ok: false, errorName: 'UnauthorizedIndexRequest' });

    // 4. `shutdown` stops the daemon for every client.
    const shutdownDenied = await rawRequest(endpoint, { type: 'shutdown', id: 4 });
    expect(shutdownDenied).toMatchObject({ ok: false, errorName: 'UnauthorizedIndexRequest' });

    // 5. With the token from the owner-only file the same call goes through —
    //    the gate refuses ignorance of the file, not everyone.
    const allowed = await rawRequest(endpoint, {
      type: 'ping',
      id: 5,
      authToken: metadata.authToken,
    });
    expect(allowed).toMatchObject({ ok: true });

    // 6. A wrong token is refused: the gate is a comparison, not a presence
    //    check.
    const wrong = await rawRequest(endpoint, {
      type: 'ping',
      id: 6,
      authToken: 'f'.repeat(32),
    });
    expect(wrong).toMatchObject({ ok: false, errorName: 'UnauthorizedIndexRequest' });
  }, 45_000);

  it('never puts the token in the greeting', async () => {
    const { endpoint, metadataPath } = await startDaemon();
    await waitFor(async () => {
      try {
        await fs.readFile(metadataPath, 'utf8');
        return true;
      } catch {
        return undefined;
      }
    });

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
