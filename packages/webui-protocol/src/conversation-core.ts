/**
 * The conversation core of the WebUI WebSocket protocol, with full payload
 * types: what `@wrongstack/client` speaks, and the part of the protocol the
 * JSON Schema in `schema/` is generated from (scripts/generate-protocol-schema.mjs).
 *
 * The WebUI imports these from here, so the frontend, the SDK and the schema
 * cannot drift apart. Every other message type is listed by name in
 * registry.ts, with its payload typed only inside the WebUI.
 */
import type { SessionMarker, SessionToolMeta, Usage } from '@wrongstack/contracts/types';

export interface WSSessionStart {
  type: 'session.start';
  payload: {
    sessionId: string;
    /** Original session start timestamp; resume must not reset uptime. */
    startedAt?: string | undefined;
    model: string;
    provider: string;
    maxContext?: number | undefined;
    projectName?: string | undefined;
    cwd?: string | undefined;
    mode?: string | undefined;
    contextMode?: string | undefined;
    inputCost?: number | undefined;
    outputCost?: number | undefined;
    cacheReadCost?: number | undefined;
    reset?: boolean | undefined;
    replayMessages?: Array<{ role: string | undefined; content: unknown; ts?: string | undefined }>;
    /** Audit markers (compaction, mode/skill switches, subagent lifecycle,
     *  provider retries, truncation) projected server-side. Replayed alongside
     *  the conversation so a reconnect shows what the live stream showed. */
    replayMarkers?: SessionMarker[] | undefined;
    /** Per-tool timing/output metadata projected from `tool_call_end`, so a
     *  replayed tool card shows the same duration and size chips it showed
     *  live. */
    replayToolMeta?: SessionToolMeta[] | undefined;
    replayUsage?: Usage | undefined;
    /** True when no provider+model is configured yet — show the setup screen. */
    needsSetup?: boolean | undefined;
    /** Feature negotiation prevents a newer WebUI from sending messages to an older backend. */
    protocolCapabilities?: string[] | undefined;
    /** Effort levels the ACTIVE model advertises (models.dev reasoningConfig).
     *  Absent when the model has no explicit effort list — the UI then shows
     *  the full canonical set, matching the resolver's conservative gate. */
    reasoningEffortLevels?: string[] | undefined;
    /** Identifies this server process; frame cursors sent with `session.subscribe` are valid only for it. */
    eventEpoch?: string | undefined;
  };
}
export interface WSSessionEnd {
  type: 'session.end';
  payload: {
    sessionId: string;
    usage: Usage;
    totalCost: number;
  };
}
export interface SessionScopedPayload {
  sessionId?: string | undefined;
}
/** One image attached to a user message. `data` is bare base64 (no data-URL
 *  prefix); `mediaType` travels separately. */
export interface WSUserMessageImage {
  data: string;
  mediaType: string;
  /** Original filename when the image came from a picker or drop. */
  name?: string;
}
export interface WSUserMessage {
  type: 'user_message';
  payload: SessionScopedPayload & {
    id: string;
    content: string;
    timestamp: number;
    /** Atomically replace only the provider-bound conversation before this run. */
    freshContext?: boolean | undefined;
    /** Images attached in the composer (paste / drop / file picker). The
     *  server converts these to canonical ImageBlocks ahead of the text. */
    images?: WSUserMessageImage[];
    /** @deprecated Legacy single-image field (a full data-URL). Servers
     *  still accept it; new clients send `images` instead. */
    imageBase64?: string;
  };
}
export interface WSTextDelta {
  type: 'provider.text_delta';
  payload: SessionScopedPayload & {
    text: string;
    messageId: string;
  };
}
export interface WSThinkingDelta {
  type: 'provider.thinking_delta';
  payload: SessionScopedPayload & {
    text: string;
  };
}
export interface WSCodeMapFileTarget {
  filePath: string;
  operation: 'read' | 'write' | 'edit' | 'delete' | 'search';
  line?: number | undefined;
  endLine?: number | undefined;
}
export interface WSToolUseStart {
  type: 'tool.started';
  payload: SessionScopedPayload & {
    id: string;
    name: string;
    traceId?: string | undefined;
    agentId?: string | undefined;
    agentName?: string | undefined;
    input?: unknown | undefined;
    fileTargets?: WSCodeMapFileTarget[] | undefined;
    messageId: string;
  };
}
export interface WSToolProgress {
  type: 'tool.progress';
  payload: SessionScopedPayload & {
    name: string;
    id: string;
    traceId?: string | undefined;
    agentId?: string | undefined;
    agentName?: string | undefined;
    event: {
      type: 'log' | 'warning' | 'metric' | 'file_changed' | 'partial_output';
      text?: string | undefined;
      data?: Record<string, unknown>;
      path?: string | undefined;
      operation?: 'write' | 'edit' | 'delete' | 'rename' | undefined;
      line?: number | undefined;
      endLine?: number | undefined;
    };
  };
}
export interface WSToolExecuted {
  type: 'tool.executed';
  payload: SessionScopedPayload & {
    id: string;
    name: string;
    traceId?: string | undefined;
    agentId?: string | undefined;
    agentName?: string | undefined;
    durationMs: number;
    ok: boolean;
    input?: unknown | undefined;
    fileTargets?: WSCodeMapFileTarget[] | undefined;
    output?: string | undefined;
    /**
     * SAGE Memory Injector block (`--- SAGE: … ---` header first, then one line
     * per memory) split off `output` by the backend before its preview cap.
     * Rendered as a memory card — never appended back onto the tool body.
     */
    sage?: string[] | undefined;
    outputBytes?: number | undefined;
    outputTokens?: number | undefined;
    outputLines?: number | undefined;
  };
}
export interface WSIterationStarted {
  type: 'iteration.started';
  payload: SessionScopedPayload & {
    index: number;
    maxIterations?: number | undefined;
  };
}
export interface WSIterationCompleted {
  type: 'iteration.completed';
  payload: SessionScopedPayload & {
    index: number;
    totalIterations: number;
  };
}
export interface WSProviderRetry {
  type: 'provider.retry';
  payload: SessionScopedPayload & {
    providerId: string;
    attempt: number;
    delayMs: number;
    status: number;
    description: string;
  };
}
export interface WSProviderError {
  type: 'provider.error';
  payload: SessionScopedPayload & {
    providerId: string;
    status: number;
    description: string;
    retryable: boolean;
  };
}
/**
 * How a run ended. Broadcast to the session (numbered, so a reconnect catches
 * it up), not only to the connection that sent the prompt.
 */
export interface WSRunResult {
  type: 'run.result';
  payload: SessionScopedPayload & {
    /** Id of the user_message that initiated this run. */
    requestId?: string | undefined;
    status: 'done' | 'failed' | 'max_iterations' | 'aborted';
    iterations: number;
    finalText?: string | undefined;
    error?: {
      code: string;
      message: string;
      recoverable: boolean;
    };
  };
}
export interface WSError {
  type: 'error';
  payload: SessionScopedPayload & {
    phase: string;
    message: string;
    /** Machine-readable reason, when the server has one (`session_not_ready`, `vision_unsupported`, …). */
    code?: string | undefined;
  };
}
export interface WSToolConfirmNeeded {
  type: 'tool.confirm_needed';
  payload: SessionScopedPayload & {
    id: string;
    toolName: string;
    input: unknown;
    suggestedPattern: string;
    decisionSource?: string | undefined;
    riskTier?: 'safe' | 'standard' | 'destructive' | undefined;
    boundaryReason?: string | undefined;
    deadlineAt?: number | undefined;
  };
}
export interface WSToolConfirmResolved {
  type: 'tool.confirm_resolved';
  payload: SessionScopedPayload & {
    id: string;
    toolName: string;
    decision:
      | 'yes'
      | 'no'
      | 'always'
      | 'always-exact'
      | 'always-command'
      | 'always-tool'
      | 'deny'
      | 'abort';
    source: 'brain_timeout' | 'abort';
    rationale?: string | undefined;
  };
}
export interface WSToolConfirmResult {
  type: 'tool.confirm_result';
  payload: SessionScopedPayload & {
    id: string;
    decision: 'yes' | 'no' | 'always' | 'always-exact' | 'always-command' | 'always-tool' | 'deny';
  };
}
export interface WSSessionsList {
  type: 'sessions.list';
  payload: {
    sessions: Array<{
      id: string;
      title: string;
      name?: string | undefined;
      startedAt: string;
      endedAt?: string | undefined;
      model: string;
      provider: string;
      tokenTotal: number;
      iterationCount?: number | undefined;
      toolCallCount?: number | undefined;
      toolErrorCount?: number | undefined;
      fileChangeCount?: number | undefined;
      toolBreakdown?: Record<string, number> | undefined;
      compactionCount?: number | undefined;
      outcome?: 'completed' | 'error' | 'timeout' | 'aborted' | undefined;
      isCurrent: boolean;
    }>;
    error?: string | undefined;
  };
}

/** Stop the session's run. */
export interface WSAbort {
  type: 'abort';
  payload: SessionScopedPayload;
}

/** Keep-alive; answered with `pong`. */
export interface WSPing {
  type: 'ping';
}

export interface WSPong {
  type: 'pong';
  payload?: Record<string, unknown> | undefined;
}

/** Ask for recent sessions; answered with `sessions.list`. */
export interface WSSessionsListRequest {
  type: 'sessions.list';
  payload: { limit: number } & SessionScopedPayload;
}

/**
 * Open a new session; answered with `session.start`. `replaceSessionId`
 * retires that session in the same operation; without it the new session is
 * opened beside the others.
 */
export interface WSSessionNew {
  type: 'session.new';
  payload?:
    | ({ systemPromptVariant?: string; replaceSessionId?: string } & SessionScopedPayload)
    | SessionScopedPayload;
}

/** Open an earlier session; answered with `session.start` carrying its transcript. */
export interface WSSessionResume {
  type: 'session.resume';
  payload: { id: string } & SessionScopedPayload;
}

/**
 * Declare every session this connection shows. The server sends a session's
 * events only to connections that declared it; the list replaces the last one.
 */
export interface WSSessionSubscribe {
  type: 'session.subscribe';
  payload: {
    sessionIds: string[];
    /** Sessions whose transcript this connection needs sent back. */
    replayFor?: string[];
    /** Reconnect catch-up: the last frame (`seq`) applied per session, for `eventEpoch`. */
    cursors?: Record<string, number>;
    eventEpoch?: string;
  } & SessionScopedPayload;
}

/**
 * Whether one session's run is live, answered per declared session after
 * every `session.subscribe`. A run that ended while the connection was down,
 * with its `run.result` no longer in the frame log, is known over only by
 * this.
 */
export interface WSSessionRunState {
  type: 'session.run_state';
  payload: SessionScopedPayload & {
    isRunning: boolean;
  };
}

/**
 * The end of one session's reconnect catch-up. `resumed: true` came after the
 * frames the connection missed; `false` means the server could not supply
 * them and a transcript replay follows instead.
 */
export interface WSSessionFramesResumed {
  type: 'session.frames_resumed';
  payload: SessionScopedPayload & {
    resumed: boolean;
    frames?: number;
  };
}

/** Messages a client of the conversation core sends. */
export type CoreClientMessage =
  | WSUserMessage
  | WSAbort
  | WSPing
  | WSSessionsListRequest
  | WSSessionNew
  | WSSessionResume
  | WSSessionSubscribe
  | WSToolConfirmResult;

/**
 * Messages the server sends in the conversation core. A frame broadcast to a
 * session also carries `seq` (that session's frame number) and, when its
 * payload names another session, `stream` (the session whose counter `seq`
 * advances), beside `type` and `payload`.
 */
export type CoreServerMessage =
  | WSSessionStart
  | WSSessionEnd
  | WSTextDelta
  | WSThinkingDelta
  | WSToolUseStart
  | WSToolProgress
  | WSToolExecuted
  | WSIterationStarted
  | WSIterationCompleted
  | WSProviderRetry
  | WSProviderError
  | WSRunResult
  | WSError
  | WSToolConfirmNeeded
  | WSToolConfirmResolved
  | WSSessionsList
  | WSSessionRunState
  | WSSessionFramesResumed
  | WSPong;
