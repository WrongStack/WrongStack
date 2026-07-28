/**
 * Kanban daemon lifecycle.
 *
 * There was no test here, which is why a `stop()` that never closed the
 * listening server went unnoticed: the daemon set `stopping = true`, refused
 * every subsequent request, and then stayed resident forever on a ref'd pipe
 * handle. Four such ~45MB orphans were found alive on a dev machine, pointed at
 * temp directories that had been deleted hours earlier.
 *
 * Modelled on packages/tools/tests/project-server-idle.test.ts.
 */
import { type ChildProcess, spawn } from 'node:child_process';
import * as fs from 'node:fs/promises';
import * as net from 'node:net';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { kanbanProjectServerEndpoint } from '../src/server/project-server.js';

// Emitted at the dist ROOT, not under dist/server/: `client.ts` is bundled
// into dist/index.js, so its `new URL('./project-server.js', import.meta.url)`
// resolves next to the index bundle. The build entry key must match that.
const distServer = fileURLToPath(new URL('../dist/project-server.js', import.meta.url));

async function waitForExit(child: ChildProcess, timeoutMs = 10_000): Promise<number | null> {
  if (child.exitCode !== null || child.signalCode !== null) return child.exitCode;
  return new Promise<number | null>((resolve, reject) => {
    const timer = setTimeout(() => {
      child.off('exit', onExit);
      reject(new Error('kanban project server did not exit'));
    }, timeoutMs);
    const onExit = (code: number | null) => {
      clearTimeout(timer);
      resolve(code);
    };
    child.once('exit', onExit);
  });
}

async function connectWithin(
  endpoint: string,
  timeoutMs = 8_000,
  diagnose?: () => string,
): Promise<net.Socket> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      return await new Promise<net.Socket>((resolve, reject) => {
        const socket = net.createConnection(endpoint);
        socket.once('connect', () => resolve(socket));
        socket.once('error', reject);
      });
    } catch (err) {
      if (Date.now() >= deadline) {
        throw new Error(`${(err as Error).message}${diagnose?.() ?? ''}`);
      }
      await new Promise((r) => setTimeout(r, 25));
    }
  }
}

/**
 * `idleMs` must be long enough for the test to win the race to connect —
 * the timer is armed at listen(), so too short a window and the daemon is
 * already gone before `connectWithin` lands.
 */
/** Captured stderr per child, so a failure reports WHY the daemon died. */
const daemonErr = new WeakMap<ChildProcess, { text: string }>();

function startDaemon(projectRoot: string, idleMs = 200): ChildProcess {
  const child = spawn(process.execPath, [distServer, '--project-root', projectRoot], {
    env: { ...process.env, WRONGSTACK_KANBAN_SERVER_IDLE_MS: String(idleMs) },
    stdio: ['ignore', 'ignore', 'pipe'],
    windowsHide: true,
  });
  const sink = { text: '' };
  daemonErr.set(child, sink);
  child.stderr?.on('data', (chunk: Buffer) => {
    sink.text += chunk.toString();
  });
  return child;
}

function why(child: ChildProcess): string {
  const captured = daemonErr.get(child)?.text.trim();
  return captured ? ` — daemon stderr: ${captured}` : ' — daemon wrote nothing to stderr';
}

describe('kanban project server lifecycle', () => {
  it('exits after the idle window when no client ever connects', async () => {
    const projectRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'wstack-kanban-idle-'));
    const child = startDaemon(projectRoot);
    try {
      // The idle timer must be armed at listen(), not only from the socket
      // 'close' handler — otherwise a spawned-but-never-connected daemon lives
      // forever with idleTimer === undefined.
      const code = await waitForExit(child);
      expect(code, why(child)).toBe(0);
    } finally {
      if (child.exitCode === null && child.signalCode === null) child.kill();
      await fs.rm(projectRoot, { recursive: true, force: true });
    }
  });

  it('exits after the last client disconnects', async () => {
    const projectRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'wstack-kanban-drop-'));
    const endpoint = kanbanProjectServerEndpoint(projectRoot);
    const child = startDaemon(projectRoot, 3_000);
    try {
      const socket = await connectWithin(endpoint, 8_000, () => why(child));
      socket.destroy();
      const code = await waitForExit(child);
      expect(code, why(child)).toBe(0);
    } finally {
      if (child.exitCode === null && child.signalCode === null) child.kill();
      await fs.rm(projectRoot, { recursive: true, force: true });
    }
  });

  it('stops serving and releases the endpoint on exit', async () => {
    const projectRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'wstack-kanban-endpoint-'));
    const endpoint = kanbanProjectServerEndpoint(projectRoot);
    const child = startDaemon(projectRoot, 3_000);
    try {
      const socket = await connectWithin(endpoint, 8_000, () => why(child));
      socket.destroy();
      await waitForExit(child);

      // A daemon that only flipped `stopping` would still accept and then
      // destroy connections here. A closed listener refuses them outright.
      await expect(
        new Promise<net.Socket>((resolve, reject) => {
          const s = net.createConnection(endpoint);
          s.once('connect', () => resolve(s));
          s.once('error', reject);
        }),
      ).rejects.toThrow();
    } finally {
      if (child.exitCode === null && child.signalCode === null) child.kill();
      await fs.rm(projectRoot, { recursive: true, force: true });
    }
  });
});

describe('kanban project server endpoint', () => {
  it('maps case-variant Windows roots to the same endpoint', () => {
    // Without canonicalization `D:\x` and `d:\x` hashed differently and each
    // spawned its own daemon for the same project.
    const upper = kanbanProjectServerEndpoint('D:\\Codebox\\Proj');
    const lower = kanbanProjectServerEndpoint('d:\\codebox\\proj');
    if (process.platform === 'win32') {
      expect(upper).toBe(lower);
    } else {
      // On POSIX these really are different paths; only assert determinism.
      expect(kanbanProjectServerEndpoint('/tmp/a')).toBe(kanbanProjectServerEndpoint('/tmp/a'));
    }
  });

  it('resolves relative and absolute forms of one root identically', () => {
    const abs = process.cwd();
    expect(kanbanProjectServerEndpoint(abs)).toBe(kanbanProjectServerEndpoint('.'));
  });
});
