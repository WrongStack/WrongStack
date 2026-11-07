import { spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as net from 'node:net';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  daemonSpawnArgs,
  isStandaloneBinary,
  retryWhileUnauthorized,
  standaloneDaemonUrl,
} from '@wrongstack/persistence';
import type { ChronicleJournalStats } from './journal.js';
import {
  chronicleProjectServerEndpoint,
  chronicleProjectServerMetadataPath,
} from './project-server-endpoint.js';
import {
  CHRONICLE_MAX_APPEND_BATCH,
  CHRONICLE_PROJECT_SERVER_MAX_FRAME_CHARS,
  CHRONICLE_PROJECT_SERVER_PROTOCOL_VERSION,
  type ChronicleProjectServerHealth,
  type ChronicleProjectServerInfo,
  type ChronicleProjectServerMessage,
  type ChronicleServerOperationName,
  type ChronicleServerOperations,
  encodeChronicleProjectServerMessage,
} from './project-server-protocol.js';
import type { ChronicleEventSink } from './sink.js';
import type { ChronicleEvent, ChronicleEventInput } from './types.js';

const CONNECT_ATTEMPT_TIMEOUT_MS = 750;
const SERVER_START_TIMEOUT_MS = 10_000;
/**
 * Minimum spacing between detached-server spawn attempts inside one
 * `connectWithElection` window. The first spawn still fires immediately;
 * re-arming is cadence-bounded so a dead first daemon is recovered without
 * flooding the machine with losing candidates (the endpoint bind IS the
 * election, so an extra spawn that cannot win exits without side effects).
 * Mirrors the mailbox/SAGE clients' fix for the same single-shot-spawn
 * defect.
 */
const SPAWN_RETRY_CADENCE_MS = 750;
const DEFAULT_CALL_TIMEOUT_MS = 30_000;
const APPEND_CALL_TIMEOUT_MS = 60_000;
const DEFAULT_BATCH_WINDOW_MS = 5;
const DEFAULT_MAX_PENDING = 100_000;

interface PendingRequest {
  resolve(value: unknown): void;
  reject(error: unknown): void;
  timer: ReturnType<typeof setTimeout>;
}

export interface ChronicleProjectServerClientOptions {
  projectRoot: string;
  globalRoot: string;
  projectId: string;
  projectDir: string;
  workspaceId: string;
  retentionDays?: number | undefined;
  /**
   * Storage ceilings forwarded to the daemon at spawn.
   *
   * Only the client that wins the spawn race sets them: a daemon already
   * running keeps whatever limits it started with, exactly as it already does
   * for `retentionDays`.
   */
  maxEvents?: number | undefined;
  maxBytes?: number | undefined;
  metricsRowRetentionDays?: number | undefined;
}

export interface ChronicleProjectServerCallOptions {
  timeoutMs?: number | undefined;
}

/**
 * Locate the detached Chronicle entry from both regular ESM output and the
 * bundled core entrypoints. In an esbuild bundle `import.meta.url` belongs to
 * the bundle (for example `dist/plugin/index.js`), not this source module, so
 * a single relative lookup silently selects the inline fallback.
 */
/**
 * Why the Chronicle daemon is or is not usable.
 *
 * `resolveChronicleProjectServerUrl` collapses two very different situations
 * into one `null`: the operator asked for in-process mode, or the built server
 * simply could not be found. Callers that fall back on `null` therefore treat a
 * broken build exactly like a deliberate choice — and since the lookup is
 * relative to `import.meta.url`, a change in bundle layout alone is enough to
 * silently give every process its own private journal.
 */
export type ChronicleDaemonAvailability =
  | { readonly kind: 'available'; readonly url: URL }
  /** `WRONGSTACK_CHRONICLE_INLINE` / `WRONGSTACK_CHRONICLE_SERVER=0` was set. */
  | { readonly kind: 'inline-requested' }
  /** No server entry point exists in any known output layout. */
  | { readonly kind: 'missing-build' };

/**
 * Transient-tolerant entrypoint probe. ENOENT means the layout genuinely
 * does not exist; ANY other stat failure (EMFILE/EPERM/EBUSY spikes under
 * full-suite parallel load) is "unknown", and `fs.existsSync` folds that
 * into false — one transient miss then threw "Built Chronicle project
 * server is unavailable" straight out of the connect loop and failed the
 * caller (mailbox/SAGE sibling flake, observed 2026-09-15). Assume-present
 * is the recoverable direction: a dead spawn is guarded and cadence-
 * retryable, while a false negative was fatal to the connect window.
 */
function probeFileExists(filePath: string): boolean {
  try {
    // Primary probe: the seam existing callers and tests mock, and the fast
    // path for the common available case.
    if (fs.existsSync(filePath)) return true;
  } catch {
    // existsSync itself failed — fall through to the stat verification.
  }
  // existsSync folds transient stat errors (EMFILE/EPERM/EBUSY spikes under
  // full-suite parallel load) into false. Verify with statSync before
  // declaring the build missing: ENOENT = genuinely absent; any other error
  // (or a contradictory success) = assume present — the recoverable
  // direction, since a dead spawn is guarded and cadence-retryable while a
  // false negative was fatal to the connect window (mailbox/SAGE sibling
  // flakes, observed 2026-09-15).
  try {
    fs.statSync(filePath);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException)?.code !== 'ENOENT';
  }
}

export function resolveChronicleDaemonAvailability(
  moduleUrl = import.meta.url,
  exists: (filePath: string) => boolean = probeFileExists,
): ChronicleDaemonAvailability {
  if (
    process.env['WRONGSTACK_CHRONICLE_INLINE'] ||
    process.env['WRONGSTACK_CHRONICLE_SERVER'] === '0'
  ) {
    return { kind: 'inline-requested' };
  }
  if (isStandaloneBinary()) return { kind: 'available', url: standaloneDaemonUrl('chronicle') };
  const url = locateChronicleProjectServer(moduleUrl, exists);
  return url ? { kind: 'available', url } : { kind: 'missing-build' };
}

export function resolveChronicleProjectServerUrl(
  moduleUrl = import.meta.url,
  exists: (filePath: string) => boolean = probeFileExists,
): URL | null {
  const availability = resolveChronicleDaemonAvailability(moduleUrl, exists);
  return availability.kind === 'available' ? availability.url : null;
}

function locateChronicleProjectServer(
  moduleUrl: string,
  exists: (filePath: string) => boolean,
): URL | null {
  const candidates = [
    // Normal unbundled output: dist/chronicle/project-server-client.js.
    './project-server.js',
    // Core plugin bundle: dist/plugin/index.js.
    '../chronicle/project-server.js',
    // Core root bundle: dist/index.js.
    './chronicle/project-server.js',
  ];
  for (const relativePath of candidates) {
    try {
      const url = new URL(relativePath, moduleUrl);
      if (url.protocol === 'file:' && exists(fileURLToPath(url))) return url;
    } catch {
      // Try the next known output layout.
    }
  }
  return null;
}

export function isChronicleProjectServerAvailable(): boolean {
  return resolveChronicleProjectServerUrl() !== null;
}

function isUnauthorizedChronicleError(error: unknown): boolean {
  return error instanceof Error && error.name === 'UnauthorizedChronicleRequest';
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Multiplexed IPC client for the single Chronicle owner of a local project.
 */
export class ChronicleProjectServerClient {
  readonly endpoint: string;
  private socket: net.Socket | null = null;
  private info: ChronicleProjectServerInfo | null = null;
  private buffer = '';
  private connecting: Promise<void> | null = null;
  private connectResolve: (() => void) | null = null;
  private connectReject: ((error: unknown) => void) | null = null;
  /** Bumped by close(); an election started before it stops retrying. */
  private closeGeneration = 0;
  private nextId = 1;
  /** WS-027: read from the owner-only metadata file — see currentAuthToken. */
  private authToken: string | undefined;
  private readonly pending = new Map<number, PendingRequest>();

  constructor(readonly options: ChronicleProjectServerClientOptions) {
    this.endpoint = chronicleProjectServerEndpoint(options.projectDir);
  }

  async call<O extends ChronicleServerOperationName>(
    op: O,
    args: ChronicleServerOperations[O]['args'],
    options: ChronicleProjectServerCallOptions = {},
  ): Promise<ChronicleServerOperations[O]['result']> {
    await this.ensureConnected(true);
    return retryWhileUnauthorized(
      () =>
        this.request<ChronicleServerOperations[O]['result']>(
          { type: 'request', op, args },
          options.timeoutMs ?? DEFAULT_CALL_TIMEOUT_MS,
        ),
      isUnauthorizedChronicleError,
    );
  }

  ping(): Promise<ChronicleProjectServerHealth> {
    return this.call('ping', {}, { timeoutMs: 3_000 });
  }

  /**
   * Request the Chronicle project server to shut down cleanly.
   *
   * Returns the server PID and acknowledgment. Does not throw if the server
   * is already offline or unreachable — the caller is assumed to want the
   * server stopped regardless of current state.
   */
  async shutdown(reason?: string): Promise<{ stopped: boolean; pid?: number; reason?: string }> {
    try {
      await this.ensureConnected(false);
    } catch {
      return { stopped: false, reason: 'offline' };
    }
    const pid = this.info?.pid;
    try {
      const result = (await this.request<{ stopped: boolean; pid?: number; reason?: string }>(
        { type: 'shutdown', reason },
        5_000,
      )) ?? { stopped: true };
      return { ...result, ...(pid !== undefined && result.pid === undefined ? { pid } : {}) };
    } catch {
      return { stopped: false, ...(pid !== undefined ? { pid } : {}), reason: 'write-failed' };
    }
  }

  async close(): Promise<void> {
    // An election started before close() stops retrying: rejecting its
    // handshake below was otherwise one more failed attempt, and the loop
    // reconnected (and re-armed the daemon spawn) for a closed client.
    this.closeGeneration++;
    const socket = this.socket;
    this.socket = null;
    this.info = null;
    // onClose() no longer sees this socket as current, so its calls fail here.
    this.failInFlight(new Error('Chronicle project server connection closed'));
    if (socket && !socket.destroyed) {
      await new Promise<void>((resolve) => {
        socket.once('close', resolve);
        socket.end();
      });
    }
  }

  private async ensureConnected(spawnIfMissing: boolean): Promise<void> {
    if (this.socket && !this.socket.destroyed && this.info) return;
    if (this.connecting) return this.connecting;
    if (!isChronicleProjectServerAvailable()) {
      throw new Error(
        'Built Chronicle project server is unavailable. Build @wrongstack/core or use the inline journal.',
      );
    }
    this.connecting = this.connectWithElection(spawnIfMissing).finally(() => {
      this.connecting = null;
    });
    return this.connecting;
  }

  private async connectWithElection(spawnIfMissing: boolean): Promise<void> {
    const deadline =
      Date.now() + (spawnIfMissing ? SERVER_START_TIMEOUT_MS : CONNECT_ATTEMPT_TIMEOUT_MS);
    let lastSpawnAt = 0;
    let lastError: unknown = new Error('Chronicle project server unavailable');
    const generation = this.closeGeneration;
    while (Date.now() < deadline && generation === this.closeGeneration) {
      try {
        await this.connectOnce();
        return;
      } catch (error) {
        lastError = error;
      }
      if (!spawnIfMissing || generation !== this.closeGeneration) break;
      const now = Date.now();
      if (now - lastSpawnAt >= SPAWN_RETRY_CADENCE_MS) {
        // A synchronous throw from the spawn path — the resolver transiently
        // failing to stat the dist entrypoint under load — must not unwind
        // the whole retry window (mailbox sibling flake, observed 2026-09-15).
        // Degrade to "this tick spawned nothing"; lastSpawnAt stays unset so
        // the next tick retries immediately rather than waiting out the
        // cadence. Cadence-bounded re-arming also recovers a dead first
        // daemon, which the old single-shot `spawned` flag made fatal.
        try {
          this.spawnDetachedServer();
          lastSpawnAt = now;
        } catch {
          // Resolution failures are retryable by the loop below.
        }
      }
      await delay(75);
    }
    throw lastError;
  }

  private connectOnce(): Promise<void> {
    this.socket?.destroy();
    this.socket = null;
    // A respawned daemon mints a new token; a cached one authenticates
    // nothing. Drop it and re-read on first use.
    this.authToken = undefined;
    this.info = null;
    this.buffer = '';
    return new Promise<void>((resolve, reject) => {
      const socket = net.createConnection(this.endpoint);
      this.socket = socket;
      socket.setEncoding('utf8');
      const timer = setTimeout(() => {
        reject(new Error('Chronicle project server handshake timed out'));
        socket.destroy();
      }, CONNECT_ATTEMPT_TIMEOUT_MS);
      timer.unref?.();
      this.connectResolve = () => {
        clearTimeout(timer);
        this.connectResolve = null;
        this.connectReject = null;
        resolve();
      };
      this.connectReject = (error) => {
        clearTimeout(timer);
        this.connectResolve = null;
        this.connectReject = null;
        reject(error);
      };
      socket.on('data', (chunk: string) => this.onData(socket, chunk));
      socket.on('error', (error) => {
        if (!this.info) this.connectReject?.(error);
      });
      socket.on('close', () => this.onClose(socket));
    });
  }

  /**
   * WS-027: the per-process token, read from the daemon's owner-only metadata
   * file — never from the `hello` frame, which the daemon sends to every
   * socket that connects (the mistake WS-028 found in the SAGE daemon).
   *
   * Read lazily and re-read while unknown: the daemon starts listening before
   * it writes metadata (endpoint ownership has to be won first), and a
   * respawned daemon mints a new token, so a cached wrong one would be sticky.
   */
  private currentAuthToken(): string | undefined {
    if (this.authToken === undefined) {
      try {
        const raw = fs.readFileSync(
          chronicleProjectServerMetadataPath(this.options.projectDir),
          'utf8',
        );
        const parsed = JSON.parse(raw) as { authToken?: unknown };
        if (typeof parsed.authToken === 'string' && parsed.authToken.length > 0) {
          this.authToken = parsed.authToken;
        }
      } catch {
        // Left undefined; the daemon answers with a clear
        // `UnauthorizedChronicleRequest`, which beats a connect that silently
        // succeeds and then fails every call.
      }
    }
    return this.authToken;
  }

  private request<T>(
    message:
      | { type: 'request'; op: ChronicleServerOperationName; args: unknown }
      | { type: 'shutdown'; reason?: string | undefined },
    timeoutMs: number,
  ): Promise<T> {
    const socket = this.socket;
    if (!socket || socket.destroyed) {
      return Promise.reject(new Error('Chronicle project server connection is unavailable'));
    }
    const id = this.nextId++;
    const encoded = encodeChronicleProjectServerMessage({
      ...message,
      id,
      authToken: this.currentAuthToken(),
    });
    if (encoded.length > CHRONICLE_PROJECT_SERVER_MAX_FRAME_CHARS) {
      return Promise.reject(new Error('Chronicle project server request exceeded frame limit'));
    }
    const label = message.type === 'request' ? message.op : message.type;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        const pending = this.pending.get(id);
        if (!pending) return;
        this.pending.delete(id);
        pending.reject(new Error(`Chronicle ${label} exceeded its ${timeoutMs}ms timeout`));
      }, timeoutMs);
      timer.unref?.();
      this.pending.set(id, { resolve, reject, timer });
      try {
        socket.write(encoded);
      } catch (error) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(error);
      }
    });
  }

  private onData(socket: net.Socket, chunk: string): void {
    if (socket !== this.socket) return;
    if (this.buffer.length + chunk.length > CHRONICLE_PROJECT_SERVER_MAX_FRAME_CHARS) {
      socket.destroy(new Error('Chronicle project server response exceeded frame limit'));
      return;
    }
    // Scan only the new chunk: the pending tail never holds a newline, and
    // re-scanning it per chunk made a large response O(n²) to receive.
    let newline = chunk.indexOf('\n');
    if (newline < 0) {
      this.buffer += chunk;
      return;
    }
    let line = this.buffer + chunk.slice(0, newline);
    let start = newline + 1;
    this.buffer = '';
    while (true) {
      if (line) {
        let message: ChronicleProjectServerMessage;
        try {
          message = JSON.parse(line) as ChronicleProjectServerMessage;
        } catch {
          socket.destroy(new Error('Invalid Chronicle project server response'));
          return;
        }
        this.onMessage(message);
      }
      newline = chunk.indexOf('\n', start);
      if (newline < 0) break;
      line = chunk.slice(start, newline);
      start = newline + 1;
    }
    this.buffer = chunk.slice(start);
  }

  private onMessage(message: ChronicleProjectServerMessage): void {
    if (message.type === 'hello') {
      if (message.protocolVersion !== CHRONICLE_PROJECT_SERVER_PROTOCOL_VERSION) {
        this.connectReject?.(
          new Error(
            `Chronicle protocol mismatch: client=${CHRONICLE_PROJECT_SERVER_PROTOCOL_VERSION}, server=${message.protocolVersion}`,
          ),
        );
        this.socket?.destroy();
        return;
      }
      if (
        normalizePath(message.projectRoot) !== normalizePath(this.options.projectRoot) ||
        normalizePath(message.projectDir) !== normalizePath(this.options.projectDir)
      ) {
        this.connectReject?.(new Error('Chronicle project server identity mismatch'));
        this.socket?.destroy();
        return;
      }
      this.info = message;
      this.connectResolve?.();
      return;
    }
    const pending = this.pending.get(message.id);
    if (!pending) return;
    this.pending.delete(message.id);
    clearTimeout(pending.timer);
    if (message.ok) pending.resolve(message.result);
    else {
      const error = new Error(message.error);
      if (message.errorName) error.name = message.errorName;
      // Re-read the token on the next attempt: the file may name another daemon.
      if (isUnauthorizedChronicleError(error)) this.authToken = undefined;
      pending.reject(error);
    }
  }

  private onClose(socket: net.Socket): void {
    if (socket !== this.socket) return;
    this.socket = null;
    this.info = null;
    this.failInFlight(new Error('Chronicle project server connection closed'));
  }

  private failInFlight(error: Error): void {
    this.connectReject?.(error);
    this.connectResolve = null;
    this.connectReject = null;
    const pending = [...this.pending.values()];
    this.pending.clear();
    for (const request of pending) {
      clearTimeout(request.timer);
      request.reject(error);
    }
  }

  private spawnDetachedServer(): void {
    const url = resolveChronicleProjectServerUrl();
    if (!url) throw new Error('Built Chronicle project server is unavailable');
    const args = [
      '--project-root',
      this.options.projectRoot,
      '--global-root',
      this.options.globalRoot,
      '--project-id',
      this.options.projectId,
      '--project-dir',
      this.options.projectDir,
      '--workspace-id',
      this.options.workspaceId,
    ];
    for (const [flag, value] of [
      ['--retention-days', this.options.retentionDays],
      ['--max-events', this.options.maxEvents],
      ['--max-bytes', this.options.maxBytes],
      ['--metrics-row-retention-days', this.options.metricsRowRetentionDays],
    ] as const) {
      if (value !== undefined) args.push(flag, String(value));
    }
    const child = spawn(process.execPath, daemonSpawnArgs(url, args), {
      detached: true,
      stdio: 'ignore',
      windowsHide: true,
      env: process.env,
    });
    child.unref();
  }
}

interface QueuedAppend {
  input: ChronicleEventInput;
  resolve(event: ChronicleEvent): void;
  reject(error: unknown): void;
}

/**
 * ChronicleEventSink backed by the project server. A short client-side batch
 * window keeps high-frequency EventBus adapters from turning into one IPC
 * round trip per event.
 */
export class ChronicleRemoteJournal implements ChronicleEventSink {
  private readonly client: ChronicleProjectServerClient;
  private readonly maxPending: number;
  private readonly batchWindowMs: number;
  private pending: QueuedAppend[] = [];
  private timer: ReturnType<typeof setTimeout> | undefined;
  private microtaskScheduled = false;
  private disposed = false;
  private readonly inflight = new Set<Promise<void>>();
  private readonly counters = {
    acceptedEvents: 0,
    persistedEvents: 0,
    rejectedEvents: 0,
    failedEvents: 0,
    batches: 0,
    maxObservedPending: 0,
    largestBatch: 0,
    partitionRolls: 0,
  };
  private lastBatchDurationMs: number | undefined;

  constructor(
    options: ChronicleProjectServerClientOptions & {
      maxPending?: number | undefined;
      batchWindowMs?: number | undefined;
    },
    client = new ChronicleProjectServerClient(options),
  ) {
    this.client = client;
    this.maxPending = Math.max(1, options.maxPending ?? DEFAULT_MAX_PENDING);
    this.batchWindowMs = Math.max(0, options.batchWindowMs ?? DEFAULT_BATCH_WINDOW_MS);
  }

  append(input: ChronicleEventInput): Promise<ChronicleEvent> {
    if (this.disposed) {
      this.counters.rejectedEvents++;
      return Promise.reject(new Error('Chronicle remote journal is disposed'));
    }
    if (this.pending.length >= this.maxPending) {
      this.counters.rejectedEvents++;
      return Promise.reject(
        new Error(`Chronicle backpressure limit reached (${this.maxPending} pending events)`),
      );
    }
    const promise = new Promise<ChronicleEvent>((resolve, reject) => {
      this.pending.push({ input, resolve, reject });
    });
    this.counters.acceptedEvents++;
    this.counters.maxObservedPending = Math.max(
      this.counters.maxObservedPending,
      this.pending.length,
    );
    this.schedule();
    return promise;
  }

  stats(): ChronicleJournalStats {
    return {
      ...this.counters,
      pendingEvents: this.pending.length,
      ...(this.lastBatchDurationMs !== undefined
        ? { lastBatchDurationMs: this.lastBatchDurationMs }
        : {}),
    };
  }

  async flush(): Promise<void> {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
    while (this.pending.length > 0 || this.inflight.size > 0) {
      if (this.pending.length > 0) this.startBatch();
      await Promise.all([...this.inflight]);
    }
    if (this.counters.acceptedEvents === 0) return;
    await this.client.call('flush', {}, { timeoutMs: APPEND_CALL_TIMEOUT_MS });
  }

  async dispose(): Promise<void> {
    this.disposed = true;
    try {
      await this.flush();
    } finally {
      await this.client.close();
    }
  }

  private schedule(): void {
    if (this.timer || this.microtaskScheduled) return;
    if (this.batchWindowMs === 0) {
      this.microtaskScheduled = true;
      queueMicrotask(() => {
        this.microtaskScheduled = false;
        this.startBatch();
      });
      return;
    }
    this.timer = setTimeout(() => {
      this.timer = undefined;
      this.startBatch();
    }, this.batchWindowMs);
    this.timer.unref?.();
  }

  private startBatch(): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
    if (this.pending.length === 0) return;
    // Chunked at the server's bound, not drained wholesale. `maxPending` allows
    // a backlog ten times this size, so a slow or restarting daemon could grow
    // `pending` past what one call may carry — and the server rejects an
    // oversized batch as malformed, which turned "persist late" into "lose
    // everything". The remainder is rescheduled by the `finally` below.
    const batch = this.pending.splice(0, CHRONICLE_MAX_APPEND_BATCH);
    const started = performance.now();
    this.counters.batches++;
    this.counters.largestBatch = Math.max(this.counters.largestBatch, batch.length);
    const run = this.client
      .call(
        'append',
        { inputs: batch.map((entry) => entry.input) },
        { timeoutMs: APPEND_CALL_TIMEOUT_MS },
      )
      .then((events) => {
        if (events.length !== batch.length) {
          throw new Error(
            `Chronicle server returned ${events.length} events for ${batch.length} inputs`,
          );
        }
        batch.forEach((entry, index) => {
          entry.resolve(events[index]!);
        });
        this.counters.persistedEvents += batch.length;
      })
      .catch((error) => {
        this.counters.failedEvents += batch.length;
        for (const entry of batch) entry.reject(error);
      })
      .finally(() => {
        this.lastBatchDurationMs = performance.now() - started;
        this.inflight.delete(run);
        if (this.pending.length > 0) this.schedule();
      });
    this.inflight.add(run);
  }
}

function normalizePath(value: string): string {
  const resolved = path.resolve(value);
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}
