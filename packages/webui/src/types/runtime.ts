import type { UserInputRequest, UserInputResponse } from '@wrongstack/contracts/types';
import type { HistoryRetention, RequestResidency } from '@wrongstack/core/utils/residency-labels';
import type { SessionScopedPayload } from './protocol-core.js';

/** Moved to webui-protocol (conversation-core.ts), the single source the SDK shares. */
export type {
  WSError,
  WSToolConfirmNeeded,
  WSToolConfirmResolved,
  WSToolConfirmResult,
} from '@wrongstack/webui-protocol';

export interface WSUserInputRequested {
  type: 'user.input_requested';
  payload: SessionScopedPayload & { request: UserInputRequest };
}
export interface WSUserInputResolved {
  type: 'user.input_resolved';
  payload: SessionScopedPayload & {
    requestId: string;
    response: UserInputResponse;
    source: 'user' | 'abort' | 'unattended';
  };
}
export interface WSUserInputSubmit {
  type: 'user.input_submit';
  payload: SessionScopedPayload & { response: UserInputResponse };
}

export interface WSSessionStats {
  type: 'session.stats';
  payload: {
    messages: number;
    inputTokens: number;
    outputTokens: number;
    cacheReadTokens: number;
    cost: number;
    duration: number;
  };
}

export interface WSTrustPersisted {
  type: 'trust.persisted';
  payload: SessionScopedPayload & {
    tool: string;
    pattern: string;
    displayPattern?: string;
    scope?: 'exact' | 'command' | 'tool';
    decision: 'always' | 'deny';
  };
}

export interface WSToolLoopDetected {
  type: 'tool.loop_detected';
  payload: SessionScopedPayload & {
    tools: string;
    repeatCount: number;
    iteration: number;
    kind?: 'tool' | 'message' | 'mixed' | undefined;
    action?: 'steer' | 'cut' | undefined;
    scope?: 'iteration' | 'call' | undefined;
  };
}

export interface WSDelegateStarted {
  type: 'delegate.started';
  payload: SessionScopedPayload & {
    target: string;
    task: string;
    subagentId?: string | undefined;
  };
}

export interface WSDelegateCompleted {
  type: 'delegate.completed';
  payload: SessionScopedPayload & {
    target: string;
    task: string;
    ok: boolean;
    status?: string | undefined;
    summary: string;
    durationMs: number;
    iterations: number;
    toolCalls: number;
    costUsd?: number | undefined;
    subagentId?: string | undefined;
  };
}

/** A background delegation result is waiting for the session's leader. */
export interface WSDelegationDeliveryPending {
  type: 'delegation.delivery_pending';
  payload: SessionScopedPayload & {
    count: number;
    delegationIds: string[];
    wake?: boolean | undefined;
  };
}

/** The runtime started a leader turn because background results arrived. */
export interface WSDelegationAutoWakeStarted {
  type: 'delegation.auto_wake_started';
  payload: SessionScopedPayload & { delegationIds: string[]; chain: number };
}

/** Auto-wake held results (chain cap) until the user sends a message. */
export interface WSDelegationAutoWakeSuppressed {
  type: 'delegation.auto_wake_suppressed';
  payload: SessionScopedPayload & { reason: 'chain_cap' | 'undisplayed'; pending: number };
}

export interface WSModelSwitch {
  type: 'model.switch';
  payload: {
    provider: string;
    model: string;
    requestId: string;
  };
}

export type MemoryScope = 'project-agents' | 'project-memory' | 'user-memory';

// ── Context Window Editor types ─────────────────────────────────────────────

export interface ContextEditorContentBlock {
  type: 'text' | 'tool_use' | 'tool_result' | 'image' | 'thinking';
  text?: string | undefined;
  id?: string | undefined;
  name?: string | undefined;
  input?: Record<string, unknown> | undefined;
  tool_use_id?: string | undefined;
  content?: string | undefined;
  is_error?: boolean | undefined;
  cache_control?: { type: 'ephemeral' } | undefined;
  providerMeta?: Record<string, unknown> | undefined;
  signature?: string | undefined;
  thinking?: string | undefined;
  source?:
    | {
        type: 'base64' | 'url';
        media_type?: string | undefined;
        data?: string | undefined;
        url?: string | undefined;
      }
    | undefined;
}

export interface ContextEditorMessage {
  role: 'user' | 'assistant' | 'system';
  content: string | ContextEditorContentBlock[];
  ts?: string | undefined;
}

/** A whole-message removal, or a character range in string/text-block content. blockIndex only identifies a text block; it is not a whole-block deletion. */
export interface ContextEditorRemoval {
  messageIndex: number;
  blockIndex?: number | undefined;
  start?: number | undefined;
  end?: number | undefined;
}

export interface ContextEditorMetrics {
  messages: number;
  blocks: number;
  /** Token estimate for the conversation messages portion only (excludes system prompt + tool schemas). */
  messageTokens: number;
  fullRequestTokens: number;
}

export interface ContextEditorWarning {
  path?: string | undefined;
  code: string;
  severity: 'info' | 'warning' | 'danger';
  message: string;
}

export interface ContextEditorDiagnostics {
  hasToolAdjacencyIssues: boolean;
  orphanToolUses: string[];
  orphanToolResults: string[];
  emptyMessages: number;
  thinkingBlocks: number;
  signedThinkingBlocks: number;
}

export interface ContextEditorRepairPreview {
  changed: boolean;
  removedToolUses: string[];
  removedToolResults: string[];
  removedMessages: number;
}

export interface ContextEditorValidationError {
  path: string;
  code: string;
  message: string;
}

export interface ContextEditorConflict {
  code: 'CONTEXT_REVISION_CONFLICT' | 'RUN_ACTIVE';
  message: string;
}

export interface WSContextEditorSnapshot {
  type: 'context.editor.snapshot';
  payload: SessionScopedPayload & {
    revision: string;
    messages: ContextEditorMessage[];
    readonlyContext: {
      systemPromptTokens: number;
      toolSchemaTokens: number;
      toolCount: number;
      totalTokens: number;
      messageTokens: number;
    };
    messageBreakdown: Array<{
      index: number;
      role: 'user' | 'assistant' | 'system';
      tokens: number;
      preview: string;
      blockCount: number | null;
      warnings: ContextEditorWarning[];
      pairedAssistantIndices: number[];
    }>;
    diagnostics: ContextEditorDiagnostics;
  };
}

export interface WSContextEditorValidation {
  type: 'context.editor.validation';
  payload: SessionScopedPayload & {
    ok: boolean;
    baseRevision: string;
    currentRevision: string;
    before: ContextEditorMetrics;
    after?: ContextEditorMetrics | undefined;
    validationErrors: ContextEditorValidationError[];
    warnings: ContextEditorWarning[];
    repair: ContextEditorRepairPreview;
    conflict?: ContextEditorConflict | undefined;
  };
}

export interface WSContextEditorApplied {
  type: 'context.editor.applied';
  payload: SessionScopedPayload & {
    previousRevision: string;
    revision: string;
    before: ContextEditorMetrics;
    after: ContextEditorMetrics;
    removed: {
      messages: number;
      blocks: number;
      toolUses: string[];
      toolResults: string[];
      emptyMessages: number;
    };
    warnings: ContextEditorWarning[];
  };
}

export interface WSContextDebug {
  type: 'context.debug';
  payload: SessionScopedPayload & {
    total: number;
    mode?: string | undefined;
    policy?: unknown | undefined;
    systemPrompt: number;
    tools: {
      total: number;
      count: number;
      breakdown: Array<{ name: string; tokens: number }>;
    };
    messages: {
      total: number;
      count: number;
      breakdown: Array<{ index: number; role: string; tokens: number; preview: string }>;
    };
    /** Cache residency of the last request sent (absent before the first). */
    residency?: RequestResidency | undefined;
    /** What the next compaction keeps. */
    retention?: HistoryRetention | undefined;
  };
}

export interface WSContextCompacted {
  type: 'context.compacted';
  payload: SessionScopedPayload & {
    before: number;
    after: number;
    saved: number;
    reductions: Array<{ phase: string; saved: number }>;
    repaired?: {
      removedToolUses: string[];
      removedToolResults: string[];
      removedMessages: number;
    };
  };
}

export interface WSCompactionFailed {
  type: 'compaction.failed';
  payload: SessionScopedPayload & {
    message: string;
    aggressive: boolean;
    level: 'warn' | 'soft' | 'hard';
    tokens: number;
    maxContext: number;
    load: number;
    fatal: boolean;
  };
}

export interface WSContextRepaired {
  type: 'context.repaired';
  payload: SessionScopedPayload & {
    removedToolUses: string[];
    removedToolResults: string[];
    removedMessages: number;
    beforeMessages?: number | undefined;
    afterMessages?: number | undefined;
  };
}

export interface WSContextPct {
  type: 'ctx.pct';
  payload: SessionScopedPayload & {
    load: number;
    rawLoad?: number | undefined;
    tokens: number;
    maxContext: number;
  };
}

export interface WSTopicAdviceResult {
  type: 'topic.advice_result';
  payload: SessionScopedPayload & {
    requestId: string;
    suggestNewContext: boolean;
    confidence: number;
    reason: string;
    nextTopic?: string | undefined;
    source: 'explicit' | 'model' | 'system-one' | 'cache' | 'local';
  };
}

export interface WSContextMaxContext {
  type: 'ctx.max_context';
  payload: SessionScopedPayload & {
    providerId: string;
    modelId: string;
    maxContext: number;
    previousMaxContext?: number | undefined;
    source?: 'configured' | 'provider' | 'provider_overflow' | undefined;
    decreased?: boolean | undefined;
  };
}

export interface WSTokenThreshold {
  type: 'token.threshold';
  payload: SessionScopedPayload & {
    used: number;
    limit: number;
  };
}

export interface WSTokenCostEstimateUnavailable {
  type: 'token.cost_estimate_unavailable';
  payload: SessionScopedPayload & {
    model: string;
  };
}

export interface WSContextModesList {
  type: 'context.modes.list';
  payload: SessionScopedPayload & {
    activeId: string;
    modes: Array<{
      id: string;
      name: string;
      description: string;
      isActive: boolean;
      thresholds: { warn: number; soft: number; hard: number };
      preserveK: number;
      eliseThreshold: number;
    }>;
  };
}

export interface WSContextModeChanged {
  type: 'context.mode.changed';
  payload: SessionScopedPayload & {
    id: string;
    name: string;
    policy: unknown;
  };
}

export interface WSToolsList {
  type: 'tools.list';
  payload: {
    /**
     * Echoed back from the request when the caller minted one
     * (`withRequestId` on the server). `consumeSuppressedChatEcho` correlates
     * on it to drop the chat echo for exactly the request that asked to be
     * suppressed.
     */
    requestId?: string | undefined;
    tools: Array<{
      name: string;
      owner: string;
      description: string;
      params: string[];
      disabled: boolean;
      mutating: boolean;
      permission: string;
    }>;
  };
}

export interface WSMemoryList {
  type: 'memory.list';
  payload: {
    text: string;
    error?: string | undefined;
  };
}

// ── SAGE response types ───────────────────────────────────────
