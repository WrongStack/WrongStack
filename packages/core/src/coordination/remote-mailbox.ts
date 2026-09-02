import * as path from 'node:path';
import type { HqPublisher } from '../hq/publisher.js';
import type { EventBus } from '../kernel/events.js';
import { HQ_MAILBOX_SNAPSHOT_MIN_INTERVAL_MS } from './mailbox-constants.js';
import type {
  IssueCredentialOptions,
  MailboxCredential,
  RedactedMailboxCredential,
} from './mailbox-credential-store.js';
import type { MailboxEvent, MailboxEventEmitter } from './mailbox-events.js';
import {
  MailboxProjectServerConnection,
  type MailboxProjectServerConnectionState,
} from './mailbox-project-server-client.js';
import type {
  AgentHeartbeatInput,
  AgentRegistrationInput,
  AutoCompactOptions,
  AutoCompactResult,
  ClientHeartbeatInput,
  ClientRegistrationInput,
  ClientStatus,
  Mailbox,
  MailboxAckBatchInput,
  MailboxAckInput,
  MailboxAgentStatus,
  MailboxMessage,
  MailboxQuery,
  MailboxSendInput,
  PurgeOptions,
  PurgeResult,
} from './mailbox-types.js';
import { SQLITE_MAILBOX_FILE } from './sqlite-mailbox.js';

type HqPublisherRef = HqPublisher | (() => HqPublisher | undefined);
const HQ_MAILBOX_EVENT_MAX_PENDING = 256;

export interface ProjectMailboxOptions {
  projectDir: string;
  events?: EventBus | undefined;
  hqPublisher?: HqPublisherRef | undefined;
  eventEmitter?: MailboxEventEmitter | undefined;
  /** Tests/diagnostics only: bypass the normal one-connection-per-process cache. */
  isolatedConnection?: boolean | undefined;
}

type RemoteDependencyCache = {
  withoutPublisher?: RemoteMailbox;
  readonly byPublisher: WeakMap<object, RemoteMailbox>;
};

type RemoteProjectCache = {
  readonly withoutEvents: RemoteDependencyCache;
  readonly byEvents: WeakMap<object, RemoteDependencyCache>;
};

const sharedRemoteMailboxes = new Map<string, RemoteProjectCache>();
const sharedProjectConnections = new Map<
  string,
  { connection: MailboxProjectServerConnection; references: number }
>();

function dependencyCache(): RemoteDependencyCache {
  return { byPublisher: new WeakMap() };
}

/**
 * The project mailbox, as seen by every process that is not the owner.
 *
 * There is no second mode. One detached server per project owns the only
 * SQLite handle, and every CLI/TUI/WebUI/HQ/bridge process reaches it over
 * the deterministic IPC endpoint. If that server cannot be reached the
 * operation fails — it does not quietly become a private local store, which
 * is how the agent loop once spent a whole migration talking to a
 * `_mailbox.jsonl` nobody else read.
 */
export class RemoteMailbox implements Mailbox {
  readonly projectDir: string;
  readonly messagePath: string;
  readonly registryPath: string;
  readonly clientRegistryPath: string;
  private readonly connection: MailboxProjectServerConnection;
  private readonly ownsConnection: boolean;
  private readonly sharedConnectionKey?: string | undefined;
  private readonly events?: EventBus | undefined;
  private readonly hqPublisherRef?: HqPublisherRef | undefined;
  private readonly eventEmitter?: MailboxEventEmitter | undefined;
  private readonly unsubscribeEvent: () => void;
  private readonly unsubscribeMailboxEvent: () => void;
  private cacheEviction: (() => void) | undefined;
  private closed = false;
  /** Pending coalesced HQ snapshot; see {@link scheduleHqSnapshot}. */
  private hqSnapshotTimer: ReturnType<typeof setTimeout> | undefined;
  private hqSnapshotLastAt = 0;
  /** At most one full snapshot may query/map/serialize mailbox state at a time. */
  private hqSnapshotInFlight: Promise<void> | undefined;
  /** Latest scope requested while a timer or snapshot is already active. */
  private hqSnapshotPendingMailboxId: string | undefined;
  /** Message deltas are serialized so a burst cannot launch one full mailbox
   * query per event concurrently. Newer updates for the same message replace
   * older pending ones; the periodic snapshot remains the lossless rollup. */
  private readonly hqEventPending = new Map<string, MailboxEvent>();
  private hqEventInFlight: Promise<void> | undefined;
  private hqEventCoalesced = 0;
  private hqEventDropped = 0;

  constructor(
    optionsOrProjectDir: ProjectMailboxOptions | string,
    events?: EventBus,
    hqPublisher?: HqPublisherRef,
    eventEmitter?: MailboxEventEmitter,
  ) {
    const options =
      typeof optionsOrProjectDir === 'string'
        ? {
            projectDir: optionsOrProjectDir,
            events,
            hqPublisher,
            eventEmitter,
          }
        : optionsOrProjectDir;
    this.projectDir = path.resolve(options.projectDir);
    this.messagePath = path.join(this.projectDir, SQLITE_MAILBOX_FILE);
    this.registryPath = this.messagePath;
    this.clientRegistryPath = this.messagePath;
    this.events = options.events;
    this.hqPublisherRef = options.hqPublisher;
    this.eventEmitter = options.eventEmitter;
    // Escape hatch — must be REQUESTED, never entered by accident. Sniffing
    // VITEST/NODE_ENV here used to put the whole test suite (and anything that
    // happened to set NODE_ENV=test) on a private in-process store, which is
    // precisely the silent "one store per process" failure the project-daemon
    // invariant forbids. Matches the sibling daemons: sage, chronicle and
    // codebase-index all gate on their own `WRONGSTACK_*_INLINE` and nothing
    // else. See tests/architecture/project-daemon-boundary.test.ts.
    if (options.isolatedConnection) {
      this.connection = new MailboxProjectServerConnection(this.projectDir);
      this.ownsConnection = true;
    } else {
      let entry = sharedProjectConnections.get(this.projectDir);
      if (!entry) {
        entry = {
          connection: new MailboxProjectServerConnection(this.projectDir),
          references: 0,
        };
        sharedProjectConnections.set(this.projectDir, entry);
      }
      entry.references++;
      this.connection = entry.connection;
      this.sharedConnectionKey = this.projectDir;
      this.ownsConnection = false;
    }
    this.unsubscribeEvent = this.connection.onEvent((event, payload) => {
      this.events?.emitCustom(event, payload);
      this.publishHqRegistryEvent(event, payload);
    });
    this.unsubscribeMailboxEvent = this.connection.onMailboxEvent((event) => {
      this.eventEmitter?.emit(event);
      this.publishHqEvent(event);
    });
    // Eagerly start the detached mailbox IPC server so the first client for
    // this project has a server running without waiting for mail to be sent
    // or received. The connection is idempotent — if a concurrent
    // initialize() or operation arrives, ensureConnected deduplicates on the
    // in-flight promise. Fire-and-forget: failures are retried lazily on the
    // next real operation.
    void this.connection.connect().catch(() => {
      // Swallowed intentionally; the next mailbox operation will retry.
    });
  }

  getConnectionState(): MailboxProjectServerConnectionState {
    return this.connection.getState();
  }

  onConnectionStateChange(
    listener: (state: MailboxProjectServerConnectionState) => void,
  ): () => void {
    return this.connection.onStateChange(listener);
  }

  async initialize(): Promise<void> {
    await this.connection.connect();
    await this.connection.status();
  }

  async status() {
    return this.connection.status();
  }

  send(input: MailboxSendInput): Promise<MailboxMessage> {
    return this.connection.call('send', { input });
  }

  sendRuntimeControl(
    input: Omit<MailboxSendInput, 'type'> & { type?: 'control' },
  ): Promise<MailboxMessage> {
    return this.connection.call('sendRuntimeControl', { input });
  }

  query(query: MailboxQuery): Promise<MailboxMessage[]> {
    return this.connection.call('query', { query });
  }

  ack(input: MailboxAckInput): Promise<MailboxMessage | null> {
    return this.connection.call('ack', { input });
  }

  ackMany(input: MailboxAckBatchInput): Promise<MailboxMessage[]> {
    return this.connection.call('ackMany', { input });
  }

  unreadCount(forAgentId: string, sessionId?: string): Promise<number> {
    return this.connection.call('unreadCount', { forAgentId, sessionId });
  }

  softDelete(mailId: string, by: string): Promise<MailboxMessage | null> {
    return this.connection.call('softDelete', { mailId, by });
  }

  restore(mailId: string): Promise<MailboxMessage | null> {
    return this.connection.call('restore', { mailId });
  }

  registerAgent(input: AgentRegistrationInput): Promise<void> {
    return this.connection.call('registerAgent', { input });
  }

  deregisterAgent(agentId: string): Promise<void> {
    return this.connection.call('deregisterAgent', { agentId });
  }

  heartbeat(input: AgentHeartbeatInput): Promise<void> {
    return this.connection.call('heartbeat', { input });
  }

  getAgentStatuses(): Promise<MailboxAgentStatus[]> {
    return this.connection.call('getAgentStatuses', {});
  }

  getOnlineAgents(): Promise<MailboxAgentStatus[]> {
    return this.connection.call('getOnlineAgents', {});
  }

  purgeAgents(maxAgeMs?: number): Promise<number> {
    return this.connection.call('purgeAgents', { maxAgeMs });
  }

  registerClient(input: ClientRegistrationInput): Promise<void> {
    return this.connection.call('registerClient', { input });
  }

  deregisterClient(clientId: string): Promise<void> {
    return this.connection.call('deregisterClient', { clientId });
  }

  clientHeartbeat(input: ClientHeartbeatInput): Promise<void> {
    return this.connection.call('clientHeartbeat', { input });
  }

  getClientStatuses(): Promise<ClientStatus[]> {
    return this.connection.call('getClientStatuses', {});
  }

  purgeClients(): Promise<number> {
    return this.connection.call('purgeClients', {});
  }

  clearAll(): Promise<void> {
    return this.connection.call('clearAll', {});
  }

  purgeStale(options?: PurgeOptions): Promise<PurgeResult> {
    return this.connection.call('purgeStale', { options });
  }

  autoCompact(options?: AutoCompactOptions): Promise<AutoCompactResult> {
    return this.connection.call('autoCompact', { options }, { timeoutMs: 2 * 60_000 });
  }

  credentialIssue(
    options: IssueCredentialOptions,
  ): Promise<{ credential: MailboxCredential; secret: string }> {
    return this.connection.call('credentialIssue', { options });
  }

  credentialVerify(
    credentialId: string,
    secret: string,
  ): Promise<{
    valid: boolean;
    credential?: RedactedMailboxCredential | undefined;
    reason?: string | undefined;
  }> {
    return this.connection.call('credentialVerify', { credentialId, secret });
  }

  credentialRevoke(credentialId: string, reason?: string, by?: string): Promise<boolean> {
    return this.connection.call('credentialRevoke', { credentialId, reason, by });
  }

  credentialRotate(
    credentialId: string,
    options?: Partial<IssueCredentialOptions>,
  ): Promise<{ credential: MailboxCredential; secret: string } | null> {
    return this.connection.call('credentialRotate', { credentialId, options });
  }

  credentialGet(credentialId: string): Promise<RedactedMailboxCredential | null> {
    return this.connection.call('credentialGet', { credentialId });
  }

  credentialList(): Promise<RedactedMailboxCredential[]> {
    return this.connection.call('credentialList', {});
  }

  credentialStatusCounts(): Promise<Record<string, number>> {
    return this.connection.call('credentialStatusCounts', {});
  }

  startAutoCompactTimer(_options?: AutoCompactOptions): () => void {
    // The detached owner runs exactly one compaction timer for the project;
    // clients must never start their own.
    return () => {};
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    if (this.hqSnapshotTimer !== undefined) {
      clearTimeout(this.hqSnapshotTimer);
      this.hqSnapshotTimer = undefined;
    }
    this.hqSnapshotPendingMailboxId = undefined;
    this.hqEventPending.clear();
    this.cacheEviction?.();
    this.cacheEviction = undefined;
    this.unsubscribeEvent();
    this.unsubscribeMailboxEvent();
    if (this.ownsConnection) {
      this.connection.close();
      return;
    }
    if (this.sharedConnectionKey !== undefined) {
      const entry = sharedProjectConnections.get(this.sharedConnectionKey);
      if (entry?.connection === this.connection) {
        entry.references = Math.max(0, entry.references - 1);
        if (entry.references === 0) {
          entry.connection.close();
          sharedProjectConnections.delete(this.sharedConnectionKey);
        }
      }
    }
  }

  /** @internal Remove a process-shared wrapper from its cache when explicitly closed. */
  setCacheEviction(evict: () => void): void {
    this.cacheEviction = evict;
  }

  /** Lightweight diagnostics for the process memory flight recorder. */
  getHqSnapshotStats(): {
    inFlight: boolean;
    pending: boolean;
    timerScheduled: boolean;
    eventInFlight: boolean;
    pendingEvents: number;
    coalescedEvents: number;
    droppedEvents: number;
  } {
    return {
      inFlight: this.hqSnapshotInFlight !== undefined,
      pending: this.hqSnapshotPendingMailboxId !== undefined,
      timerScheduled: this.hqSnapshotTimer !== undefined,
      eventInFlight: this.hqEventInFlight !== undefined,
      pendingEvents: this.hqEventPending.size,
      coalescedEvents: this.hqEventCoalesced,
      droppedEvents: this.hqEventDropped,
    };
  }

  private get hqPublisher(): HqPublisher | undefined {
    return typeof this.hqPublisherRef === 'function' ? this.hqPublisherRef() : this.hqPublisherRef;
  }

  /**
   * Publish a full HQ mailbox snapshot, at most once per
   * {@link HQ_MAILBOX_SNAPSHOT_MIN_INTERVAL_MS}.
   *
   * Trailing-edge: the first caller after the interval schedules one, and
   * every caller in the window folds into it. The snapshot is a rollup of
   * current state, so a coalesced publish carries strictly more up-to-date
   * information than the ones it replaced — dropping them loses nothing.
   */
  private scheduleHqSnapshot(mailboxId: string): void {
    if (this.closed) return;
    this.hqSnapshotPendingMailboxId = mailboxId;
    if (this.hqSnapshotTimer !== undefined || this.hqSnapshotInFlight !== undefined) return;
    const elapsed = Date.now() - this.hqSnapshotLastAt;
    const delay = Math.max(0, HQ_MAILBOX_SNAPSHOT_MIN_INTERVAL_MS - elapsed);
    this.hqSnapshotTimer = setTimeout(() => {
      this.hqSnapshotTimer = undefined;
      const pendingMailboxId = this.hqSnapshotPendingMailboxId;
      this.hqSnapshotPendingMailboxId = undefined;
      const publisher = this.hqPublisher;
      if (this.closed || !publisher || pendingMailboxId === undefined) return;
      this.hqSnapshotLastAt = Date.now();
      const inFlight = (async () => {
        try {
          await publisher.publishMailboxSnapshot(this, { mailboxId: pendingMailboxId });
        } catch {
          // HQ telemetry remains best-effort.
        } finally {
          this.hqSnapshotInFlight = undefined;
          const nextMailboxId = this.hqSnapshotPendingMailboxId;
          if (!this.closed && nextMailboxId !== undefined) {
            this.scheduleHqSnapshot(nextMailboxId);
          }
        }
      })();
      this.hqSnapshotInFlight = inFlight;
    }, delay);
    // Never hold the process open for a telemetry rollup.
    this.hqSnapshotTimer.unref?.();
  }

  private publishHqEvent(event: MailboxEvent): void {
    if (!this.hqPublisher || this.closed) return;
    if (this.hqEventPending.has(event.messageId)) {
      this.hqEventCoalesced += 1;
    } else if (this.hqEventPending.size >= HQ_MAILBOX_EVENT_MAX_PENDING) {
      const oldest = this.hqEventPending.keys().next().value;
      if (oldest !== undefined) this.hqEventPending.delete(oldest);
      this.hqEventDropped += 1;
    }
    this.hqEventPending.set(event.messageId, event);
    this.drainHqEvents();
  }

  private drainHqEvents(): void {
    if (this.closed || this.hqEventInFlight !== undefined) return;
    const next = this.hqEventPending.entries().next().value as [string, MailboxEvent] | undefined;
    if (!next) return;
    const [messageId, event] = next;
    this.hqEventPending.delete(messageId);
    const publisher = this.hqPublisher;
    if (!publisher) {
      this.hqEventPending.clear();
      return;
    }
    const mailboxId = `${path.basename(this.projectDir)}:mailbox`;
    const inFlight = this.query({ includeDeleted: true, limit: 100 })
      .then((messages) => {
        const message = messages.find((candidate) => candidate.id === event.messageId);
        const action = event.type === 'message.sent' ? 'message.sent' : 'message.updated';
        publisher.publishMailboxEvent({
          mailboxId,
          action,
          ...(message ? { message } : {}),
          timestamp: event.timestamp,
        });
        this.scheduleHqSnapshot(mailboxId);
      })
      .catch(() => {
        // HQ telemetry remains best-effort.
      })
      .finally(() => {
        this.hqEventInFlight = undefined;
        this.drainHqEvents();
      });
    this.hqEventInFlight = inFlight;
  }

  private publishHqRegistryEvent(event: string, payload: unknown): void {
    const publisher = this.hqPublisher;
    if (
      !publisher ||
      this.closed ||
      (!event.startsWith('mailbox.agent_') && !event.startsWith('mailbox.client_'))
    ) {
      return;
    }
    const mailboxId = `${path.basename(this.projectDir)}:mailbox`;
    const record =
      typeof payload === 'object' && payload !== null ? (payload as Record<string, unknown>) : {};
    const agentId = typeof record['agentId'] === 'string' ? record['agentId'] : undefined;
    const action =
      event === 'mailbox.agent_registered'
        ? 'agent.registered'
        : event === 'mailbox.agent_heartbeat'
          ? 'agent.heartbeat'
          : event === 'mailbox.agent_deregistered'
            ? 'agent.deregistered'
            : undefined;

    // Only a fresh registration introduces a roster row worth fetching, so it
    // is the only transition that pays for a `getAgentStatuses()` round-trip.
    // Every registry event used to pay for one, which meant:
    //   - `agent.heartbeat`: one IPC call per agent per 30s per attached
    //     wrapper, to attach a roster entry whose only consumer reads
    //     `agent.online`. The coalesced snapshot is the authoritative roster,
    //     and heartbeats deliberately do not schedule one (below) precisely
    //     because they move no roster membership — fetching it here
    //     contradicted that.
    //   - `agent.deregistered`: the row is already deleted from the registry
    //     by the time the event fires, so the lookup could never match. The
    //     published payload was identical to the one built here.
    //   - `mailbox.client_*`: carries no `agentId` and maps to no action, so
    //     the fetched roster was discarded untouched.
    if (action !== 'agent.registered') {
      if (action) {
        publisher.publishMailboxEvent({
          mailboxId,
          action,
          ...(agentId ? { summary: agentId } : {}),
        });
      }
      // A heartbeat only refreshes one agent's `lastSeen` — it changes no
      // roster membership and no message state, so the snapshot rollup it
      // used to trigger was pure duplication of the delta just published.
      // With one heartbeat per agent per 30s, that path alone accounted for
      // most of the snapshot volume. Deregistration and client registry
      // changes do move state, so those still schedule a (coalesced) snapshot.
      if (action !== 'agent.heartbeat') this.scheduleHqSnapshot(mailboxId);
      return;
    }

    void this.getAgentStatuses()
      .then((statuses) => {
        if (this.closed) return;
        const agent = agentId
          ? statuses.find((candidate) => candidate.agentId === agentId)
          : undefined;
        publisher.publishMailboxEvent({
          mailboxId,
          action,
          ...(agent ? { agent } : {}),
          ...(agentId ? { summary: agentId } : {}),
        });
        this.scheduleHqSnapshot(mailboxId);
      })
      .catch(() => {
        // HQ telemetry remains best-effort.
      });
  }
}

export function createProjectMailbox(options: ProjectMailboxOptions): RemoteMailbox {
  return new RemoteMailbox(options);
}

export function getSharedProjectMailbox(
  projectDir: string,
  events?: EventBus,
  hqPublisher?: HqPublisherRef,
): RemoteMailbox {
  const key = path.resolve(projectDir);
  let projectCache = sharedRemoteMailboxes.get(key);
  if (!projectCache) {
    projectCache = {
      withoutEvents: dependencyCache(),
      byEvents: new WeakMap(),
    };
    sharedRemoteMailboxes.set(key, projectCache);
  }
  let dependencies = projectCache.withoutEvents;
  if (events) {
    dependencies = projectCache.byEvents.get(events) ?? dependencyCache();
    projectCache.byEvents.set(events, dependencies);
  }
  if (!hqPublisher) {
    if (!dependencies.withoutPublisher) {
      const mailbox = new RemoteMailbox(key, events);
      dependencies.withoutPublisher = mailbox;
      mailbox.setCacheEviction(() => {
        if (dependencies.withoutPublisher === mailbox) {
          delete dependencies.withoutPublisher;
        }
      });
    }
    return dependencies.withoutPublisher;
  }
  const publisherKey = Object(hqPublisher);
  const existing = dependencies.byPublisher.get(publisherKey);
  if (existing) return existing;
  const mailbox = new RemoteMailbox(key, events, hqPublisher);
  dependencies.byPublisher.set(publisherKey, mailbox);
  mailbox.setCacheEviction(() => {
    if (dependencies.byPublisher.get(publisherKey) === mailbox) {
      dependencies.byPublisher.delete(publisherKey);
    }
  });
  return mailbox;
}
