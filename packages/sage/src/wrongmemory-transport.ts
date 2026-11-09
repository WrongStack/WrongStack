/**
 * Connection and session transport for the WrongMemory port: owns the client
 * connection, project resolution and the port-wide call lock, so every daemon
 * call runs {@link WrongMemoryTransport.scoped} under one serialized,
 * session-bound pipeline.
 */
import {
  type ConnectOptions,
  METHODS,
  type ProjectInfo,
  WrongMemoryClient,
  WrongMemoryError,
} from '@wrongstack/wrongmemory-client';
import type { Sage } from './types.js';
import type { StartDaemonOptions } from './wrongmemory-daemon.js';
import { resolveWrongMemoryProject, startWrongMemoryDaemon } from './wrongmemory-daemon.js';
import { type WrongMemoryClientLike, WrongMemoryUnavailableError } from './wrongmemory-errors.js';
import {
  type CallOpts,
  compact,
  isTransportFailure,
  normalizeRoot,
  type SessionChoice,
} from './wrongmemory-wire.js';

export interface WrongMemoryPortOptions {
  projectRoot: string;
  /** Use this registered project instead of locating/registering by root. */
  projectId?: string | undefined;
  /** WrongMemory data root (default: `WRONGMEMORY_HOME` or `~/.wrongmemory`). */
  dataRoot?: string | undefined;
  /** `wrongmemoryd` executable used when `startPolicy` is `on-demand`. */
  daemonPath?: string | undefined;
  /** `on-demand` starts the daemon when none is reachable; `never` only attaches. */
  startPolicy?: 'on-demand' | 'never' | undefined;
  /** When false, an unregistered root fails instead of being registered. Default true. */
  register?: boolean | undefined;
  /** Session resolver used when a call carries no explicit `sessionId`. */
  getSessionId?: (() => string | undefined) | undefined;
  /**
   * Host event bus. After this port's own committed mutations it emits the
   * events the in-process store emits (`memory.accepted`, `memory.merged`,
   * `memory.updated`, `memory.deleted`, `memory.recovered`,
   * `memory.forgotten`, `memory.consolidated`, `memory.cleared`).
   */
  events?: { emit(event: string, payload: unknown): void } | undefined;
  /**
   * With `events`, how often (ms) changes committed by *other* connections
   * (`events.since`, `origin` != this port's connections) are relayed as
   * host events. 0 disables the relay. Default 2000. The relay never starts
   * a daemon: it only polls while a connection is open.
   */
  relayIntervalMs?: number | undefined;
  clientName?: string | undefined;
  timeoutMs?: number | undefined;
  /** Daemon launcher used for `on-demand` starts (tests). */
  startDaemon?: ((options: StartDaemonOptions) => Promise<WrongMemoryClientLike>) | undefined;
  /** Connection factory (tests). Defaults to `WrongMemoryClient.connect`. */
  connect?: ((options: ConnectOptions) => Promise<WrongMemoryClientLike>) | undefined;
}

export abstract class WrongMemoryTransport {
  protected client: WrongMemoryClientLike | undefined;
  private connecting: Promise<WrongMemoryClientLike> | undefined;
  protected project: ProjectInfo | undefined;
  /** Session bound on the current connection; `undefined` = none. */
  protected boundSession: string | undefined;
  /** Connection on which the checkout binding was attempted. */
  private checkoutClient: WrongMemoryClientLike | undefined;
  protected lock: Promise<unknown> = Promise.resolve();
  protected disposed = false;
  private clientEpoch = 0;
  /** Every `connectionId` this port has used: its own changes, past and present. */
  protected readonly ownConnections = new Set<string>();

  constructor(protected readonly options: WrongMemoryPortOptions) {}

  /** Emit a host event with the session the call ran under. */
  protected emit(event: string, payload: Record<string, unknown>, sessionId?: string): void {
    const events = this.options.events;
    if (!events) return;
    const session = sessionId ?? this.options.getSessionId?.();
    try {
      events.emit(
        event,
        session && !('sessionId' in payload) ? { ...payload, sessionId: session } : payload,
      );
    } catch {
      // A listener failure must not turn a committed mutation into an error.
    }
  }

  protected emitUpdated(m: Sage): void {
    this.emit('memory.updated', {
      memoryId: m.id,
      status: m.status,
      kind: m.kind,
      persistence: m.persistence ?? 'durable',
      confidence: m.confidence,
      freshness: m.freshness,
    });
  }

  protected session(explicit: string | undefined): SessionChoice {
    return { sessionId: explicit ?? this.options.getSessionId?.() };
  }

  /**
   * Project-scoped call under the port lock: bind (or release) the session,
   * then send. A transport failure drops the connection and surfaces as
   * {@link WrongMemoryUnavailableError}.
   */
  protected scoped<T>(
    method: string,
    params: unknown,
    session: SessionChoice,
    opts: CallOpts = {},
  ): Promise<T> {
    const run = async (): Promise<T> => {
      try {
        const project = await this.ensureProject();
        const client = await this.ensureClient();
        await this.bindCheckout(client, project);
        await this.bindSession(client, session.sessionId);
        return await client.call<T>(method, params, { ...opts, projectId: project.projectId });
      } catch (error) {
        throw this.translate(error);
      }
    };
    const next = this.lock.then(run, run);
    this.lock = next.catch(() => undefined);
    return next;
  }

  /**
   * A linked worktree shares its main checkout's project, but not its files.
   * Bind this connection to the worktree once, so the daemon resolves this
   * host's absolute paths and verifies anchors against the worktree, without
   * reconciling the shared records (WrongMemory 0.1.4+). The main checkout
   * needs no binding. A daemon that predates the method, or refuses the
   * directory, keeps the main checkout's evidence, as before.
   */
  private async bindCheckout(client: WrongMemoryClientLike, project: ProjectInfo): Promise<void> {
    if (this.checkoutClient === client) return;
    this.checkoutClient = client;
    if (!project.root || normalizeRoot(project.root) === normalizeRoot(this.options.projectRoot)) {
      return;
    }
    try {
      await client.call(
        METHODS.PROJECT_BIND_CHECKOUT,
        { root: this.options.projectRoot },
        { projectId: project.projectId },
      );
    } catch (error) {
      if (isTransportFailure(error)) {
        this.checkoutClient = undefined;
        throw error;
      }
    }
  }

  private async bindSession(
    client: WrongMemoryClientLike,
    sessionId: string | undefined,
  ): Promise<void> {
    if (sessionId === this.boundSession) return;
    if (sessionId === undefined) {
      await client.call(METHODS.SESSION_RELEASE, {});
    } else {
      await client.call(METHODS.SESSION_ACQUIRE, { hostSessionId: sessionId });
    }
    this.boundSession = sessionId;
  }

  protected translate(error: unknown): unknown {
    if (error instanceof WrongMemoryUnavailableError) return error;
    if (isTransportFailure(error)) {
      this.dropClient();
      return new WrongMemoryUnavailableError((error as Error).message, { cause: error });
    }
    return error;
  }

  protected dropClient(): void {
    this.clientEpoch += 1;
    const client = this.client;
    this.client = undefined;
    this.connecting = undefined;
    this.boundSession = undefined;
    this.checkoutClient = undefined;
    client?.close();
  }

  protected async ensureClient(): Promise<WrongMemoryClientLike> {
    if (this.disposed) throw new WrongMemoryUnavailableError('port disposed');
    if (this.client) return this.client;
    if (this.connecting) return this.connecting;
    const epoch = this.clientEpoch;
    const attempt = Promise.resolve().then(async () => {
      const connect = this.options.connect ?? ((o: ConnectOptions) => WrongMemoryClient.connect(o));
      // The vendored client's own `start` spawns with the inherited
      // environment; WrongStack starts the daemon itself through
      // buildChildEnv (VF-09) and only ever connects with `start: false`.
      const connectOptions = compact({
        dataRoot: this.options.dataRoot,
        start: false,
        clientName: this.options.clientName ?? 'wrongstack',
        timeoutMs: this.options.timeoutMs,
      }) as ConnectOptions;
      try {
        let client: WrongMemoryClientLike;
        try {
          client = await connect(connectOptions);
        } catch (error) {
          if (
            this.options.startPolicy === 'never' ||
            !(error instanceof WrongMemoryError) ||
            error.code !== 'UNAVAILABLE'
          ) {
            throw error;
          }
          client = await (this.options.startDaemon ?? startWrongMemoryDaemon)({
            dataRoot: this.options.dataRoot,
            daemonPath: this.options.daemonPath,
            connect: () => connect(connectOptions),
          });
        }
        if (this.connecting === attempt) {
          this.connecting = undefined;
        }
        if (this.disposed || this.clientEpoch !== epoch) {
          client.close();
          throw new WrongMemoryUnavailableError(
            this.disposed ? 'port disposed' : 'connection released',
          );
        }
        this.client = client;
        this.boundSession = undefined;
        try {
          const id = (client as { hello?: { connectionId?: string } }).hello?.connectionId;
          if (id) this.ownConnections.add(id);
        } catch {
          // Clients without a hello (tests) have no connection id.
        }
        return client;
      } catch (error) {
        if (this.connecting === attempt) {
          this.connecting = undefined;
        }
        if (
          error instanceof WrongMemoryError &&
          (error.code === 'UNAVAILABLE' || error.code === 'TRANSPORT')
        ) {
          throw new WrongMemoryUnavailableError(error.message, { cause: error });
        }
        throw error;
      }
    });
    this.connecting = attempt;
    return attempt;
  }

  protected async ensureProject(): Promise<ProjectInfo> {
    if (this.disposed) throw new WrongMemoryUnavailableError('port disposed');
    if (this.project) return this.project;
    let client: WrongMemoryClientLike;
    try {
      client = await this.ensureClient();
    } catch (error) {
      throw this.translate(error);
    }
    if (this.disposed) throw new WrongMemoryUnavailableError('port disposed');
    try {
      this.project = await resolveWrongMemoryProject(client, {
        projectRoot: this.options.projectRoot,
        projectId: this.options.projectId,
        register: this.options.register !== false,
      });
    } catch (error) {
      throw this.translate(error);
    }
    return this.project;
  }
}
