/**
 * Index service selection: the local engine (per-project daemon, worker or
 * inline) or the WrongIndex service.
 *
 * Modes (`indexing.service`, env `WRONGSTACK_INDEX_SERVICE`):
 *   - `local` (default): the local engine. An index WrongIndex owns is
 *     refused, never written.
 *   - `auto`: WrongIndex for an index it owns; the local engine otherwise.
 *   - `wrongindex`: always WrongIndex. The project is registered and claimed
 *     (after this process's local project server for that index is shut
 *     down); there is no local fallback.
 *
 * A failure to reach the service never authorizes a local write to an index
 * the service owns (compatibility §6.2): the call fails instead.
 */

import { IndexTimeoutError } from '../circuit-breaker.js';
import type { CallOpts } from '../index-inline.js';
import type { IndexResult } from '../schema.js';
import type { OpName, OpShapes } from '../worker-protocol.js';
import { resolveIndexDir } from '../writer-helpers.js';
import { WrongIndexClient, WrongIndexRemoteError, WrongIndexUnavailableError } from './client.js';
import { isOwnedByWrongIndex } from './owner-lock.js';

export type IndexServiceMode = 'local' | 'auto' | 'wrongindex';

const MODES: readonly IndexServiceMode[] = ['local', 'auto', 'wrongindex'];

let configuredMode: IndexServiceMode | null = null;
let configuredDataRoot: string | undefined;

/** Hosts pass `config.indexing.service` here at startup. */
export function setIndexServiceMode(
  mode: IndexServiceMode | undefined,
  opts: { dataRoot?: string | undefined } = {},
): void {
  configuredMode = mode && MODES.includes(mode) ? mode : null;
  configuredDataRoot = opts.dataRoot;
}

export function resolveIndexServiceMode(): IndexServiceMode {
  const env = process.env['WRONGSTACK_INDEX_SERVICE']?.trim().toLowerCase();
  if (env && (MODES as readonly string[]).includes(env)) return env as IndexServiceMode;
  return configuredMode ?? 'local';
}

export type IndexRoute = 'local' | 'wrongindex';

/** Where an operation on this index goes. */
export function resolveIndexRoute(projectRoot: string, indexDir?: string): IndexRoute {
  const mode = resolveIndexServiceMode();
  if (mode === 'wrongindex') return 'wrongindex';
  if (mode === 'auto' && isOwnedByWrongIndex(resolveIndexDir(projectRoot, indexDir))) {
    return 'wrongindex';
  }
  return 'local';
}

// ─── Connection and project state ───────────────────────────────────────────

let client: WrongIndexClient | null = null;
let connecting: Promise<WrongIndexClient> | null = null;

async function connection(): Promise<WrongIndexClient> {
  if (client && !client.isClosed) return client;
  if (!connecting) {
    connecting = WrongIndexClient.connect({
      dataRoot: configuredDataRoot,
      clientName: 'wrongstack',
    })
      .then((c) => {
        client = c;
        return c;
      })
      .finally(() => {
        connecting = null;
      });
  }
  return connecting;
}

/** One call, reconnecting once if the cached connection went away. */
async function call<T>(method: string, projectId: string | null, params: unknown): Promise<T> {
  const c = await connection();
  try {
    return await c.call<T>(method, projectId, params);
  } catch (err) {
    if (c.isClosed && !(err instanceof WrongIndexRemoteError)) {
      return (await connection()).call<T>(method, projectId, params);
    }
    throw err;
  }
}

interface ProjectState {
  projectId: string;
  claimed: boolean;
}

const projects = new Map<string, Promise<ProjectState>>();

/** Hook run before this process claims an index (shut down local owners). */
let beforeClaim: ((projectRoot: string, indexDir: string) => Promise<void>) | null = null;

export function setBeforeWrongIndexClaim(
  hook: ((projectRoot: string, indexDir: string) => Promise<void>) | null,
): void {
  beforeClaim = hook;
}

async function registerAndClaim(projectRoot: string, indexDir: string): Promise<ProjectState> {
  const reg = await call<{ project: { projectId: string } }>('project.register', null, {
    checkoutRoot: projectRoot,
    indexDir,
  });
  const projectId = reg.project.projectId;
  if (isOwnedByWrongIndex(indexDir)) return { projectId, claimed: true };
  // Explicit `wrongindex` mode takes the index over: local writers in this
  // process stop first, then the service claims it (admission inspects the
  // index read-only and refuses one it cannot write safely).
  if (resolveIndexServiceMode() !== 'wrongindex') return { projectId, claimed: false };
  await beforeClaim?.(projectRoot, indexDir);
  await call('ownership.acquire', projectId, {});
  return { projectId, claimed: true };
}

async function project(projectRoot: string, indexDirOverride?: string): Promise<ProjectState> {
  const indexDir = resolveIndexDir(projectRoot, indexDirOverride);
  const key = process.platform === 'win32' ? indexDir.toLowerCase() : indexDir;
  let p = projects.get(key);
  if (!p) {
    p = registerAndClaim(projectRoot, indexDir);
    projects.set(key, p);
    p.catch(() => projects.delete(key));
  }
  const state = await p;
  if (!state.claimed || !isOwnedByWrongIndex(indexDir)) {
    // Released or never claimed since: re-run admission next time.
    projects.delete(key);
    if (!state.claimed) {
      throw new WrongIndexRemoteError({
        code: 'OWNER_CONFLICT',
        message: `the WrongIndex service does not own ${indexDir}; claim it in WrongIndex or set indexing.service to "wrongindex"`,
      });
    }
    return registerAndClaim(projectRoot, indexDir).then((s) => {
      projects.set(key, Promise.resolve(s));
      return s;
    });
  }
  return state;
}

// ─── Operations ─────────────────────────────────────────────────────────────

interface JobRecord {
  jobId: string;
  state: 'queued' | 'running' | 'succeeded' | 'failed' | 'canceled';
  result?: Record<string, unknown> | null;
  error?: { code: string; message: string } | null;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms).unref?.());

async function waitForJob(projectId: string, jobId: string, opts: CallOpts): Promise<JobRecord> {
  const deadline = Date.now() + opts.timeoutMs;
  let delay = 50;
  for (;;) {
    if (opts.signal?.aborted) {
      await call('job.cancel', projectId, { jobId }).catch(() => undefined);
      throw opts.signal.reason instanceof Error
        ? opts.signal.reason
        : new Error('Indexing cancelled');
    }
    const job = await call<JobRecord>('job.get', projectId, { jobId });
    if (job.state === 'succeeded' || job.state === 'failed' || job.state === 'canceled') {
      return job;
    }
    if (Date.now() >= deadline) {
      throw new IndexTimeoutError(`WrongIndex job ${jobId} exceeded ${opts.timeoutMs}ms`);
    }
    await sleep(delay);
    delay = Math.min(delay * 2, 500);
  }
}

function num(v: unknown): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : 0;
}

/** A finished job's result in `IndexResult` form (native or compatibility worker). */
export function toIndexResult(result: Record<string, unknown> | null | undefined): IndexResult {
  const r = result ?? {};
  const native = (r['native'] ?? {}) as Record<string, unknown>;
  const src = r['backend'] === 'native' ? native : r;
  const changed = src['changedFiles'] ?? src['changed_files'];
  const out: IndexResult = {
    filesIndexed: num(src['filesIndexed']),
    symbolsIndexed: num(src['symbolsIndexed']),
    langStats: {} as IndexResult['langStats'],
    durationMs: num(src['durationMs']),
    errors: Array.isArray(src['errors']) ? (src['errors'] as string[]) : [],
  };
  if (typeof changed === 'number') {
    (out as { changedFiles?: number }).changedFiles = changed;
  } else if (src['outcome'] === 'unchanged') {
    (out as { changedFiles?: number }).changedFiles = 0;
  }
  return out;
}

/** Run one operation through the WrongIndex service. */
export async function callWrongIndex<O extends OpName>(
  op: O,
  args: OpShapes[O]['args'],
  opts: CallOpts,
): Promise<OpShapes[O]['result']> {
  const { projectId } = await project(args.projectRoot, args.indexDir);
  if (op === 'index') {
    const a = args as OpShapes['index']['args'];
    const files = a.files ?? [];
    const kind = files.length > 0 && !a.force ? 'incremental' : 'full';
    const admission = await call<{ job: JobRecord }>('index.request', projectId, {
      kind,
      paths: kind === 'incremental' ? files : [],
    });
    const job = await waitForJob(projectId, admission.job.jobId, opts);
    if (job.state !== 'succeeded') {
      throw new WrongIndexRemoteError(
        job.error ?? { code: 'JOB_FAILED', message: `job ${job.jobId} ${job.state}` },
      );
    }
    return toIndexResult(job.result) as OpShapes[O]['result'];
  }
  // The daemon decides which index is read; location fields are dropped.
  const {
    projectRoot: _root,
    indexDir: _dir,
    ...rest
  } = args as unknown as Record<string, unknown>;
  const reply = await call<{ result: unknown }>('index.query', projectId, {
    op,
    args: rest,
  });
  return reply.result as OpShapes[O]['result'];
}

// ─── Sessions (watch leases) ────────────────────────────────────────────────

const sessions = new Map<string, { sessionId: string; timer: ReturnType<typeof setInterval> }>();

/**
 * Hold a watch session for this project while the host lives: the service
 * watches projects whose policy is `session` only while a lease is held.
 */
export async function acquireWrongIndexSession(
  projectRoot: string,
  indexDir?: string,
): Promise<void> {
  const { projectId } = await project(projectRoot, indexDir);
  if (sessions.has(projectId)) return;
  const lease = await call<{ sessionId: string; heartbeatMs: number }>(
    'session.acquire',
    projectId,
    {},
  );
  const timer = setInterval(
    () => {
      void call('session.heartbeat', null, { sessionId: lease.sessionId }).catch(() => {
        // Expired or the daemon restarted: re-acquire on the next tick.
        clearInterval(timer);
        sessions.delete(projectId);
        void acquireWrongIndexSession(projectRoot, indexDir).catch(() => undefined);
      });
    },
    Math.max(1_000, lease.heartbeatMs || 10_000),
  );
  timer.unref?.();
  sessions.set(projectId, { sessionId: lease.sessionId, timer });
}

/** Release this process's leases only; the global daemon keeps running. */
export async function releaseWrongIndexSessions(): Promise<void> {
  const all = [...sessions.values()];
  sessions.clear();
  for (const s of all) {
    clearInterval(s.timer);
    await call('session.release', null, { sessionId: s.sessionId }).catch(() => undefined);
  }
}

export async function wrongIndexHealth(): Promise<Record<string, unknown>> {
  return call<Record<string, unknown>>('daemon.health', null, {});
}

/** Close the connection (tests, host shutdown). */
export function resetWrongIndexConnection(): void {
  client?.close();
  client = null;
  projects.clear();
}

export { WrongIndexRemoteError, WrongIndexUnavailableError };
