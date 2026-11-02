import * as fs from 'node:fs';

import { fileURLToPath } from 'node:url';

import { Worker } from 'node:worker_threads';

import { IndexTimeoutError, LockError } from './circuit-breaker.js';

import type { CallOpts } from './index-inline.js';

import { callInline } from './index-inline.js';

import {
  callProjectIndexServer,
  type ProjectIndexDaemonAvailability,
  resolveProjectIndexDaemonAvailability,
} from './project-server-client.js';

import type { HostToWorker, OpName, OpShapes, WorkerToHost } from './worker-protocol.js';
import { resolveIndexDir } from './writer-helpers.js';
import { IndexOwnedExternallyError, isOwnedByWrongIndex } from './wrongindex/owner-lock.js';
import {
  callWrongIndex,
  resolveIndexRoute,
  WrongIndexUnavailableError,
} from './wrongindex/service.js';

// ─── Worker management ───────────────────────────────────────────────────────

export interface PendingRpc {
  resolve: (value: unknown) => void;
  reject: (err: unknown) => void;
  onProgress?: ((current: number, total: number) => void) | undefined;
}

export let worker: Worker | null = null;

export let workerUnavailable = false;

export let nextRpcId = 1;

export const pending = new Map<number, PendingRpc>();

/**
 * Locate the built worker file. The host is bundled into several entry points
 * (`dist/index.js`, `dist/builtin.js`, `dist/codebase-index/index.js`), so the
 * worker is probed at both relative locations. From source (vitest) neither
 * `.js` exists → inline mode, which keeps tests hermetic and mockable.
 */
export function resolveWorkerUrl(): URL | null {
  if (process.env['WRONGSTACK_INDEX_INLINE']) return null;
  for (const rel of ['./worker.js', './codebase-index/worker.js']) {
    try {
      const url = new URL(rel, import.meta.url);
      if (url.protocol === 'file:' && fs.existsSync(fileURLToPath(url))) return url;
    } catch {
      /* try the next candidate */
    }
  }
  return null;
}

export function failAllPending(err: unknown): void {
  const entries = [...pending.values()];
  pending.clear();
  for (const p of entries) p.reject(err);
}

export function ensureWorker(): Worker | null {
  if (worker) return worker;
  if (workerUnavailable) return null;
  const url = resolveWorkerUrl();
  if (!url) {
    workerUnavailable = true;
    return null;
  }
  try {
    const w = new Worker(url, { name: 'wstack-codebase-index' });
    // The worker must never keep the process alive on its own.
    w.unref();
    w.on('message', (msg: WorkerToHost) => {
      if (msg.type === 'progress') {
        pending.get(msg.id)?.onProgress?.(msg.current, msg.total);
        return;
      }
      const entry = pending.get(msg.id);
      if (!entry) return; // already timed out / cancelled
      pending.delete(msg.id);
      if (msg.ok) entry.resolve(msg.result);
      else {
        const error =
          msg.errorName === 'LockError' ? new LockError(msg.error) : new Error(msg.error);
        if (msg.errorName && msg.errorName !== 'Error') {
          (error as { name: string }).name = msg.errorName;
        }
        entry.reject(error);
      }
    });
    w.on('error', (err) => {
      // Ignore late events from a worker already terminated/replaced by the
      // watchdog; they must not reject RPCs owned by its successor.
      if (worker !== w) return;
      worker = null;
      failAllPending(err);
    });
    w.on('exit', () => {
      if (worker !== w) return;
      worker = null;
      failAllPending(new Error('codebase-index worker exited'));
    });
    worker = w;
    return w;
  } catch {
    // Spawn failed (no worker_threads, sandbox, …) — fall back to inline for
    // the rest of the process lifetime.
    workerUnavailable = true;
    return null;
  }
}

/** Hard-kill a wedged worker. It respawns lazily on the next operation. */
export function terminateWorker(reason: unknown): void {
  const w = worker;
  worker = null;
  failAllPending(reason);
  if (w) void w.terminate().catch(() => {});
}

/** Endpoints already reported as unbindable — warn once per endpoint, not per call. */
export const warnedInvalidEndpoints = new Set<string>();

export function warnEndpointInvalidOnce(
  availability: Extract<ProjectIndexDaemonAvailability, { kind: 'endpoint-invalid' }>,
): void {
  if (warnedInvalidEndpoints.has(availability.endpoint)) return;
  warnedInvalidEndpoints.add(availability.endpoint);
  process.stderr.write(
    `codebase-index: socket path is ${availability.byteLength} bytes, over this platform's ` +
      `${availability.maxBytes}-byte sun_path limit (${availability.endpoint}). ` +
      `Subsequent calls will reject until TMPDIR is shortened to restore the shared daemon.\n`,
  );
}

/**
 * Run one operation, in the worker when available, inline otherwise. Both
 * paths share the watchdog: the returned promise ALWAYS settles within
 * `timeoutMs`, and a timeout in worker mode terminates the (possibly wedged
 * in synchronous code) worker — something an in-process watchdog can never do.
 */
export function dispatchIndexOp<O extends OpName>(
  op: O,
  args: OpShapes[O]['args'],
  opts: CallOpts,
  indexing: boolean,
): Promise<OpShapes[O]['result']> {
  // Production builds route every operation through one detached server per
  // project. The worker/inline path below still exists for source-tree tests
  // and exotic runtimes, but it has to be asked for: reaching it because the
  // build could not be located would give this process a private FTS5 database
  // and no indication that it had stopped sharing the project's index.
  // The WrongIndex service, when selected or when it owns this index. Its
  // failures are final: an index it owns is never written locally instead.
  if (resolveIndexRoute(args.projectRoot, args.indexDir) === 'wrongindex') {
    // The service is down (or not installed) and does not hold the index:
    // WrongStack's own engine keeps working. An index the service holds is
    // never written locally, reachable or not.
    return callWrongIndex(op, args, opts).catch((err: unknown) => {
      const dir = resolveIndexDir(args.projectRoot, args.indexDir);
      if (!(err instanceof WrongIndexUnavailableError) || isOwnedByWrongIndex(dir)) throw err;
      warnServiceUnavailableOnce(err);
      return dispatchLocal(op, args, opts, indexing);
    });
  }
  return dispatchLocal(op, args, opts, indexing);
}

/** Services that were unreachable: warn once, not per call. */
let warnedServiceUnavailable = false;

function warnServiceUnavailableOnce(err: Error): void {
  if (warnedServiceUnavailable) return;
  warnedServiceUnavailable = true;
  process.stderr.write(
    `codebase-index: ${err.message}; using WrongStack's own index engine (the service does not hold this index).\n`,
  );
}

function dispatchLocal<O extends OpName>(
  op: O,
  args: OpShapes[O]['args'],
  opts: CallOpts,
  indexing: boolean,
): Promise<OpShapes[O]['result']> {
  if (isOwnedByWrongIndex(resolveIndexDir(args.projectRoot, args.indexDir))) {
    return Promise.reject(
      new IndexOwnedExternallyError(resolveIndexDir(args.projectRoot, args.indexDir)),
    );
  }
  const availability = resolveProjectIndexDaemonAvailability(args.projectRoot, args.indexDir);
  if (availability.kind === 'available') {
    return callProjectIndexServer(op, args, opts);
  }
  if (availability.kind === 'missing-build') {
    return Promise.reject(
      new Error(
        'Built codebase-index project server is unavailable. Build @wrongstack/tools, ' +
          'or set WRONGSTACK_INDEX_INLINE=1 to explicitly accept a process-local index.',
      ),
    );
  }
  if (availability.kind === 'endpoint-invalid') {
    // The daemon cannot bind this endpoint (socket path over the platform's
    // sun_path limit — macOS's long per-user TMPDIR is the known trigger).
    // Spawning would die silently (`stdio: 'ignore'`), so explicitly reject
    // here instead of falling through to the in-process index: silently
    // degrading would strip every connected client of the shared per-project
    // daemon and they would all open their own private FTS5 databases, with
    // no indication that they had stopped sharing one.
    warnEndpointInvalidOnce(availability);
    return Promise.reject(
      new Error(
        `codebase-index: socket path is ${availability.byteLength} bytes, over this platform's ` +
          `${availability.maxBytes}-byte sun_path limit (${availability.endpoint}). ` +
          `Set a shorter TMPDIR to relocate the shared daemon, ` +
          `or set WRONGSTACK_INDEX_INLINE=1 to explicitly opt into a process-local index.`,
      ),
    );
  }

  const w = ensureWorker();
  if (!w) return callInline(op, args, opts, indexing);

  if (opts.signal?.aborted) {
    return Promise.reject(
      opts.signal.reason instanceof Error ? opts.signal.reason : new Error('Indexing cancelled'),
    );
  }

  return new Promise<OpShapes[O]['result']>((resolve, reject) => {
    const id = nextRpcId++;

    const timer = setTimeout(() => {
      pending.delete(id);
      const err = new IndexTimeoutError(
        `Index ${op} exceeded its ${opts.timeoutMs}ms watchdog timeout`,
      );
      // A wedged worker (synchronous sqlite wait, pathological parse) cannot
      // be cooperatively cancelled — kill it; it respawns on the next call.
      terminateWorker(err);
      reject(err);
    }, opts.timeoutMs);
    timer.unref?.();

    const onAbort = () => {
      // Cooperative cancel; the worker aborts the op's signal and responds
      // with an error. The watchdog stays armed as the backstop.
      w.postMessage({ type: 'cancel', id } satisfies HostToWorker);
    };
    opts.signal?.addEventListener('abort', onAbort, { once: true });

    const cleanup = () => {
      clearTimeout(timer);
      opts.signal?.removeEventListener('abort', onAbort);
    };
    pending.set(id, {
      resolve: (v) => {
        cleanup();
        resolve(v as OpShapes[O]['result']);
      },
      reject: (e) => {
        cleanup();
        reject(e);
      },
      onProgress: opts.onProgress,
    });

    w.postMessage({ type: 'request', id, op, args } satisfies HostToWorker);
  });
}

export async function shutdownIndexWorker(): Promise<void> {
  const w = worker;
  worker = null;
  failAllPending(new Error('codebase-index host shut down'));
  workerUnavailable = false; // a future call may spawn a fresh worker
  if (w) {
    try {
      // On Windows SQLite files remain locked until the worker has actually
      // exited. Exposing the termination promise lets deterministic teardown
      // wait before removing an index directory.
      await w.terminate();
    } catch {
      // Shutdown is best-effort, matching watchdog termination semantics.
    }
  }
}

export function resetIndexWorkerState(): void {
  warnedInvalidEndpoints.clear();
  // Don't terminate the worker — it's expensive to respawn and tests that
  // need it will call ensureWorker() lazily. Just clear the RPC state.
  for (const [, p] of pending) p.reject(new Error('test reset'));
  pending.clear();
  nextRpcId = 1;
}
