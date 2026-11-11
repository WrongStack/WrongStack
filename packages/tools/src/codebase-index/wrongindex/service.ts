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
import { acceptWrongIndexQuery, type WrongIndexPublication } from './publication.js';

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

const clients = new Map<number, WrongIndexClient>();
const connecting = new Map<number, Promise<WrongIndexClient>>();
let nextReadLane = 0;
let connectionEpoch = 0;

async function connection(lane = 0): Promise<WrongIndexClient> {
  const client = clients.get(lane);
  if (client && !client.isClosed) return client;
  let pending = connecting.get(lane);
  if (!pending) {
    const epoch = connectionEpoch;
    pending = WrongIndexClient.connect({
      dataRoot: configuredDataRoot,
      clientName: 'wrongstack',
    })
      .then((c) => {
        if (epoch !== connectionEpoch) {
          c.close();
          throw new WrongIndexUnavailableError('connection superseded by host shutdown');
        }
        clients.set(lane, c);
        return c;
      })
      .finally(() => {
        if (epoch === connectionEpoch) connecting.delete(lane);
      });
    connecting.set(lane, pending);
  }
  return pending;
}

/** One call, reconnecting once if the cached connection went away. */
async function call<T>(
  method: string,
  projectId: string | null,
  params: unknown,
  options?: { timeoutMs?: number | undefined; signal?: AbortSignal | undefined },
): Promise<T> {
  // Two bounded read lanes cannot block heartbeats/admission on lane zero.
  const lane = method === 'index.query' ? 1 + (nextReadLane++ % 2) : 0;
  const c = await connection(lane);
  try {
    return await c.call<T>(method, projectId, params, undefined, options);
  } catch (err) {
    if (
      c.isClosed &&
      !(err instanceof WrongIndexRemoteError) &&
      [
        'index.query',
        'daemon.health',
        'project.get',
        'project.list',
        'job.get',
        'job.list',
      ].includes(method)
    ) {
      return (await connection(lane)).call<T>(method, projectId, params, undefined, options);
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
  // `session`: the service watches the checkout while a WrongStack host
  // holds a lease (`indexing.watchExternal`), and not otherwise. A project
  // WrongIndex already knows keeps the policy set there.
  const reg = await call<{ project: { projectId: string } }>('project.register', null, {
    checkoutRoot: projectRoot,
    indexDir,
    watchPolicy: 'session',
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
  if (!state.claimed) {
    projects.delete(key);
    throw new WrongIndexRemoteError({
      code: 'OWNER_CONFLICT',
      message: `the WrongIndex service does not own ${indexDir}; claim it in WrongIndex or set indexing.service to "wrongindex"`,
    });
  }
  // Every daemon query and mutation checks its actual OS run guard under
  // the registry fence. Re-probing the lock here would block the JS host
  // for 50 ms on every cached operation and still race a later release.
  return state;
}

// ─── Operations ─────────────────────────────────────────────────────────────

/** `JobRecord` of WrongIndex's contracts, as far as this adapter reads it. */
export interface WrongIndexJobRecord {
  jobId: string;
  state: 'queued' | 'running' | 'succeeded' | 'failed' | 'canceled';
  result?: Record<string, unknown> | null;
  error?: { code: string; message: string } | null;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms).unref?.());

async function waitForJob(
  projectId: string,
  jobId: string,
  opts: CallOpts,
): Promise<WrongIndexJobRecord> {
  const deadline = Date.now() + opts.timeoutMs;
  let delay = 50;
  for (;;) {
    if (opts.signal?.aborted) {
      await call('job.cancel', projectId, { jobId }).catch(() => undefined);
      throw opts.signal.reason instanceof Error
        ? opts.signal.reason
        : new Error('Indexing cancelled');
    }
    const job = await call<WrongIndexJobRecord>('job.get', projectId, { jobId });
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
  try {
    return await callWrongIndexOperation(op, args, opts);
  } catch (error) {
    if (error instanceof WrongIndexRemoteError && error.code === 'OWNER_CONFLICT') {
      const indexDir = resolveIndexDir(args.projectRoot, args.indexDir);
      projects.delete(process.platform === 'win32' ? indexDir.toLowerCase() : indexDir);
    }
    // A lost owner is visible to this caller; the next explicit operation
    // re-runs admission. Never silently replay a mutation here.
    throw error;
  }
}

async function callWrongIndexOperation<O extends OpName>(
  op: O,
  args: OpShapes[O]['args'],
  opts: CallOpts,
): Promise<OpShapes[O]['result']> {
  const { projectId } = await project(args.projectRoot, args.indexDir);
  if (op === 'index') {
    const a = args as OpShapes['index']['args'];
    const files = a.files ?? [];
    const kind = files.length > 0 && !a.force ? 'incremental' : 'full';
    const admission = await call<{ job: WrongIndexJobRecord }>('index.request', projectId, {
      kind,
      paths: kind === 'incremental' ? files : [],
    });
    const job = await waitForJob(projectId, admission.job.jobId, opts);
    if (job.state !== 'succeeded') {
      throw new WrongIndexRemoteError(
        // Codes are WrongIndex's ErrorCode values, also when the service
        // sent no error body.
        job.error ?? {
          code: job.state === 'canceled' ? 'CANCELED' : 'INTERNAL',
          message: `job ${job.jobId} ${job.state}`,
        },
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
  const reply = await call<WrongIndexPublication & { result: unknown }>(
    'index.query',
    projectId,
    {
      op,
      args: rest,
    },
    { timeoutMs: opts.timeoutMs, signal: opts.signal },
  );
  return acceptWrongIndexQuery(
    reply,
    args.projectRoot,
    resolveIndexDir(args.projectRoot, args.indexDir),
  ) as OpShapes[O]['result'];
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
  let polling = false;
  // Poll at the interval the daemon asked for, floored at 1s. Hardcoding 1s
  // made 10x the requested traffic and each poll costs a lane-0 round trip.
  const pollMs = Math.max(1_000, lease.heartbeatMs || 10_000);
  const timer = setInterval(() => {
    if (polling) return;
    polling = true;
    void call('session.heartbeat', null, { sessionId: lease.sessionId })
      .then(async () => {
        const status = await call<{
          generation: number;
          activity: string;
          freshness: string;
          lastError?: string | null;
        }>('project.get', projectId, {});
        if (!sessions.has(projectId)) return;
        // A rejected synthetic publication is not a lost lease. The heartbeat
        // only refreshes freshness metadata, so a daemon-side refusal
        // (superseded generation, pending publication, damaged index) must not
        // fall into the lease re-acquire path below: that would churn
        // session.acquire/session.release once per poll and evict this host's
        // own watch lease on the daemon.
        try {
          acceptWrongIndexQuery(
            {
              projectRoot,
              indexDir: resolveIndexDir(projectRoot, indexDir),
              projectId,
              daemonInstanceId: (await connection()).hello.daemonInstanceId,
              generation: status.generation,
              observedAt: Date.now(),
              indexing: status.activity === 'indexing',
              freshness: status.freshness,
              lastError: status.lastError,
              result: null,
            },
            projectRoot,
            resolveIndexDir(projectRoot, indexDir),
          );
        } catch (err) {
          if (err instanceof WrongIndexRemoteError) return;
          throw err;
        }
      })
      .catch(async () => {
        if (!sessions.has(projectId)) return;
        // Keep the polling timer through an outage. A failed one-shot
        // re-acquire must not silently abandon the host's watch lease.
        try {
          await project(projectRoot, indexDir);
          const renewed = await call<{ sessionId: string }>('session.acquire', projectId, {});
          const active = sessions.get(projectId);
          if (active) {
            lease.sessionId = renewed.sessionId;
            active.sessionId = renewed.sessionId;
          } else await call('session.release', null, { sessionId: renewed.sessionId });
        } catch {
          /* The next bounded poll retries while the host holds intent. */
        }
      })
      .finally(() => {
        polling = false;
      });
  }, pollMs);
  timer.unref?.();
  sessions.set(projectId, { sessionId: lease.sessionId, timer });
}

/** Register (and in `wrongindex` mode claim) the project, without a lease. */
export async function registerWrongIndexProject(
  projectRoot: string,
  indexDir?: string,
): Promise<void> {
  await project(projectRoot, indexDir);
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
  connectionEpoch++;
  connecting.clear();
  for (const session of sessions.values()) clearInterval(session.timer);
  sessions.clear();
  for (const client of clients.values()) client.close();
  clients.clear();
  projects.clear();
}

export { WrongIndexRemoteError, WrongIndexUnavailableError };
