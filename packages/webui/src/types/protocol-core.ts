import type { Usage } from '@wrongstack/core/types';
import type { SessionScopedPayload, WSCodeMapFileTarget } from '@wrongstack/webui-protocol';

/** Moved to webui-protocol (conversation-core.ts), the single source the SDK shares. */
export type {
  SessionScopedPayload,
  WSCodeMapFileTarget,
  WSIterationCompleted,
  WSIterationStarted,
  WSProviderError,
  WSProviderRetry,
  WSRunResult,
  WSSessionEnd,
  WSSessionFramesResumed,
  WSSessionRunState,
  WSSessionStart,
  WSTextDelta,
  WSThinkingDelta,
  WSToolExecuted,
  WSToolProgress,
  WSToolUseStart,
  WSUserMessage,
  WSUserMessageImage,
} from '@wrongstack/webui-protocol';

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
    /** Epoch ms when the new state's cooldown expires; omitted when n/a. */
    stateExpiresAt?: number | undefined;
    /** Last-error context for real-time waiting-room detail (optional). */
    lastErrorKind?: string | undefined;
    lastErrorStatus?: number | null | undefined;
    lastErrorMessage?: string | null | undefined;
    lastSessionId?: string | null | undefined;
    lastAgentId?: string | null | undefined;
  };
}

/**
 * `provider.quota` — subscription plan readings, pushed on every metered
 * response and replayed on `provider.quota.get`. `providerId` is present on a
 * push (it names the provider that just reported) and absent on a replay,
 * which carries every provider at once.
 */
export interface WSProviderQuota {
  type: 'provider.quota';
  payload: {
    providerId?: string | undefined;
    snapshots: unknown[];
    /** Only on the reply to `provider.quota.refresh`: each account read's outcome. */
    refreshed?: unknown[] | undefined;
  };
}

export interface WSProviderStatusSnapshot {
  type: 'provider.status.snapshot';
  payload: Record<string, unknown>;
}

/** One durable block/open audit entry (tail of provider-status-audit.jsonl). */
interface WSProviderAuditLine {
  ts: number;
  providerId: string;
  model: string;
  from: 'healthy' | 'degraded' | 'blocked';
  to: 'healthy' | 'degraded' | 'blocked';
  reason: string;
  expiresAt: number | null;
  error: {
    kind: string;
    status: number | null;
    message: string;
    sessionId: string | null;
    agentId: string | null;
  } | null;
}

export interface WSProviderAuditHistory {
  type: 'provider.audit.history';
  payload: SessionScopedPayload & { lines: WSProviderAuditLine[] };
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

export interface WSSessionResumeProgress {
  type: 'session.resume_progress';
  payload: SessionScopedPayload & {
    stage: string;
    loadedBytes: number;
    totalBytes: number;
  };
}
