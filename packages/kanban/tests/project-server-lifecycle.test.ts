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
import { afterEach, describe, expect, it } from 'vitest';
import {
  MAX_FRAME_CHARS,
  onData,
  kanbanProjectServerEndpoint,
} from '../src/server/project-server.js';

// Emitted at the dist ROOT, not under dist/server/: `client.ts` is bundled
// into dist/index.js, so its `new URL('./project-server.js', import.meta.url)`
// resolves next to the index bundle. The build entry key must match that.
const distServer = fileURLToPath(new URL('../dist/project-server.js', import.meta.url));

async function waitForExit(child: ChildProcess, timeoutMs = 30_000): Promise<number | null> {
  // 30s (was 15s): under full-suite CI load the daemon's 3s idle-exit can
  // intermittently exceed the old budget even when nothing is wrong (the
  // failure moved between tests across runs). A genuinely stuck daemon
  // still fails at 30s — the guard is preserved.
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
/** Captured stdout per child, so tests can wait for the "listening on…" line
 *  before connecting. SQLite init can block the event loop under CI load;
 *  the socket is already listening, but acceptClient is gated on the `ready`
 *  promise that only resolves after SQLite opens. Connecting before that line
 *  burns the test's exit-timeout budget on the SQLite stall. */
const daemonOut = new WeakMap<ChildProcess, { text: string }>();

function startDaemon(projectRoot: string, idleMs = 200): ChildProcess {
  const child = spawn(process.execPath, [distServer, '--project-root', projectRoot], {
    env: { ...process.env, WRONGSTACK_KANBAN_SERVER_IDLE_MS: String(idleMs) },
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
  const errSink = { text: '' };
  daemonErr.set(child, errSink);
  child.stderr?.on('data', (chunk: Buffer) => {
    errSink.text += chunk.toString();
  });
  const outSink = { text: '' };
  daemonOut.set(child, outSink);
  child.stdout?.on('data', (chunk: Buffer) => {
    outSink.text += chunk.toString();
  });
  return child;
}

/**
 * Wait for the daemon to emit its "listening on…" line on stdout. This
 * guarantees SQLite init has finished and `scheduleIdleStop()` has been
 * called, so the idle timer's budget is fully available for the test rather
 * than silently consumed by a slow `SqliteKanbanStorage.open()`.
 */
async function waitForDaemonReady(child: ChildProcess, timeoutMs = 10_000): Promise<void> {
  const sink = daemonOut.get(child);
  if (!sink) throw new Error('daemon stdout sink missing');
  const deadline = Date.now() + timeoutMs;
  while (!sink.text.includes('kanban project server listening on')) {
    if (Date.now() >= deadline) {
      throw new Error(`Daemon never emitted listening line within ${timeoutMs}ms${why(child)}`);
    }
    await new Promise((r) => setTimeout(r, 50));
  }
}

function why(child: ChildProcess): string {
  const captured = daemonErr.get(child)?.text.trim();
  return captured ? ` — daemon stderr: ${captured}` : ' — daemon wrote nothing to stderr';
}

describe('kanban project server lifecycle', { retry: 1 }, () => {
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
      await fs.rm(projectRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 25 });
    }
  });

  it('exits after the last client disconnects', async () => {
    const projectRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'wstack-kanban-drop-'));
    const endpoint = kanbanProjectServerEndpoint(projectRoot);
    const child = startDaemon(projectRoot, 3_000);
    try {
      await waitForDaemonReady(child);
      const socket = await connectWithin(endpoint, 8_000, () => why(child));
      socket.destroy();
      const code = await waitForExit(child);
      expect(code, why(child)).toBe(0);
    } finally {
      if (child.exitCode === null && child.signalCode === null) child.kill();
      await fs.rm(projectRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 25 });
    }
  });

  it('stops serving and releases the endpoint on exit', async () => {
    const projectRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'wstack-kanban-endpoint-'));
    const endpoint = kanbanProjectServerEndpoint(projectRoot);
    const child = startDaemon(projectRoot, 3_000);
    try {
      await waitForDaemonReady(child);
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
      // On Windows the SQLite WAL/SHM files in the project root stay mapped
      // for a brief moment after the daemon's DatabaseSync.close() returns,
      // so the recursive rm can hit EBUSY. maxRetries lets node retry the
      // unlink with the standard 25ms backoff until the OS releases the map.
      await fs.rm(projectRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 25 });
    }
  });
});

describe('kanban project server frame buffer guard', () => {
  let server: net.Server | undefined;
  let tempRoot: string | undefined;
  let orphanSock: string | undefined;
  const sockets: net.Socket[] = [];

  afterEach(async () => {
    for (const sock of sockets.splice(0)) sock.destroy();
    server?.close();
    server = undefined;
    if (orphanSock) {
      await fs.rm(orphanSock, { force: true }).catch(() => {});
      orphanSock = undefined;
    }
    if (tempRoot) {
      await fs.rm(tempRoot, { recursive: true, force: true }).catch(() => {});
      tempRoot = undefined;
    }
  });

  it('destroys the connection when a chunk without newline exceeds MAX_FRAME_CHARS', async () => {
    tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'wstack-kanban-bufguard-'));
    const endpoint = kanbanProjectServerEndpoint(tempRoot);
    // Ensure the socket directory exists (CI runners may restrict /tmp subdir creation).
    await fs.mkdir(path.dirname(endpoint), { recursive: true }).catch(() => {});
    // The endpoint resolves to a system-level path outside tempRoot
    // (e.g. /tmp/wrongstack-kanban-v4-<hash>.sock). Track it so afterEach
    // can clean it up — the temp directory removal alone won't delete it.
    orphanSock = endpoint;

    // Start a local server that wires up the real onData guard — same
    // logic that the daemon uses in acceptClient().
    server = net.createServer((serverSocket) => {
      serverSocket.setEncoding('utf8');
      const state = {
        socket: serverSocket,
        buffer: '',
        inflightRequests: 0,
        lastSeenAt: Date.now(),
      };
      serverSocket.on('data', (chunk: string) => onData(state, chunk));
      serverSocket.on('error', () => {
        /* consumed by design — same as acceptClient */
      });
    });
    await new Promise<void>((resolve, reject) => {
      server!.once('error', reject);
      server!.listen(endpoint, resolve);
    });

    // Connect a raw client socket
    const client = await new Promise<net.Socket>((resolve, reject) => {
      const s = net.createConnection(endpoint);
      s.once('connect', () => resolve(s));
      s.once('error', reject);
    });
    sockets.push(client);

    // Send a chunk larger than MAX_FRAME_CHARS with no trailing \n.
    // The guard in onData() checks buffer.length BEFORE the frame loop,
    // so a newline-less chunk cannot bypass the cap — this must destroy
    // the socket unconditionally.
    const oversized = Buffer.alloc(MAX_FRAME_CHARS + 1, 'x');

    await expect(
      new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => {
          reject(
            new Error(
              'Socket was not destroyed within 10 s — the MAX_FRAME_CHARS guard ' +
                'is missing or positioned inside the frame loop, so a newline-less ' +
                'chunk bypasses it',
            ),
          );
        }, 10_000);
        client.on('close', () => {
          clearTimeout(timer);
          resolve();
        });
        client.write(oversized);
      }),
    ).resolves.toBeUndefined();
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
