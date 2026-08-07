/**
 * Shared in-process harness for the six project-server daemons.
 *
 * Every daemon (codebase-index, sage, kanban, chronicle, mailbox, governance)
 * follows the same shape: a deterministic per-project IPC endpoint, an
 * owner-only on-disk metadata file holding the per-process auth token, a
 * newline-delimited JSON protocol with a `hello` frame, an authenticated
 * `ping` health op and a gated `shutdown`, plus an idle timer armed at
 * listen(). The production daemons are module-level scripts (or, for
 * governance, a class) that bind the socket when their module body runs —
 * so a test worker can run them IN-PROCESS, which is the only way vitest's
 * v8 coverage measures the daemon source (a spawned child process's
 * execution is invisible to the worker's coverage collector).
 *
 * Two mechanisms make an in-process daemon safe:
 *
 * 1. `process.argv` is process-global, but the root config's forks pool runs
 *    one test FILE per worker, so mutating it around a synchronous dynamic
 *    import only affects this file. The daemon reads `process.argv.slice(2)`
 *    during module evaluation; we set the args, import, then restore.
 * 2. A query-suffixed import URL (`?case=<n>`) makes Vite treat each import
 *    as a distinct module instance, so every test gets a fresh daemon with
 *    its own socket/state. Query params must be stripped before any
 *    `fileURLToPath()` in the daemon (the codebase-index buildId does this —
 *    see project-server-endpoint.ts).
 *
 * Exit-behaviour caveat: the kanban daemon routes every stop path through
 * `stopAndExit()` → `process.exit(0)`, which would kill the worker. Its case
 * covers bind/metadata/hello/ping/auth only; the exit paths stay covered by
 * the existing child-process lifecycle tests in packages/kanban/tests.
 */

import * as fs from 'node:fs/promises';
import * as net from 'node:net';
import * as os from 'node:os';
import * as path from 'node:path';

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Poll for the daemon's owner-only metadata file and parse it. */
export async function waitForMetadataFile<T extends Record<string, unknown>>(
  metadataPath: string,
  timeoutMs = 15_000,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown;
  while (Date.now() < deadline) {
    try {
      return JSON.parse(await fs.readFile(metadataPath, 'utf8')) as T;
    } catch (error) {
      lastError = error;
      await sleep(25);
    }
  }
  throw new Error(
    `daemon metadata never appeared at ${metadataPath} within ${timeoutMs}ms (last: ${String(lastError)})`,
  );
}

/** Poll until the metadata file is gone (daemon removed it on stop). */
export async function waitForMetadataRemoval(
  metadataPath: string,
  timeoutMs = 15_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      await fs.stat(metadataPath);
      await sleep(25);
    } catch {
      return;
    }
  }
  throw new Error(`daemon metadata was never removed at ${metadataPath} within ${timeoutMs}ms`);
}

/** Poll until the endpoint refuses new connections (listener closed). */
export async function waitForEndpointClosed(endpoint: string, timeoutMs = 15_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      await connectRaw(endpoint, 500);
      await sleep(50);
    } catch {
      return;
    }
  }
  throw new Error(`daemon endpoint ${endpoint} still accepts connections after ${timeoutMs}ms`);
}

function connectRaw(endpoint: string, timeoutMs: number): Promise<net.Socket> {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(endpoint);
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new Error(`connect timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    socket.once('connect', () => {
      clearTimeout(timer);
      socket.removeListener('error', onError);
      resolve(socket);
    });
    const onError = (error: Error) => {
      clearTimeout(timer);
      reject(error);
    };
    socket.once('error', onError);
  });
}

/** Connect with retry — the daemon may still be initialising SQLite. */
export async function connectFrame(
  endpoint: string,
  timeoutMs = 10_000,
): Promise<{
  socket: net.Socket;
  nextFrame: (timeout?: number) => Promise<Record<string, unknown>>;
}> {
  const deadline = Date.now() + timeoutMs;
  let socket: net.Socket;
  for (;;) {
    try {
      socket = await connectRaw(endpoint, 1_000);
      break;
    } catch {
      if (Date.now() >= deadline) throw new Error(`endpoint ${endpoint} never became connectable`);
      await sleep(25);
    }
  }

  socket.setEncoding('utf8');
  let buffer = '';
  const queue: Array<Record<string, unknown>> = [];
  const waiters: Array<{
    resolve: (frame: Record<string, unknown>) => void;
    reject: (error: Error) => void;
    timer: NodeJS.Timeout;
  }> = [];

  socket.on('data', (chunk: string) => {
    buffer += chunk;
    for (;;) {
      const newline = buffer.indexOf('\n');
      if (newline < 0) return;
      const line = buffer.slice(0, newline);
      buffer = buffer.slice(newline + 1);
      if (!line.trim()) continue;
      let frame: Record<string, unknown>;
      try {
        frame = JSON.parse(line) as Record<string, unknown>;
      } catch {
        continue; // malformed frame from a daemon bug — ignore for harness purposes
      }
      const waiter = waiters.shift();
      if (waiter) {
        clearTimeout(waiter.timer);
        waiter.resolve(frame);
      } else {
        queue.push(frame);
      }
    }
  });
  socket.on('error', () => {
    for (const waiter of waiters.splice(0)) {
      clearTimeout(waiter.timer);
      waiter.reject(new Error('socket errored while waiting for a frame'));
    }
  });

  const nextFrame = (timeout = 10_000): Promise<Record<string, unknown>> => {
    const queued = queue.shift();
    if (queued) return Promise.resolve(queued);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        const index = waiters.indexOf(entry);
        if (index >= 0) waiters.splice(index, 1);
        reject(new Error(`timed out waiting for a daemon frame (${timeout}ms)`));
      }, timeout);
      const entry = { resolve, reject, timer };
      waiters.push(entry);
    });
  };

  return { socket, nextFrame };
}

/** Fresh per-test temp root. `keep` keeps it after the test (kanban liveness). */
export async function makeTempRoot(
  caseName: string,
  keep = false,
): Promise<{ root: string; release: () => Promise<void> }> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), `wstack-harness-${caseName}-`));
  return {
    root,
    release: keep
      ? async () => undefined
      : async () => {
          await fs
            .rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 25 })
            .catch(() => {});
        },
  };
}

/**
 * Run a module-level daemon in-process: set argv, import with a fresh query
 * param so Vite gives us a new module instance, restore argv. Returns the
 * module namespace (kanban's case calls its exported `main()`).
 *
 * `idleEnv` (e.g. `WRONGSTACK_SAGE_SERVER_IDLE_MS`) is set to a short value
 * before import and restored afterwards, so the daemon arms a short idle
 * timer without leaking env into the rest of the worker.
 */
export async function importDaemonInstance(
  moduleUrl: string,
  args: string[],
  nonce: number,
  idleEnv: string | null = null,
): Promise<Record<string, unknown>> {
  const savedArgv = process.argv;
  const savedIdle = idleEnv ? process.env[idleEnv] : undefined;
  process.argv = [savedArgv[0] ?? process.execPath, 'harness', ...args];
  if (idleEnv) process.env[idleEnv] = '400';
  try {
    const url = new URL(moduleUrl, import.meta.url);
    url.searchParams.set('case', String(nonce));
    return (await import(url.href)) as Record<string, unknown>;
  } finally {
    process.argv = savedArgv;
    if (idleEnv) {
      if (savedIdle === undefined) delete process.env[idleEnv];
      else process.env[idleEnv] = savedIdle;
    }
  }
}

export function isWindows(): boolean {
  return process.platform === 'win32';
}

export function posixMode(metadataPath: string): Promise<number | null> {
  return fs
    .stat(metadataPath)
    .then((stat) => stat.mode)
    .catch(() => null);
}
