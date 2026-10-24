import { randomUUID } from 'node:crypto';
import type { Logger } from '@wrongstack/contracts/types/logger';
import type {
  Mailbox,
  MailboxAgentStatus,
  MailboxMessage,
} from '@wrongstack/contracts/types/mailbox';
import {
  createMailboxEventPayload,
  createMailboxSnapshotPayloadFromMailbox,
  type HqMailboxEventAction,
  type HqMailboxSnapshotOptions,
} from './mailbox-mapper.js';
import {
  createHqEventEnvelope,
  HQ_PROTOCOL_VERSION,
  HQ_TRANSCRIPT_TEXT_CAP,
  type HqClientCapability,
  type HqClientCommandAckMessage,
  type HqClientCommandPollMessage,
  type HqClientEventMessage,
  type HqClientHelloMessage,
  type HqClientIdentity,
  type HqEventEnvelope,
  type HqFleetSnapshotPayload,
  type HqMailboxEventPayload,
  type HqMailboxSnapshotPayload,
  type HqProjectIdentity,
  type HqRedactionPolicy,
  type HqServerCommandBatchMessage,
  type HqSessionEndedPayload,
  type HqSessionSnapshotPayload,
  type HqTranscriptAppendPayload,
} from './protocol.js';
import { CommandTracker, runCommandBatch } from './publisher-command-tracker.js';
import {
  DEFAULT_COMMAND_POLL_INTERVAL_MS,
  DEFAULT_COMMAND_POLL_LIMIT,
  DEFAULT_DISCOVERY_POLL_MS,
  DEFAULT_HEARTBEAT_INTERVAL_MS,
  DEFAULT_MAX_QUEUED_BYTES,
  DEFAULT_MAX_QUEUED_MESSAGES,
  DEFAULT_RECONNECT_BASE_MS,
  DEFAULT_RECONNECT_MAX_MS,
  MAX_TRACKED_COMMANDS,
  TRANSCRIPT_EVENT_TYPES,
} from './publisher-defaults.js';
import { MailboxSnapshotMemory } from './publisher-mailbox-memory.js';
import { PublisherQueue, queuedFrameCoalesceKey } from './publisher-queue.js';
import { parseHqServerMessage } from './publisher-server-message.js';
import {
  addSocketListener,
  defaultSocketFactory,
  OPEN_STATE,
  removeSocketListener,
  toClientUrl,
} from './publisher-socket.js';
import type {
  HqPublishEventOptions,
  HqPublisherCommandHandler,
  HqPublisherCommandResult,
  HqPublisherOptions,
  HqSocketFactory,
  HqSocketLike,
} from './publisher-types.js';
import {
  CONNECT_WARN_AFTER_FAILURES,
  DEFAULT_CONNECT_WARN_COOLDOWN_MS,
  emitConnectWarning,
  resetHqPublisherWarningStateForTests,
  warnedEndpoints,
  warnIfShippingRawContentInClear,
} from './publisher-warnings.js';
import { redactHqEvent, resolveHqRedactionPolicy } from './redaction.js';

export {
  type HqPublishEventOptions,
  type HqPublisherCommandHandler,
  type HqPublisherCommandResult,
  type HqPublisherOptions,
  type HqSocketFactory,
  type HqSocketLike,
  resetHqPublisherWarningStateForTests,
};

export class HqPublisher {
  private readonly socketFactory: HqSocketFactory;
  private readonly now: () => string;
  private readonly idFactory: () => string;
  private readonly capabilities: readonly HqClientCapability[];
  private readonly reconnect: boolean;
  private readonly reconnectBaseMs: number;
  private readonly reconnectMaxMs: number;
  private readonly connectWarnAfterFailures: number;
  private readonly connectWarnCooldownMs: number;
  private readonly maxQueuedMessages: number;
  private readonly resolvedRedactionPolicy: HqRedactionPolicy;
  private readonly logger: Logger | undefined;
  private socket: HqSocketLike | null = null;
  private seq = 0;
  private readonly outboundQueue: PublisherQueue;
  private stopped = false;
  private reconnectAttempt = 0;
  private connectWarningEmitted = false;
  private lastAttempt: { url: string; hadToken: boolean } | null = null;
  /** Removes the live socket's listeners. Held so a re-dial can detach the
   * outgoing socket BEFORE replacing it: a stale `close` handler would
   * otherwise stop the NEW connection's heartbeat and command polling. */
  private detachSocket: (() => void) | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private commandPollTimer: ReturnType<typeof setInterval> | null = null;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  /** Listeners re-seeding per-connection server state on every (re)open. */
  private readonly connectedListeners = new Set<() => void>();
  /** Mailbox state HQ keeps per socket; re-announced on every open. */
  private readonly mailboxSnapshots = new MailboxSnapshotMemory();
  private lastCommandId: string | undefined;
  private readonly commandTracker = new CommandTracker(MAX_TRACKED_COMMANDS);

  constructor(private readonly options: HqPublisherOptions) {
    this.socketFactory = options.socketFactory ?? defaultSocketFactory;
    this.now = options.now ?? (() => new Date().toISOString());
    this.idFactory = options.idFactory ?? randomUUID;
    this.capabilities = options.capabilities ?? [
      'telemetry.publish',
      'mailbox.summary',
      'fleet.summary',
      'session.summary',
    ];
    this.reconnect = options.reconnect ?? true;
    this.reconnectBaseMs = options.reconnectBaseMs ?? DEFAULT_RECONNECT_BASE_MS;
    this.reconnectMaxMs = options.reconnectMaxMs ?? DEFAULT_RECONNECT_MAX_MS;
    this.connectWarnAfterFailures = options.connectWarnAfterFailures ?? CONNECT_WARN_AFTER_FAILURES;
    this.connectWarnCooldownMs = options.connectWarnCooldownMs ?? DEFAULT_CONNECT_WARN_COOLDOWN_MS;
    this.maxQueuedMessages = options.maxQueuedMessages ?? DEFAULT_MAX_QUEUED_MESSAGES;
    const maxQueuedBytes = options.maxQueuedBytes ?? DEFAULT_MAX_QUEUED_BYTES;
    this.outboundQueue = new PublisherQueue(this.maxQueuedMessages, maxQueuedBytes);
    this.resolvedRedactionPolicy = resolveHqRedactionPolicy(options.redactionPolicy);
    this.logger = options.logger;
  }

  connect(): void {
    if (this.socket !== null || this.stopped) return;
    // A retry / discovery poll is already scheduled — let it fire instead of
    // dialing (and re-resolving the endpoint) on every publish while offline.
    if (this.reconnectTimer !== null) return;

    let url = this.options.url;
    let token = this.options.token;
    if (this.options.resolveEndpoint !== undefined) {
      const endpoint = this.options.resolveEndpoint();
      if (endpoint === undefined) {
        this.scheduleDiscoveryPoll();
        return;
      }
      url = endpoint.url;
      token = endpoint.token ?? token;
    }
    this.lastAttempt = { url, hadToken: token !== undefined };

    let socket: HqSocketLike;
    try {
      socket = this.socketFactory(toClientUrl(url, token), {
        ...(token !== undefined ? { token } : {}),
      });
    } catch {
      this.scheduleReconnect();
      return;
    }
    this.socket = socket;

    const onOpen = () => {
      this.reconnectAttempt = 0;
      this.connectWarningEmitted = false;
      warnIfShippingRawContentInClear(url, this.resolvedRedactionPolicy, this.logger);
      if (this.lastAttempt?.url) {
        warnedEndpoints.delete(this.lastAttempt.url);
      }
      if (this.options.url) {
        warnedEndpoints.delete(this.options.url);
      }
      this.sendHelloNow();
      this.flushQueue();
      // AFTER hello and the queue drain, so re-seeded state lands on a
      // registered client and behind anything that was already waiting.
      this.mailboxSnapshots.replay((payload, sessionId) =>
        this.publishEvent({
          type: 'mailbox.snapshot',
          payload,
          ...(sessionId ? { sessionId } : {}),
        }),
      );
      this.notifyConnected();
      this.startHeartbeat();
      if (this.options.onCommand !== undefined) {
        this.startCommandPolling();
        this.pollCommands();
      }
    };
    const onMessage = (event: unknown) => {
      // HQ traffic is best-effort telemetry: a failed message (e.g. transient
      // Windows EPERM while a kanban board is being renamed under a reader)
      // must degrade to a warning, never an unhandled rejection that kills
      // the host process.
      this.handleServerMessage(event).catch((error: unknown) => {
        const message = `WrongStack HQ publisher: server message handling failed: ${
          error instanceof Error ? error.message : String(error)
        }`;
        if (this.logger) {
          this.logger.warn(message, { event: 'hq.publisher.message_failed' });
          return;
        }
        process.emitWarning(message, { code: 'WRONGSTACK_HQ_MESSAGE_FAILED' });
      });
    };
    const onCloseOrError = () => {
      removeSocketListener(socket, 'open', onOpen);
      removeSocketListener(socket, 'message', onMessage);
      removeSocketListener(socket, 'close', onCloseOrError);
      removeSocketListener(socket, 'error', onCloseOrError);
      this.stopCommandPolling();
      this.stopHeartbeat();
      if (this.socket === socket) {
        this.socket = null;
        this.detachSocket = null;
      }
      this.scheduleReconnect();
    };

    addSocketListener(socket, 'open', onOpen);
    addSocketListener(socket, 'message', onMessage);
    addSocketListener(socket, 'close', onCloseOrError);
    addSocketListener(socket, 'error', onCloseOrError);
    this.detachSocket = () => {
      removeSocketListener(socket, 'open', onOpen);
      removeSocketListener(socket, 'message', onMessage);
      removeSocketListener(socket, 'close', onCloseOrError);
      removeSocketListener(socket, 'error', onCloseOrError);
    };

    if (socket.readyState === OPEN_STATE) onOpen();
  }

  close(): void {
    this.stopped = true;
    if (this.reconnectTimer !== null) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.stopCommandPolling();
    this.stopHeartbeat();
    this.outboundQueue.clear();
    const socket = this.socket;
    this.socket = null;
    this.detachSocket = null;
    socket?.close(1000, 'hq publisher closed');
  }

  /**
   * Re-resolve the discovery endpoint and move to it if it changed.
   *
   * `resolveEndpoint` is consulted on every CONNECT, which covers the normal
   * case (HQ dies, the socket closes, the retry re-reads the marker). It does
   * not cover a marker that repoints while this socket is still open — a
   * second HQ taking over the runtime file, or a restart whose close we have
   * not observed yet. The host polls for that; doing the move HERE keeps the
   * publisher's identity (`clientId`) and its bounded outbound queue, which
   * rebuilding the publisher would discard — and a new clientId makes one
   * process show up in HQ as a fresh client plus a ghost of the old one.
   *
   * No-op without discovery, while stopped, or when the endpoint is unchanged.
   */
  refreshEndpoint(): void {
    if (this.stopped || this.options.resolveEndpoint === undefined) return;
    const endpoint = this.options.resolveEndpoint();
    if (endpoint === undefined) return;
    if (this.socket === null) {
      // Dormant: `connect()` re-resolves on its own (and is a no-op while a
      // retry/discovery poll is already scheduled).
      this.connect();
      return;
    }
    if (this.lastAttempt !== null && this.lastAttempt.url === endpoint.url) return;
    // Detach BEFORE closing so the outgoing socket's close handler cannot stop
    // the replacement's timers or schedule a competing reconnect.
    this.detachSocket?.();
    this.detachSocket = null;
    this.stopCommandPolling();
    this.stopHeartbeat();
    const previous = this.socket;
    this.socket = null;
    try {
      previous.close(1000, 'hq endpoint moved');
    } catch {
      // Already gone — the re-dial below is what matters.
    }
    this.connect();
  }

  /**
   * Subscribe to every socket (re)open, including the first.
   *
   * HQ keeps a client's session / fleet / mailbox / MCP state on the SOCKET:
   * a reconnect registers a fresh `ConnectedClient` with those maps empty. The
   * publisher's own reconnect is invisible to the bridges above it — they only
   * publish on change — so after a blip a live terminal simply stopped existing
   * in HQ's snapshot (and vanished from the fleet map) until something changed
   * or the 4-minute keep-alive fired. Bridges that own durable state subscribe
   * here and re-announce it.
   *
   * Returns an unsubscribe handle.
   */
  onConnected(listener: () => void): () => void {
    this.connectedListeners.add(listener);
    return () => {
      this.connectedListeners.delete(listener);
    };
  }

  private notifyConnected(): void {
    for (const listener of this.connectedListeners) {
      try {
        listener();
      } catch {
        // Re-seeding is best-effort: one bridge throwing must not stop the
        // others, nor the connection itself.
      }
    }
  }

  publishEvent<TPayload>(
    options: HqPublishEventOptions & { payload: TPayload },
  ): HqEventEnvelope<TPayload> {
    const event = createHqEventEnvelope({
      id: this.idFactory(),
      type: options.type,
      timestamp: options.timestamp ?? this.now(),
      clientId: this.options.client.clientId,
      projectId: this.options.project.projectId,
      seq: ++this.seq,
      payload: options.payload,
      ...(options.sessionId !== undefined ? { sessionId: options.sessionId } : {}),
      ...(options.runId !== undefined ? { runId: options.runId } : {}),
      // Normalised here, at the single choke point every bridge publishes
      // through, rather than in each bridge: an empty string on the wire reads
      // as a real id that matches nothing, so two unrelated activities would
      // look like one broken chain instead of two uncorrelated ones.
      ...(options.correlationId !== undefined && options.correlationId.length > 0
        ? { correlationId: options.correlationId }
        : {}),
    });
    const maxSummaryLength =
      options.maxSummaryLength ??
      (TRANSCRIPT_EVENT_TYPES.has(options.type) ? HQ_TRANSCRIPT_TEXT_CAP : undefined);
    const redacted = redactHqEvent(event, {
      policy: this.resolvedRedactionPolicy,
      projectRoot: this.options.project.projectRoot,
      ...(maxSummaryLength !== undefined ? { maxSummaryLength } : {}),
    }).value;
    this.sendFrame({ type: 'client.event', event: redacted });
    return redacted;
  }

  async publishMailboxSnapshot(
    mailbox: Pick<Mailbox, 'query' | 'getAgentStatuses'>,
    options: Omit<HqMailboxSnapshotOptions, 'redactionPolicy'> & {
      sessionId?: string;
      timestamp?: string;
    },
  ): Promise<HqEventEnvelope<HqMailboxSnapshotPayload>> {
    const payload = await createMailboxSnapshotPayloadFromMailbox(mailbox, {
      ...options,
      redactionPolicy: this.resolvedRedactionPolicy,
    });
    this.mailboxSnapshots.remember(payload, options.sessionId);
    return this.publishEvent({
      type: 'mailbox.snapshot',
      payload,
      ...(options.sessionId !== undefined ? { sessionId: options.sessionId } : {}),
      ...(options.timestamp !== undefined ? { timestamp: options.timestamp } : {}),
    });
  }

  publishMailboxEvent(input: {
    mailboxId: string;
    action: HqMailboxEventAction;
    message?: MailboxMessage;
    agent?: MailboxAgentStatus;
    summary?: string;
    previewLength?: number;
    sessionId?: string;
    timestamp?: string;
  }): HqEventEnvelope<HqMailboxEventPayload> {
    const payload = createMailboxEventPayload({
      mailboxId: input.mailboxId,
      action: input.action,
      ...(input.message !== undefined ? { message: input.message } : {}),
      ...(input.agent !== undefined ? { agent: input.agent } : {}),
      ...(input.summary !== undefined ? { summary: input.summary } : {}),
      ...(input.previewLength !== undefined ? { previewLength: input.previewLength } : {}),
      redactionPolicy: this.resolvedRedactionPolicy,
    });
    return this.publishEvent({
      type: 'mailbox.event',
      payload,
      ...(input.sessionId !== undefined ? { sessionId: input.sessionId } : {}),
      ...(input.timestamp !== undefined ? { timestamp: input.timestamp } : {}),
    });
  }

  /** The client identity this publisher announced (clientId, kind, machineId, …). */
  get identity(): HqClientIdentity {
    return this.options.client;
  }

  /** The project identity this publisher is bound to. */
  get project(): HqProjectIdentity {
    return this.options.project;
  }

  /** Effective publisher-side policy applied before any event leaves this process. */
  get redactionPolicy(): HqRedactionPolicy {
    return this.resolvedRedactionPolicy;
  }

  /** Whether the socket to HQ is open right now (false while dormant or re-dialling). */
  get connected(): boolean {
    return this.socket?.readyState === OPEN_STATE;
  }

  /** Current outbound queue pressure — useful for flow control in telemetry bridges. */
  getQueueStats() {
    return this.outboundQueue.getStats();
  }

  /** Publish a live session/terminal snapshot (state + agents). */
  publishSessionSnapshot(
    payload: HqSessionSnapshotPayload,
    opts?: { timestamp?: string },
  ): HqEventEnvelope<HqSessionSnapshotPayload> {
    return this.publishEvent({
      type: 'session.snapshot',
      payload,
      sessionId: payload.sessionId,
      ...(opts?.timestamp !== undefined ? { timestamp: opts.timestamp } : {}),
    });
  }

  /** Publish an incremental batch of transcript turns for a session. */
  publishTranscriptAppend(
    payload: HqTranscriptAppendPayload,
    opts?: { timestamp?: string },
  ): HqEventEnvelope<HqTranscriptAppendPayload> {
    return this.publishEvent({
      type: 'session.transcript',
      payload,
      sessionId: payload.sessionId,
      ...(opts?.timestamp !== undefined ? { timestamp: opts.timestamp } : {}),
    });
  }

  /** Mark a session/terminal as ended. */
  publishSessionEnded(
    payload: HqSessionEndedPayload,
    opts?: { timestamp?: string },
  ): HqEventEnvelope<HqSessionEndedPayload> {
    return this.publishEvent({
      type: 'session.ended',
      payload,
      sessionId: payload.sessionId,
      ...(opts?.timestamp !== undefined ? { timestamp: opts.timestamp } : {}),
    });
  }

  /** Publish a fleet (multi-agent coordinator) snapshot. */
  /** Publish a fleet (multi-agent coordinator) snapshot. */
  publishFleetSnapshot(
    payload: HqFleetSnapshotPayload,
    opts?: { sessionId?: string; timestamp?: string; correlationId?: string },
  ): HqEventEnvelope<HqFleetSnapshotPayload> {
    return this.publishEvent({
      type: 'fleet.snapshot',
      payload,
      runId: payload.runId,
      ...(opts?.sessionId !== undefined ? { sessionId: opts.sessionId } : {}),
      ...(opts?.correlationId !== undefined ? { correlationId: opts.correlationId } : {}),
      ...(opts?.timestamp !== undefined ? { timestamp: opts.timestamp } : {}),
    });
  }

  pollCommands(): void {
    this.sendFrame({
      type: 'client.command_poll',
      clientId: this.options.client.clientId,
      projectId: this.options.project.projectId,
      ...(this.lastCommandId !== undefined ? { afterCommandId: this.lastCommandId } : {}),
      limit: this.options.commandPollLimit ?? DEFAULT_COMMAND_POLL_LIMIT,
    });
  }

  ackCommand(result: HqPublisherCommandResult): void {
    this.sendFrame({
      type: 'client.command_ack',
      clientId: this.options.client.clientId,
      projectId: this.options.project.projectId,
      commandId: result.commandId,
      status: result.status,
      ...(result.message !== undefined ? { message: result.message } : {}),
    });
  }

  private createHelloFrame(): HqClientHelloMessage {
    return {
      type: 'client.hello',
      payload: {
        protocolVersion: HQ_PROTOCOL_VERSION,
        client: this.options.client,
        project: this.options.project,
        capabilities: this.capabilities,
        redactionPolicy: this.resolvedRedactionPolicy,
      },
    };
  }

  private sendHelloNow(): void {
    const socket = this.socket;
    if (socket?.readyState !== OPEN_STATE) {
      this.sendFrame(this.createHelloFrame());
      return;
    }
    socket.send(JSON.stringify(this.createHelloFrame()));
  }

  private sendFrame(
    frame:
      | HqClientHelloMessage
      | HqClientEventMessage
      | HqClientCommandPollMessage
      | HqClientCommandAckMessage,
  ): void {
    const serialized = JSON.stringify(frame);
    const socket = this.socket;
    // Fast path: socket is open and nothing queued — send immediately.
    if (socket?.readyState === OPEN_STATE && this.outboundQueue.length === 0) {
      socket.send(serialized);
      return;
    }
    // Slow path: socket offline or queue already has pending frames — enqueue.
    this.outboundQueue.enqueue(serialized, queuedFrameCoalesceKey(frame));
    this.connect();
  }

  /** Batch-dequeue up to 50 frames at a time, yielding to the microtask
   *  queue between batches so we don't starve the event loop on reconnect. */
  private flushQueue(): void {
    const socket = this.socket;
    if (socket?.readyState !== OPEN_STATE || this.outboundQueue.length === 0) return;
    const batch = this.outboundQueue.spliceBatch(50);
    for (const frame of batch) {
      socket.send(frame.serialized);
    }
    if (this.outboundQueue.length > 0) setImmediate(() => this.flushQueue());
  }

  private startCommandPolling(): void {
    if (this.options.onCommand === undefined || this.commandPollTimer !== null) return;
    this.commandPollTimer = setInterval(
      () => this.pollCommands(),
      this.options.commandPollIntervalMs ?? DEFAULT_COMMAND_POLL_INTERVAL_MS,
    );
    this.commandPollTimer.unref?.();
  }

  private stopCommandPolling(): void {
    if (this.commandPollTimer === null) return;
    clearInterval(this.commandPollTimer);
    this.commandPollTimer = null;
  }

  private startHeartbeat(): void {
    if (this.heartbeatTimer !== null) return;
    this.heartbeatTimer = setInterval(
      () => this.publishHeartbeat(),
      this.options.heartbeatIntervalMs ?? DEFAULT_HEARTBEAT_INTERVAL_MS,
    );
    this.heartbeatTimer.unref?.();
  }

  private stopHeartbeat(): void {
    if (this.heartbeatTimer === null) return;
    clearInterval(this.heartbeatTimer);
    this.heartbeatTimer = null;
  }

  private publishHeartbeat(): void {
    const startedAt = Date.parse(this.options.client.startedAt);
    const now = Date.parse(this.now());
    this.publishEvent({
      type: 'client.heartbeat',
      payload: {
        uptimeMs:
          Number.isFinite(startedAt) && Number.isFinite(now) ? Math.max(0, now - startedAt) : 0,
        status: 'idle',
      },
    });
  }

  private async handleServerMessage(event: unknown): Promise<void> {
    const message = this.parseServerMessage(event);
    if (message?.type === 'hq.command_batch') {
      await this.handleCommandBatch(message);
      return;
    }
    if (message?.type === 'hq.kanban_snapshot') {
      await this.options.onKanbanSnapshot?.(message.payload);
    }
    if (message?.type === 'hq.sage_snapshot') {
      await this.options.onSageSnapshot?.(message.payload);
    }
  }

  private parseServerMessage(event: unknown): ReturnType<typeof parseHqServerMessage> {
    return parseHqServerMessage(event, this.options.project.projectId);
  }

  private async handleCommandBatch(message: HqServerCommandBatchMessage): Promise<void> {
    const handler = this.options.onCommand;
    if (handler === undefined) return;
    await runCommandBatch(message, handler, this.commandTracker, {
      ack: (result) => this.ackCommand(result),
      advanceCursor: (commandId) => {
        this.lastCommandId = commandId;
      },
    });
  }

  private scheduleReconnect(): void {
    if (this.stopped || !this.reconnect || this.reconnectTimer !== null) return;
    const delay = Math.min(this.reconnectMaxMs, this.reconnectBaseMs * 2 ** this.reconnectAttempt);
    this.reconnectAttempt += 1;
    // One-time visibility for persistent failures. `reconnectAttempt` resets
    // on every successful open, so reaching the threshold means the endpoint
    // has NEVER accepted us in this streak — dead server or rejected token.
    if (!this.connectWarningEmitted && this.reconnectAttempt >= this.connectWarnAfterFailures) {
      this.connectWarningEmitted = true;
      this.emitConnectWarning();
    }
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, delay);
    this.reconnectTimer.unref?.();
  }

  private emitConnectWarning(): boolean {
    return emitConnectWarning({
      targetUrl: this.lastAttempt?.url ?? this.options.url,
      reconnectAttempt: this.reconnectAttempt,
      lastAttempt: this.lastAttempt,
      connectWarnCooldownMs: this.connectWarnCooldownMs,
      now: this.now,
      logger: this.logger,
      warn: this.options.warn,
    });
  }

  /**
   * Dormant re-check while no HQ endpoint is discoverable. Uses a FIXED
   * interval (not the exponential reconnect backoff): the check is a cheap
   * local file read, and backing off would delay attaching to an HQ the
   * user just started — the whole point of auto-discovery.
   */
  private scheduleDiscoveryPoll(): void {
    if (this.stopped || !this.reconnect || this.reconnectTimer !== null) return;
    this.reconnectAttempt = 0;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, this.options.discoveryPollMs ?? DEFAULT_DISCOVERY_POLL_MS);
    this.reconnectTimer.unref?.();
  }
}
