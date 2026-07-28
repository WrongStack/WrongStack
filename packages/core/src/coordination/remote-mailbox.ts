import * as path from 'node:path';
import type { HqPublisher } from '../hq/publisher.js';
import type { EventBus } from '../kernel/events.js';
import { GlobalMailbox } from './global-mailbox.js';
import type {
  CredentialValidation,
  IssueCredentialOptions,
  MailboxCredential,
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
 * Server-backed project mailbox. This is the production-facing Mailbox
 * implementation; the detached project server owns the SQLite connection.
 */
export class RemoteMailbox implements Mailbox {
  readonly projectDir: string;
  readonly messagePath: string;
  readonly registryPath: string;
  readonly clientRegistryPath: string;
  private readonly connection: MailboxProjectServerConnection;
  private readonly inlineMailbox?: GlobalMailbox | undefined;
  private readonly ownsConnection: boolean;
  private readonly sharedConnectionKey?: string | undefined;
  private readonly events?: EventBus | undefined;
  private readonly hqPublisherRef?: HqPublisherRef | undefined;
  private readonly eventEmitter?: MailboxEventEmitter | undefined;
  private readonly unsubscribeEvent: () => void;
  private readonly unsubscribeMailboxEvent: () => void;
  private cacheEviction: (() => void) | undefined;
  private closed = false;

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
    const inlineForTests =
      !process.env['WRONGSTACK_MAILBOX_FORCE_SERVER'] &&
      (Boolean(process.env['VITEST']) || process.env['NODE_ENV'] === 'test');
    if (inlineForTests) {
      this.inlineMailbox = new GlobalMailbox(
        this.projectDir,
        options.events,
        options.hqPublisher,
        options.eventEmitter,
      );
      this.connection = new MailboxProjectServerConnection(this.projectDir);
      this.ownsConnection = false;
      this.unsubscribeEvent = () => {};
      this.unsubscribeMailboxEvent = () => {};
      return;
    }
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
  }

  getConnectionState(): MailboxProjectServerConnectionState {
    if (this.inlineMailbox) {
      return {
        status: 'connected',
        connected: true,
        projectDir: this.projectDir,
        endpoint: 'inline-test-adapter',
        pid: process.pid,
      };
    }
    return this.connection.getState();
  }

  onConnectionStateChange(
    listener: (state: MailboxProjectServerConnectionState) => void,
  ): () => void {
    if (this.inlineMailbox) {
      listener(this.getConnectionState());
      return () => {};
    }
    return this.connection.onStateChange(listener);
  }

  async initialize(): Promise<void> {
    if (this.inlineMailbox) return;
    await this.connection.connect();
    await this.connection.status();
  }

  async status() {
    if (this.inlineMailbox) {
      return {
        protocolVersion: 0,
        pid: process.pid,
        projectDir: this.projectDir,
        endpoint: 'inline-test-adapter',
        startedAt: new Date(0).toISOString(),
        clients: 1,
        pendingRequests: 0,
        messagePath: this.messagePath,
        databasePath: this.messagePath,
        storageKind: 'legacy-test-adapter' as const,
      };
    }
    return this.connection.status();
  }

  send(input: MailboxSendInput): Promise<MailboxMessage> {
    if (this.inlineMailbox) return this.inlineMailbox.send(input);
    return this.connection.call('send', { input });
  }

  sendRuntimeControl(
    input: Omit<MailboxSendInput, 'type'> & { type?: 'control' },
  ): Promise<MailboxMessage> {
    if (this.inlineMailbox) return this.inlineMailbox.sendRuntimeControl(input);
    return this.connection.call('sendRuntimeControl', { input });
  }

  query(query: MailboxQuery): Promise<MailboxMessage[]> {
    if (this.inlineMailbox) return this.inlineMailbox.query(query);
    return this.connection.call('query', { query });
  }

  ack(input: MailboxAckInput): Promise<MailboxMessage | null> {
    if (this.inlineMailbox) return this.inlineMailbox.ack(input);
    return this.connection.call('ack', { input });
  }

  ackMany(input: MailboxAckBatchInput): Promise<MailboxMessage[]> {
    if (this.inlineMailbox) return this.inlineMailbox.ackMany(input);
    return this.connection.call('ackMany', { input });
  }

  unreadCount(forAgentId: string, sessionId?: string): Promise<number> {
    if (this.inlineMailbox) return this.inlineMailbox.unreadCount(forAgentId, sessionId);
    return this.connection.call('unreadCount', { forAgentId, sessionId });
  }

  softDelete(mailId: string, by: string): Promise<MailboxMessage | null> {
    if (this.inlineMailbox) return this.inlineMailbox.softDelete(mailId, by);
    return this.connection.call('softDelete', { mailId, by });
  }

  restore(mailId: string): Promise<MailboxMessage | null> {
    if (this.inlineMailbox) return this.inlineMailbox.restore(mailId);
    return this.connection.call('restore', { mailId });
  }

  registerAgent(input: AgentRegistrationInput): Promise<void> {
    if (this.inlineMailbox) return this.inlineMailbox.registerAgent(input);
    return this.connection.call('registerAgent', { input });
  }

  deregisterAgent(agentId: string): Promise<void> {
    if (this.inlineMailbox) return this.inlineMailbox.deregisterAgent(agentId);
    return this.connection.call('deregisterAgent', { agentId });
  }

  heartbeat(input: AgentHeartbeatInput): Promise<void> {
    if (this.inlineMailbox) return this.inlineMailbox.heartbeat(input);
    return this.connection.call('heartbeat', { input });
  }

  getAgentStatuses(): Promise<MailboxAgentStatus[]> {
    if (this.inlineMailbox) return this.inlineMailbox.getAgentStatuses();
    return this.connection.call('getAgentStatuses', {});
  }

  getOnlineAgents(): Promise<MailboxAgentStatus[]> {
    if (this.inlineMailbox) return this.inlineMailbox.getOnlineAgents();
    return this.connection.call('getOnlineAgents', {});
  }

  purgeAgents(maxAgeMs?: number): Promise<number> {
    if (this.inlineMailbox) return this.inlineMailbox.purgeAgents(maxAgeMs);
    return this.connection.call('purgeAgents', { maxAgeMs });
  }

  registerClient(input: ClientRegistrationInput): Promise<void> {
    if (this.inlineMailbox) return this.inlineMailbox.registerClient(input);
    return this.connection.call('registerClient', { input });
  }

  deregisterClient(clientId: string): Promise<void> {
    if (this.inlineMailbox) return this.inlineMailbox.deregisterClient(clientId);
    return this.connection.call('deregisterClient', { clientId });
  }

  clientHeartbeat(input: ClientHeartbeatInput): Promise<void> {
    if (this.inlineMailbox) return this.inlineMailbox.clientHeartbeat(input);
    return this.connection.call('clientHeartbeat', { input });
  }

  getClientStatuses(): Promise<ClientStatus[]> {
    if (this.inlineMailbox) return this.inlineMailbox.getClientStatuses();
    return this.connection.call('getClientStatuses', {});
  }

  purgeClients(): Promise<number> {
    if (this.inlineMailbox) return this.inlineMailbox.purgeClients();
    return this.connection.call('purgeClients', {});
  }

  clearAll(): Promise<void> {
    if (this.inlineMailbox) return this.inlineMailbox.clearAll();
    return this.connection.call('clearAll', {});
  }

  purgeStale(options?: PurgeOptions): Promise<PurgeResult> {
    if (this.inlineMailbox) return this.inlineMailbox.purgeStale(options);
    return this.connection.call('purgeStale', { options });
  }

  autoCompact(options?: AutoCompactOptions): Promise<AutoCompactResult> {
    if (this.inlineMailbox) return this.inlineMailbox.autoCompact(options);
    return this.connection.call('autoCompact', { options }, { timeoutMs: 2 * 60_000 });
  }

  credentialIssue(
    options: IssueCredentialOptions,
  ): Promise<{ credential: MailboxCredential; secret: string }> {
    if (this.inlineMailbox) return Promise.reject(new Error('SQLite credential owner is unavailable'));
    return this.connection.call('credentialIssue', { options });
  }

  credentialVerify(credentialId: string, secret: string): Promise<CredentialValidation> {
    if (this.inlineMailbox) return Promise.reject(new Error('SQLite credential owner is unavailable'));
    return this.connection.call('credentialVerify', { credentialId, secret });
  }

  credentialRevoke(credentialId: string, reason?: string, by?: string): Promise<boolean> {
    if (this.inlineMailbox) return Promise.reject(new Error('SQLite credential owner is unavailable'));
    return this.connection.call('credentialRevoke', { credentialId, reason, by });
  }

  credentialRotate(
    credentialId: string,
    options?: Partial<IssueCredentialOptions>,
  ): Promise<{ credential: MailboxCredential; secret: string } | null> {
    if (this.inlineMailbox) return Promise.reject(new Error('SQLite credential owner is unavailable'));
    return this.connection.call('credentialRotate', { credentialId, options });
  }

  credentialGet(credentialId: string): Promise<MailboxCredential | null> {
    if (this.inlineMailbox) return Promise.reject(new Error('SQLite credential owner is unavailable'));
    return this.connection.call('credentialGet', { credentialId });
  }

  credentialList(): Promise<MailboxCredential[]> {
    if (this.inlineMailbox) return Promise.reject(new Error('SQLite credential owner is unavailable'));
    return this.connection.call('credentialList', {});
  }

  credentialStatusCounts(): Promise<Record<string, number>> {
    if (this.inlineMailbox) return Promise.reject(new Error('SQLite credential owner is unavailable'));
    return this.connection.call('credentialStatusCounts', {});
  }

  startAutoCompactTimer(_options?: AutoCompactOptions): () => void {
    // The detached owner runs exactly one timer for the project.
    return () => {};
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.cacheEviction?.();
    this.cacheEviction = undefined;
    this.unsubscribeEvent();
    this.unsubscribeMailboxEvent();
    if (this.inlineMailbox) {
      await this.inlineMailbox.close();
      return;
    }
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

  private get hqPublisher(): HqPublisher | undefined {
    return typeof this.hqPublisherRef === 'function' ? this.hqPublisherRef() : this.hqPublisherRef;
  }

  private publishHqEvent(event: MailboxEvent): void {
    const publisher = this.hqPublisher;
    if (!publisher) return;
    const mailboxId = `${path.basename(this.projectDir)}:mailbox`;
    void this.query({ includeDeleted: true, limit: 100 })
      .then((messages) => {
        const message = messages.find((candidate) => candidate.id === event.messageId);
        const action = event.type === 'message.sent' ? 'message.sent' : 'message.updated';
        publisher.publishMailboxEvent({
          mailboxId,
          action,
          ...(message ? { message } : {}),
          timestamp: event.timestamp,
        });
        return publisher.publishMailboxSnapshot(this, { mailboxId });
      })
      .catch(() => {
        // HQ telemetry remains best-effort.
      });
  }

  private publishHqRegistryEvent(event: string, payload: unknown): void {
    const publisher = this.hqPublisher;
    if (
      !publisher ||
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
    void this.getAgentStatuses()
      .then((statuses) => {
        const agent = agentId
          ? statuses.find((candidate) => candidate.agentId === agentId)
          : undefined;
        if (action) {
          publisher.publishMailboxEvent({
            mailboxId,
            action,
            ...(agent ? { agent } : {}),
            ...(agentId ? { summary: agentId } : {}),
          });
        }
        return publisher.publishMailboxSnapshot(this, { mailboxId });
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
