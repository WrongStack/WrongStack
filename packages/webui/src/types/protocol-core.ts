import type { SessionMarker, Usage } from '@wrongstack/core/types';

// Event types for WebSocket communication
export interface WSMessage {
  type: string;
  payload: unknown;
}

export interface WSSessionStart {
  type: 'session.start';
  payload: {
    sessionId: string;
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
    replayUsage?: Usage | undefined;
    /** True when no provider+model is configured yet — show the setup screen. */
    needsSetup?: boolean | undefined;
    /** Feature negotiation prevents a newer WebUI from sending messages to an older backend. */
    protocolCapabilities?: string[] | undefined;
    /** Effort levels the ACTIVE model advertises (models.dev reasoningConfig).
     *  Absent when the model has no explicit effort list — the UI then shows
     *  the full canonical set, matching the resolver's conservative gate. */
    reasoningEffortLevels?: string[] | undefined;
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
    stateExpiresAt?: number | undefined;
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

/** Subagent tool lifecycle dedicated to CodeMap; intentionally does not create chat bubbles. */
export interface WSCodeMapToolStarted {
  type: 'codemap.tool_started';
  payload: SessionScopedPayload & {
    parentSessionId?: string | undefined;
    traceId?: string | undefined;
    agentId: string;
    agentName: string;
    id: string;
    name: string;
    input?: unknown | undefined;
    fileTargets?: WSCodeMapFileTarget[] | undefined;
    output?: string | undefined;
    outputBytes?: number | undefined;
    outputTokens?: number | undefined;
    outputLines?: number | undefined;
  };
}

export interface WSCodeMapToolExecuted {
  type: 'codemap.tool_executed';
  payload: SessionScopedPayload & {
    parentSessionId?: string | undefined;
    traceId?: string | undefined;
    agentId: string;
    agentName: string;
    id?: string | undefined;
    name: string;
    durationMs: number;
    ok: boolean;
    input?: unknown | undefined;
    fileTargets?: WSCodeMapFileTarget[] | undefined;
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

export interface WSIterationLimitReached {
  type: 'iteration.limit_reached';
  payload: SessionScopedPayload & {
    currentIterations: number;
    currentLimit: number;
  };
}

export interface WSProviderResponse {
  type: 'provider.response';
  payload: SessionScopedPayload & {
    content?: unknown;
    usage: Usage;
    stopReason: string;
    messageId: string;
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

export interface WSProviderFallback {
  type: 'provider.fallback';
  payload: SessionScopedPayload & {
    from: { providerId: string; model: string };
    to: { providerId: string; model: string };
    status: number;
    providerSwitched: boolean;
    /** Gate correlation id — present when a fallback gate mediated the switch. */
    requestId?: string | undefined;
  };
}

export interface WSProviderFallbackPending {
  type: 'provider.fallback_pending';
  payload: SessionScopedPayload & {
    from: { providerId: string; model: string };
    status: number;
    candidates: Array<{ providerId: string; model: string }>;
    autoSwitchSeconds: number;
    requestId: string;
    timestamp: number;
  };
}

export interface WSProviderStatusChanged {
  type: 'provider.status_changed';
  payload: SessionScopedPayload & {
    providerId: string;
    model: string;
    oldState: 'healthy' | 'degraded' | 'blocked';
    newState: 'healthy' | 'degraded' | 'blocked';
    reason: string;
    timestamp: number;
  };
}

export interface WSProviderStatusSnapshot {
  type: 'provider.status.snapshot';
  payload: Record<string, unknown>;
}

export interface WSProviderActiveBlocked {
  type: 'provider.active_blocked';
  payload: SessionScopedPayload & {
    providerId: string;
    model: string;
    state: 'blocked';
    fallbackProviderId: string;
    fallbackModel: string;
    lastError: string;
    timestamp: number;
  };
}

export interface WSProviderStreamError {
  type: 'provider.stream_error';
  payload: SessionScopedPayload & {
    eventType: string;
    message: string;
  };
}

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
