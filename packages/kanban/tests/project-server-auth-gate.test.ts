/**
 * WS-027 — the kanban project daemon refuses an unauthenticated peer.
 *
 * This daemon owns every board in the project: it creates, mutates and deletes
 * them, and it drives the workflow command queue that other agents act on. It
 * had no handshake credential at all — anything that could open the socket
 * could do all of it. The 0700 socket directory only excludes OTHER users, and
 * on Windows named pipes it does not even do that, so "any process running as
 * you" was the entire boundary.
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
import { kanbanProjectServerEndpoint } from '../src/server/endpoint.js';

// This drives a real daemon over its real socket, so it needs the built
// `dist/` entry point. `dist/` is gitignored and the CI test job runs from
// source with no build step, so — like the repo's other dist-dependent daemon
// tests — the suite skips unless the artifact exists. The daemon also imports
// `@wrongstack/core/*`, whose package `exports` resolve to `core/dist/*`.
const SERVER_ENTRY = fileURLToPath(new URL('../dist/project-server.js', import.meta.url));
const CORE_INDEX = fileURLToPath(new URL('../../core/dist/index.js', import.meta.url));
const distReady = existsSync(SERVER_ENTRY) && existsSync(CORE_INDEX);

let root: string;
let child: ChildProcess | undefined;

async function waitFor<T>(fn: () => Promise<T | undefined>, timeoutMs = 20_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await fn();
    if (value !== undefined) return value;
    if (Date.now() > deadline) throw new Error('timed out waiting for the kanban daemon');
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
      reject(new Error('timed out waiting for a kanban response'));
    }, 8_000);
    let buffer = '';
    socket.on('data', (chunk: string) => {
      buffer += chunk;
      for (;;) {
        const nl = buffer.indexOf('\n');
        if (nl === -1) return;
        const line = buffer.slice(0, nl);
        buffer = buffer.slice(nl + 1);
        if (!line.trim()) continue;
        const frame = JSON.parse(line) as Record<string, unknown>;
        // Skip the greeting and any broadcast events.
        if (frame['type'] === 'hello' || frame['type'] === 'event') continue;
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
    socket.once('connect', () => socket.write(`${JSON.stringify(request)}\n`));
  });
}

function spawnDaemon(projectRoot: string): ChildProcess {
  return spawn(process.execPath, [SERVER_ENTRY, '--project-root', projectRoot], {
    env: {
      ...process.env,
      WRONGSTACK_KANBAN_FORCE_IPC: '1',
      WRONGSTACK_KANBAN_SERVER_IDLE_MS: '30000',
    },
    stdio: 'ignore',
    windowsHide: true,
  });
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'kanban-authgate-'));
});

afterEach(async () => {
  child?.kill();
  child = undefined;
  await new Promise((r) => setTimeout(r, 250));
  await rm(root, { recursive: true, force: true }).catch(() => undefined);
});

describe.skipIf(!distReady)('kanban project daemon auth gate (WS-027)', () => {
  it('refuses board operations from a peer that did not read the metadata file', async () => {
    child = spawnDaemon(root);

    const metadata = await waitFor(async () => {
      try {
        return JSON.parse(
          await readFile(join(root, '.wrongstack', 'kanban-server.json'), 'utf8'),
        ) as { authToken: string; pid: number };
      } catch {
        return undefined;
      }
    });
    expect(metadata.authToken).toMatch(/^[0-9a-f]{32}$/);

    const endpoint = kanbanProjectServerEndpoint(root);

    // 1. A mutating operation from an unauthenticated peer is refused. This is
    //    the finding: creating a board is agent-visible work the daemon used
    //    to accept from anyone.
    const denied = await waitFor(async () => {
      try {
        return await rawRequest(endpoint, {
          id: 1,
          method: 'storageWriteBoard',
          params: { board: { id: 'evil', title: 'injected', columns: [] } },
        });
      } catch {
        return undefined;
      }
    });
    expect(denied).toMatchObject({ id: 1, error: { code: 'UNAUTHORIZED' } });

    // 2. Reads are gated too — board contents are project data.
    const readDenied = await rawRequest(endpoint, {
      id: 2,
      method: 'storageListBoardIds',
      params: {},
    });
    expect(readDenied).toMatchObject({ id: 2, error: { code: 'UNAUTHORIZED' } });

    // 3. With the token from the owner-only file the same call goes through:
    //    the gate refuses ignorance of the file, not everyone.
    const allowed = await rawRequest(endpoint, {
      id: 3,
      method: 'storageListBoardIds',
      params: {},
      authToken: metadata.authToken,
    });
    expect(allowed['error']).toBeUndefined();

    // 4. A wrong token is refused — the gate is a comparison, not a presence
    //    check.
    const wrong = await rawRequest(endpoint, {
      id: 4,
      method: 'storageListBoardIds',
      params: {},
      authToken: 'f'.repeat(32),
    });
    expect(wrong).toMatchObject({ id: 4, error: { code: 'UNAUTHORIZED' } });
  }, 45_000);

  it('never puts the token in the greeting', async () => {
    child = spawnDaemon(root);
    await waitFor(async () => {
      try {
        await readFile(join(root, '.wrongstack', 'kanban-server.json'), 'utf8');
        return true;
      } catch {
        return undefined;
      }
    });

    const endpoint = kanbanProjectServerEndpoint(root);
    const hello = await waitFor(async () => {
      try {
        return await new Promise<Record<string, unknown>>((resolve, reject) => {
          const socket = net.createConnection(endpoint);
          socket.setEncoding('utf8');
          const timer = setTimeout(() => {
            socket.destroy();
            reject(new Error('no hello'));
          }, 5_000);
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
