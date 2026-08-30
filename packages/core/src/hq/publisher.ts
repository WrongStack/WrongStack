import { randomUUID } from 'node:crypto';
import * as v8 from 'node:v8';
import type { Mailbox, MailboxAgentStatus, MailboxMessage } from '../coordination/mailbox-types.js';
import type { Logger } from '../types/logger.js';
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
  type HqEventType,
  type HqFleetSnapshotPayload,
  type HqKanbanSnapshotPayload,
  type HqMailboxEventPayload,
  type HqMailboxSnapshotPayload,
  type HqProjectIdentity,
  type HqQueuedCommand,
  type HqRedactionPolicy,
  type HqServerCommandBatchMessage,
  type HqServerKanbanSnapshotMessage,
  type HqSessionEndedPayload,
  type HqSessionSnapshotPayload,
  type HqTranscriptAppendPayload,
} from './protocol.js';
import { redactHqEvent, resolveHqRedactionPolicy } from './redaction.js';

export interface HqSocketLike {
  readyState: number;
  send(data: string): void;
  close(code?: number, reason?: string): void;
  addEventListener?(
    type: 'open' | 'close' | 'error' | 'message',
    listener: (event: unknown) => void,
  ): void;
  removeEventListener?(
    type: 'open' | 'close' | 'error' | 'message',
    listener: (event: unknown) => void,
  ): void;
  on?(type: 'open' | 'close' | 'error' | 'message', listener: (event: unknown) => void): void;
  off?(type: 'open' | 'close' | 'error' | 'message', listener: (event: unknown) => void): void;
}

export type HqSocketFactory = (url: string, init: { token?: string }) => HqSocketLike;

export interface HqPublisherCommandResult {
  commandId: string;
  status: 'accepted' | 'completed' | 'failed' | 'rejected';
  message?: string;
}

export type HqPublisherCommandHandler = (
  command: HqQueuedCommand,
) => void | HqPublisherCommandResult | Promise<void | HqPublisherCommandResult>;

export interface HqPublisherOptions {
  url: string;
  token?: string;
  client: HqClientIdentity;
  project: HqProjectIdentity;
  capabilities?: readonly HqClientCapability[];
  socketFactory?: HqSocketFactory;
  now?: () => string;
  idFactory?: () => string;
  reconnect?: boolean;
  reconnectBaseMs?: number;
  reconnectMaxMs?: number;
  /**
   * Consecutive connect failures (never reaching `open`) before the one-time
   * diagnostic warning fires. Defaults to `CONNECT_WARN_AFTER_FAILURES` (5).
   */
  connectWarnAfterFailures?: number;
  /**
   * Minimum gap between connect-failure warnings ACROSS all HqPublisher
   * instances in this process. When a fleet of agents fails against the same
   * dead/rejecting HQ at once, only the first instance to cross the threshold
   * warns; the rest stay silent until the window elapses (each instance still
   * warns at most once). Defaults to 5 minutes. Set to 0 to disable the
   * process-wide gate entirely.
   */
  connectWarnCooldownMs?: number;
  maxQueuedMessages?: number;
  /** Hard byte cap on the outbound queue (prevents RAM blow-up when HQ is
   * offline). Older frames are dropped oldest-first when exceeded. The default
   * is heap-relative: `min(16 MiB, heap_limit * 0.10)` — see `DEFAULT_MAX_QUEUED_BYTES`. */
  maxQueuedBytes?: number;
  redactionPolicy?: Partial<HqRedactionPolicy>;
  commandPollIntervalMs?: number;
  commandPollLimit?: number;
  onCommand?: HqPublisherCommandHandler;
  /** Called whenever HQ sends the merged Kanban state for this project. */
  onKanbanSnapshot?: (snapshot: HqKanbanSnapshotPayload) => void | Promise<void>;
  /**
   * Local auto-discovery hook: re-resolve the HQ endpoint before EVERY
   * connect attempt (e.g. by reading `<hq dataDir>/runtime.json`). Returning
   * `undefined` means no HQ is currently discoverable — the publisher stays
   * dormant (events keep queueing, bounded) and re-checks every
   * {@link HqPublisherOptions.discoveryPollMs}. Because the endpoint is
   * re-resolved per attempt, an HQ started AFTER this client — or restarted
   * on a different port, or one that minted its first client token on boot —
   * is picked up automatically.
   */
  resolveEndpoint?: () => { url: string; token?: string | undefined } | undefined;
  /** Dormant re-check interval while `resolveEndpoint` yields nothing. Default 5s. */
  discoveryPollMs?: number;
  /**
   * Application-level heartbeat interval for the `/ws/client` connection.
   * The HQ server evicts silent sockets, so this must be comfortably below
   * the server-side client TTL even when no command handler is installed.
   */
  heartbeatIntervalMs?: number;
  /**
   * Diagnostic sink for the consecutive-connect-failure warning. The
   * publisher is otherwise deliberately silent (dormant queueing), which
   * made auth failures invisible: a token the server rejects — e.g. a wrong
   * `WRONGSTACK_HQ_TOKEN` against a remote HQ — looked exactly like "HQ not
   * running". Emission is one-shot per instance and rate-limited process-wide
   * via {@link HqPublisherOptions.connectWarnCooldownMs}. Defaults to a
   * single structured `console.warn` line.
   */
  warn?: (message: string) => void;
  /** Logger for structured events. When provided, the `warn` callback is derived from it. */
  logger?: Logger | undefined;
}

export interface HqPublishEventOptions {
  type: HqEventType | (string & {});
  payload: unknown;
  sessionId?: string;
  runId?: string;
  timestamp?: string;
  /**
   * Per-string redaction cap override. Defaults to the generic 500-char
   * summary cap; chat-transcript event types (`session.transcript`,
   * `agent.message`) automatically get {@link HQ_TRANSCRIPT_TEXT_CAP} so
   * full chat history survives when `rawContent` is enabled.
   */
  maxSummaryLength?: number;
}

/** Event types that carry full chat turns rather than telemetry summaries. */
const TRANSCRIPT_EVENT_TYPES = new Set<string>(['session.transcript', 'agent.message']);

const OPEN_STATE = 1;
/**
 * After this many consecutive failed connects (never reaching `open`), emit
 * ONE diagnostic warning. The WS handshake gives the browser-style socket no
 * HTTP status, so a 401 (token mismatch) is indistinguishable from a dead
 * server at this layer — the warning names both possibilities.
 */
const CONNECT_WARN_AFTER_FAILURES = 5;
/**
 * Process-wide minimum gap between connect-failure warnings. Suppresses the
 * burst of identical warnings when many publisher instances (one per agent)
 * fail against the same dead/rejecting HQ at once.
 */
const DEFAULT_CONNECT_WARN_COOLDOWN_MS = 5 * 60_000;
const DEFAULT_RECONNECT_BASE_MS = 1_000;
const DEFAULT_RECONNECT_MAX_MS = 30_000;
const DEFAULT_DISCOVERY_POLL_MS = 5_000;
const DEFAULT_MAX_QUEUED_MESSAGES = 2000;
/**
 * Hard byte cap on the enqueue to prevent unbounded RAM growth when HQ is offline.
 *
 * Heap-relative: `min(16 MiB, heap_limit * 0.10)`. The lower bound keeps the cap
 * small in typical V8 configurations (e.g. ~512 MiB limit → 16 MiB cap), while
 * the upper bound prevents the cap from exceeding 10 % of the V8 heap limit in
 * small-container or `--max-old-space-size` scenarios. Operators can override
 * via the `maxQueuedBytes` option — the override takes precedence over this
 * default and is the right escape hatch for long offline periods.
 */
const DEFAULT_MAX_QUEUED_BYTES = Math.min(
  16 * 1024 * 1024,
  Math.floor(v8.getHeapStatistics().heap_size_limit * 0.1),
);
// Commands originate from an interactive operator console. Keep delivery
// close to WebSocket-real-time while retaining the existing bounded poll
// protocol (which also provides replay after a brief disconnect).
const DEFAULT_COMMAND_POLL_INTERVAL_MS = 500;
const DEFAULT_COMMAND_POLL_LIMIT = 25;
const DEFAULT_HEARTBEAT_INTERVAL_MS = 25_000;

/**
 * Module-level set of endpoints (urls) for which a connect-failure warning has
 * already been emitted in THIS process. Shared across all HqPublisher instances so
 * that only one diagnostic warning is emitted across the entire process lifetime
 * while the server is unreachable, rather than repeating warnings periodically or
 * across multiple instances.
 */
const warnedEndpoints = new Set<string>();

/** Test helper to reset the module-level process warning state. */
export function resetHqPublisherWarningStateForTests(): void {
  warnedEndpoints.clear();
}

interface QueuedFrame {
  serialized: string;
  bytes: number;
  /**
   * State snapshots are rollups: while offline, only the newest snapshot for
   * a scope has value. Event/transcript frames intentionally have no key and
   * retain FIFO semantics.
   */
  coalesceKey?: string | undefined;
}

function queuedFrameCoalesceKey(
  frame:
    | HqClientHelloMessage
    | HqClientEventMessage
    | HqClientCommandPollMessage
    | HqClientCommandAckMessage,
): string | undefined {
  if (frame.type !== 'client.event' || !frame.event.type.endsWith('.snapshot')) {
    return undefined;
  }
  // Chunks of one snapshot are different content, not different versions of the
  // same content. Without this the whole multi-chunk publish collapsed onto a
  // single key while the socket was down, each chunk evicting the last, and
  // only the final chunk survived the reconnect.
  //
  // A newer snapshot with FEWER chunks still leaves the older tail chunks
  // queued. That is safe for the rollups this applies to: records carry their
  // own revision, so a stale one loses on arrival.
  const payload = frame.event.payload as { chunkIndex?: unknown } | undefined;
  const chunk =
    typeof payload?.chunkIndex === 'number' && Number.isFinite(payload.chunkIndex)
      ? String(payload.chunkIndex)
      : '';
  return [frame.event.type, frame.event.sessionId ?? '', frame.event.runId ?? '', chunk].join('|');
}

function defaultSocketFactory(url: string): HqSocketLike {
  const WebSocketCtor = globalThis.WebSocket;
  if (WebSocketCtor === undefined) {
    throw new Error(
      'No global WebSocket implementation is available; provide HqPublisherOptions.socketFactory.',
    );
  }
  return new WebSocketCtor(url) as HqSocketLike;
}

function toClientUrl(baseUrl: string, token: string | undefined): string {
  const url = new URL(baseUrl);
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
  if (url.pathname === '/' || url.pathname === '') url.pathname = '/ws/client';
  if (token !== undefined && token.length > 0) url.searchParams.set('token', token);
  return url.toString();
}

function addSocketListener(
  socket: HqSocketLike,
  type: 'open' | 'close' | 'error' | 'message',
  listener: (event: unknown) => void,
): void {
  if (socket.addEventListener !== undefined) {
    socket.addEventListener(type, listener);
    return;
  }
  socket.on?.(type, listener);
}

function removeSocketListener(
  socket: HqSocketLike,
  type: 'open' | 'close' | 'error' | 'message',
  listener: (event: unknown) => void,
): void {
  if (socket.removeEventListener !== undefined) {
    socket.removeEventListener(type, listener);
    return;
  }
  socket.off?.(type, listener);
}

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
  private readonly maxQueuedBytes: number;
  private readonly resolvedRedactionPolicy: HqRedactionPolicy;
  private readonly logger: Logger | undefined;
  private socket: HqSocketLike | null = null;
  private seq = 0;
  private queue: QueuedFrame[] = [];
  private queueBytes = 0;
  /**
   * Cumulative count of frames dropped by the bounded outbound queue when the
   * count/byte cap is exceeded while HQ is unreachable. Lifetime statistic —
   * intentionally NOT reset on close()/reconnect, so it reflects total
   * telemetry loss to overflow for this publisher instance.
   */
  private droppedFrames = 0;
  /** Cumulative UTF-8 bytes of frames dropped on overflow (see droppedFrames). */
  private droppedBytes = 0;
  /** Obsolete state snapshots replaced in-place while HQ was unreachable. */
  private coalescedFrames = 0;
  /** UTF-8 bytes released by snapshot coalescing. */
  private coalescedBytes = 0;
  private stopped = false;
  private reconnectAttempt = 0;
  private connectWarningEmitted = false;
  private lastAttempt: { url: string; hadToken: boolean } | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private commandPollTimer: ReturnType<typeof setInterval> | null = null;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private lastCommandId: string | undefined;

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
    this.maxQueuedBytes = options.maxQueuedBytes ?? DEFAULT_MAX_QUEUED_BYTES;
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
      if (this.lastAttempt?.url) {
        warnedEndpoints.delete(this.lastAttempt.url);
      }
      if (this.options.url) {
        warnedEndpoints.delete(this.options.url);
      }
      this.sendHelloNow();
      this.flushQueue();
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
      if (this.socket === socket) this.socket = null;
      this.scheduleReconnect();
    };

    addSocketListener(socket, 'open', onOpen);
    addSocketListener(socket, 'message', onMessage);
    addSocketListener(socket, 'close', onCloseOrError);
    addSocketListener(socket, 'error', onCloseOrError);

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
    this.queue = [];
    this.queueBytes = 0;
    const socket = this.socket;
    this.socket = null;
    socket?.close(1000, 'hq publisher closed');
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

  /** Current outbound queue pressure — useful for flow control in telemetry bridges. */
  getQueueStats(): {
    entries: number;
    bytes: number;
    maxBytes: number;
    droppedFrames: number;
    droppedBytes: number;
    coalescedFrames: number;
    coalescedBytes: number;
  } {
    return {
      entries: this.queue.length,
      bytes: this.queueBytes,
      maxBytes: this.maxQueuedBytes,
      droppedFrames: this.droppedFrames,
      droppedBytes: this.droppedBytes,
      coalescedFrames: this.coalescedFrames,
      coalescedBytes: this.coalescedBytes,
    };
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
  publishFleetSnapshot(
    payload: HqFleetSnapshotPayload,
    opts?: { sessionId?: string; timestamp?: string },
  ): HqEventEnvelope<HqFleetSnapshotPayload> {
    return this.publishEvent({
      type: 'fleet.snapshot',
      payload,
      runId: payload.runId,
      ...(opts?.sessionId !== undefined ? { sessionId: opts.sessionId } : {}),
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
    if (socket?.readyState === OPEN_STATE && this.queue.length === 0) {
      socket.send(serialized);
      return;
    }
    // Slow path: socket offline or queue already has pending frames — enqueue.
    this.enqueue(serialized, queuedFrameCoalesceKey(frame));
    this.connect();
  }

  private enqueue(serialized: string, coalesceKey?: string): void {
    const bytes = Buffer.byteLength(serialized, 'utf8');
    // A single pathological snapshot must not bypass the total byte cap just
    // because the queue is empty. It is telemetry, so fail closed and let the
    // next (usually smaller) rollup supersede it.
    if (bytes > this.maxQueuedBytes) {
      this.droppedFrames += 1;
      this.droppedBytes += bytes;
      // `droppedFrames` only moves a counter nobody polls. This is the one drop
      // that is never recoverable — no later rollup supersedes a frame that was
      // never queued — so name it once per frame. The frame body is not logged:
      // it is telemetry that may carry project content.
      process.emitWarning(
        `HQ telemetry frame of ${bytes} bytes exceeds the ${this.maxQueuedBytes}-byte offline queue cap and was dropped.`,
        { code: 'WRONGSTACK_HQ_FRAME_TOO_LARGE' },
      );
      return;
    }

    if (coalesceKey !== undefined) {
      let existingIndex = -1;
      for (let index = this.queue.length - 1; index >= 0; index -= 1) {
        if (this.queue[index]?.coalesceKey === coalesceKey) {
          existingIndex = index;
          break;
        }
      }
      if (existingIndex !== -1) {
        const [obsolete] = this.queue.splice(existingIndex, 1);
        if (obsolete !== undefined) {
          this.queueBytes -= obsolete.bytes;
          this.coalescedFrames += 1;
          this.coalescedBytes += obsolete.bytes;
        }
      }
    }

    // Drop oldest frames when either the count cap or the byte cap is
    // exceeded. The byte cap prevents unbounded RAM growth during extended
    // HQ outages while the count cap limits per-frame overhead.
    while (
      (this.queue.length >= this.maxQueuedMessages ||
        this.queueBytes + bytes > this.maxQueuedBytes) &&
      this.queue.length > 0
    ) {
      const dropped = this.queue.shift();
      if (dropped !== undefined) {
        this.queueBytes -= dropped.bytes;
        this.droppedFrames += 1;
        this.droppedBytes += dropped.bytes;
      }
    }
    this.queue.push({ serialized, bytes, coalesceKey });
    this.queueBytes += bytes;
  }

  /** Batch-dequeue up to 50 frames at a time, yielding to the microtask
   *  queue between batches so we don't starve the event loop on reconnect. */
  private flushQueue(): void {
    const socket = this.socket;
    if (socket?.readyState !== OPEN_STATE || this.queue.length === 0) return;
    const batch = this.queue.splice(0, 50);
    for (const frame of batch) {
      socket.send(frame.serialized);
      this.queueBytes -= frame.bytes;
    }
    this.queueBytes = Math.max(0, this.queueBytes);
    if (this.queue.length > 0) setImmediate(() => this.flushQueue());
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
  }

  private parseServerMessage(
    event: unknown,
  ): HqServerCommandBatchMessage | HqServerKanbanSnapshotMessage | null {
    const data = this.extractMessageData(event);
    if (data === null) return null;
    try {
      const parsed = JSON.parse(data) as
        | Partial<HqServerCommandBatchMessage>
        | Partial<HqServerKanbanSnapshotMessage>;
      if (parsed.type === 'hq.command_batch' && Array.isArray(parsed.commands)) {
        return parsed as HqServerCommandBatchMessage;
      }
      if (parsed.type === 'hq.kanban_snapshot') {
        const payload = (parsed as Partial<HqServerKanbanSnapshotMessage>).payload;
        if (
          payload !== undefined &&
          typeof payload === 'object' &&
          typeof payload.projectId === 'string' &&
          payload.projectId === this.options.project.projectId &&
          Array.isArray(payload.boards) &&
          Array.isArray(payload.tombstones)
        ) {
          return parsed as HqServerKanbanSnapshotMessage;
        }
      }
      return null;
    } catch {
      return null;
    }
  }

  private extractMessageData(event: unknown): string | null {
    const value =
      typeof event === 'object' && event !== null && 'data' in event
        ? (event as { data?: unknown }).data
        : event;
    if (typeof value === 'string') return value;
    if (value instanceof ArrayBuffer) return new TextDecoder().decode(value);
    if (ArrayBuffer.isView(value)) {
      const bytes = new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
      return new TextDecoder().decode(bytes);
    }
    return null;
  }

  private async handleCommandBatch(message: HqServerCommandBatchMessage): Promise<void> {
    const handler = this.options.onCommand;
    if (handler === undefined) return;

    for (const command of message.commands) {
      try {
        const result = await handler(command);
        if (result !== undefined) this.ackCommand(result);
        else if (command.requiresAck)
          this.ackCommand({ commandId: command.commandId, status: 'accepted' });
      } catch (err) {
        this.ackCommand({
          commandId: command.commandId,
          status: 'failed',
          message: err instanceof Error ? err.message : String(err),
        });
      }
      // Advance the poll cursor only AFTER the command is handled and acked.
      // Advancing it before `await handler` meant a socket flap mid-handler
      // left the next command_poll asking for commands AFTER this one — so an
      // operator command (steer/abort/broadcast) that never ran was silently
      // skipped and never re-fetched. At-least-once (a possible duplicate on
      // reconnect, which these commands tolerate) beats losing one outright.
      this.lastCommandId = command.commandId;
    }
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
    const targetUrl = this.lastAttempt?.url ?? this.options.url;
    // Process-wide suppression: multiple agents failing against the same HQ
    // collapse to ONE warning across the entire process lifetime while unreachable.
    if (this.connectWarnCooldownMs > 0) {
      if (warnedEndpoints.has(targetUrl)) {
        return false;
      }
      warnedEndpoints.add(targetUrl);
    }
    const attempt = this.lastAttempt;
    const message =
      `WrongStack HQ publisher: ${this.reconnectAttempt} consecutive connection failures` +
      `${attempt !== null ? ` to ${attempt.url} (client token ${attempt.hadToken ? 'present' : 'absent'})` : ''}. ` +
      'Either the HQ server is unreachable or it rejected the token (401). ' +
      'If HQ runs in client-token mode, verify WRONGSTACK_HQ_TOKEN / auth.json. Retries continue with backoff.';
    if (this.logger) {
      this.logger.warn(message, { event: 'hq.publisher.connect_failed' });
      return true;
    }
    const warn =
      this.options.warn ??
      ((msg: string) =>
        console.warn(
          JSON.stringify({
            level: 'warn',
            event: 'hq.publisher.connect_failed',
            message: msg,
            timestamp: this.now(),
          }),
        ));
    try {
      warn(message);
    } catch {
      /* diagnostics must never break publishing */
    }
    return true;
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
