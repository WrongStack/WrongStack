
import type { Usage } from '@wrongstack/core';

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
    replayUsage?: Usage | undefined;
    /** True when no provider+model is configured yet — show the setup screen. */
    needsSetup?: boolean | undefined;
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

export interface WSUserMessage {
  type: 'user_message';
  payload: SessionScopedPayload & {
    id: string;
    content: string;
    timestamp: number;
    /** Base64-encoded clipboard image, if the user pasted one. */
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

export interface WSToolUseStart {
  type: 'tool.started';
  payload: SessionScopedPayload & {
    id: string;
    name: string;
    input?: unknown | undefined;
    messageId: string;
  };
}

export interface WSToolProgress {
  type: 'tool.progress';
  payload: SessionScopedPayload & {
    name: string;
    id: string;
    event: {
      type: 'log' | 'warning' | 'metric' | 'file_changed' | 'partial_output';
      text?: string | undefined;
      data?: Record<string, unknown>;
    };
  };
}

export interface WSToolExecuted {
  type: 'tool.executed';
  payload: SessionScopedPayload & {
    id: string;
    name: string;
    durationMs: number;
    ok: boolean;
    input?: unknown | undefined;
    output?: string | undefined;
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

export interface WSError {
  type: 'error';
  payload: SessionScopedPayload & {
    phase: string;
    message: string;
  };
}

export interface WSToolConfirmNeeded {
  type: 'tool.confirm_needed';
  payload: SessionScopedPayload & {
    id: string;
    toolName: string;
    input: unknown;
    suggestedPattern: string;
    resolve: (decision: 'yes' | 'no' | 'always' | 'deny') => void;
  };
}

export interface WSToolConfirmResult {
  type: 'tool.confirm_result';
  payload: SessionScopedPayload & {
    id: string;
    decision: 'yes' | 'no' | 'always' | 'deny';
  };
}

export interface WSTrustPersisted {
  type: 'trust.persisted';
  payload: SessionScopedPayload & {
    tool: string;
    pattern: string;
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
  };
}

export interface WSDelegateStarted {
  type: 'delegate.started';
  payload: SessionScopedPayload & {
    target: string;
    task: string;
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

export interface WSModelSwitch {
  type: 'model.switch';
  payload: {
    provider: string;
    model: string;
  };
}

export type MemoryScope = 'project-agents' | 'project-memory' | 'user-memory';

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

export interface WSContextMaxContext {
  type: 'ctx.max_context';
  payload: SessionScopedPayload & {
    providerId: string;
    modelId: string;
    maxContext: number;
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
    tools: Array<{ name: string; description: string; params: string[] }>;
  };
}

export interface WSMemoryList {
  type: 'memory.list';
  payload: {
    text: string;
    error?: string | undefined;
  };
}

export interface WSSkillsList {
  type: 'skills.list';
  payload: {
    enabled: boolean;
    error?: string | undefined;
    skills: Array<{
      name: string;
      description: string;
      version: string;
      source: string;
      sourceUrl: string;
      ref: string;
      path: string;
      trigger: string;
      scope: string[];
    }>;
  };
}

export interface WSSkillContent {
  type: 'skills.content';
  payload: {
    name: string;
    body: string;
    path: string;
    source: string;
    relatedFiles: string[];
    references: string[];
    error?: string | undefined;
    sourceUrl?: string;
  };
}

export interface WSDesignKitSummary {
  id: string;
  name: string;
  aesthetic: string;
  bestFor: string;
  stacks: string[];
  tags: string[];
  light: Record<string, string>;
  dark: Record<string, string>;
}

export interface WSDesignList {
  type: 'design.list';
  payload: {
    kits: WSDesignKitSummary[];
    activeKit: string | null;
    stack: string | null;
    overrides?: Record<string, string> | undefined;
    error?: string | undefined;
  };
}

export interface WSDesignUse {
  type: 'design.use';
  payload: {
    ok: boolean;
    kit?: string | undefined;
    name?: string | undefined;
    aesthetic?: string | undefined;
    stack?: string | undefined;
    body?: string | undefined;
    overrides?: Record<string, string> | undefined;
    light?: Record<string, string> | undefined;
    dark?: Record<string, string> | undefined;
    error?: string | undefined;
  };
}

export interface WSDesignState {
  type: 'design.state';
  payload: {
    activeKit: string | null;
    stack: string | null;
    overrides?: Record<string, string> | undefined;
  };
}

export interface WSDesignSet {
  type: 'design.set';
  payload: {
    ok: boolean;
    overrides?: Record<string, string> | undefined;
    error?: string | undefined;
  };
}

export interface WSDesignMaterialize {
  type: 'design.materialize';
  payload: {
    ok: boolean;
    path?: string | undefined;
    format?: string | undefined;
    stack?: string | undefined;
    error?: string | undefined;
  };
}

export interface WSDesignVerify {
  type: 'design.verify';
  payload: {
    ok: boolean;
    kit?: string | undefined;
    filesScanned?: number | undefined;
    score?: number | undefined;
    violationCount?: number | undefined;
    violations?: { file: string; line: number; snippet: string; reason: string }[] | undefined;
    error?: string | undefined;
  };
}

export interface WSSkillsInstalled {
  type: 'skills.installed';
  payload: {
    success: boolean;
    error: string | null;
    results?: Array<{
      name: string;
      path: string;
      scope: 'project' | 'user';
      source: string;
      ref: string;
      skillCount: number;
    }>;
  };
}

export interface WSSkillsUninstalled {
  type: 'skills.uninstalled';
  payload: {
    success: boolean;
    error: string | null;
  };
}

export interface WSSkillsUpdated {
  type: 'skills.updated';
  payload: {
    success: boolean;
    error: string | null;
    updated?: Array<{ name: string; oldRef: string; newRef: string }>;
    unchanged?: string[];
    errors?: Array<{ name: string; error: string }>;
  };
}

export interface WSSkillsCreated {
  type: 'skills.created';
  payload: {
    success: boolean;
    error: string | null;
    skill?: {
      name: string;
      path: string;
      scope: 'project' | 'user';
    };
  };
}

export interface WSSkillsEdited {
  type: 'skills.edited';
  payload: {
    success: boolean;
    error: string | null;
  };
}

export interface WSSkillsExported {
  type: 'skills.exported';
  payload: {
    /** Base64-encoded ZIP buffer containing all skills as SKILL.md files */
    zipBase64: string;
    skillCount: number;
    error?: string | undefined;
  };
}

export interface WSDiagGet {
  type: 'diag.get';
  payload: SessionScopedPayload & {
    provider: string;
    model: string;
    cwd: string;
    sessionId: string;
    tools: { count: number; names: string[] };
    features: { memory: boolean; skills: boolean; modelsRegistry: boolean };
    mode: string;
    usage: { input: number; output: number; cacheRead?: number | undefined };
    messages: number;
    todos: number;
  };
}

export interface WSStatsGet {
  type: 'stats.get';
  payload: SessionScopedPayload & {
    sessionId: string;
    provider: string;
    model: string;
    usage: { input: number; output: number; cacheRead?: number | undefined; cacheWrite?: number | undefined };
    cache: { readTokens: number; writeTokens: number; hitRatio: number } | null;
    cost: number;
    messages: number;
    readFiles: number;
    tools: number;
    sideEffectCount?: number | undefined;
    elapsedMs: number;
  };
}

export interface WSSideEffects {
  type: 'side_effects';
  payload: SessionScopedPayload & {
    sideEffects: Array<{
      toolUseId: string;
      toolName: string;
      ts: string;
      input: Record<string, unknown>;
      outcome?: string | undefined;
      risk: string;
    }>;
  };
}

export interface WSSessionsList {
  type: 'sessions.list';
  payload: {
    sessions: Array<{
      id: string;
      title: string;
      startedAt: string;
      model: string;
      provider: string;
      tokenTotal: number;
      isCurrent: boolean;
    }>;
    error?: string | undefined;
  };
}

// --- Provider/Model/Key management (mirrors TUI/CLI auth-menu experience) ---

export interface WSProviderCatalog {
  type: 'provider.catalog';
  payload: {
    providers: Array<{
      id: string;
      name: string;
      family: string;
      apiBase?: string | undefined;
      envVars: string[];
      modelCount: number;
      hasApiKey: boolean;
    }>;
  };
}

export interface WSProviderModels {
  type: 'provider.models';
  payload: {
    provider: string;
    models: Array<{
      id: string;
      name: string;
      description?: string | undefined;
      releaseDate?: string | undefined;
      contextWindow?: number | undefined;
      inputCost?: number | undefined;
      outputCost?: number | undefined;
      capabilities: string[];
    }>;
  };
}

export interface WSSavedProviders {
  type: 'providers.saved';
  payload: {
    providers: Array<{
      id: string;
      family?: string | undefined;
      baseUrl?: string | undefined;
      /** Saved model allowlist, in the order the user pinned them. */
      models?: string[] | undefined;
      /** First entry of `models`, surfaced for the panel's "Using" line. */
      pickedModelId?: string | undefined;
      apiKeys: Array<{
        label: string;
        maskedKey: string;
        isActive: boolean;
        createdAt: string;
      }>;
    }>;
  };
}

/**
 * Health-probe result for a single provider, broadcast in reply to a
 * `provider.probe` client message. Mirrors the `ProbeResult` shape
 * from `@wrongstack/runtime/probe`, plus the `providerId` so panels
 * can route the reply to the right card.
 */
export interface WSProviderProbe {
  type: 'provider.probe';
  payload: {
    providerId: string;
    ok: boolean;
    status: string;
    httpStatus?: number | undefined;
    elapsedMs?: number | undefined;
    modelCount?: number | undefined;
    modelIds?: string[] | undefined;
    detail?: string | undefined;
  };
}

export interface WSKeyOperationResult {
  type: 'key.operation_result';
  payload: {
    success: boolean;
    message: string;
  };
}

/** Which subscription OAuth login a flow is running. */
export type OAuthKind = 'chatgpt' | 'claude' | 'copilot';

/**
 * Progress for an in-flight subscription OAuth login, broadcast in reply to
 * `auth.oauth.start` / `auth.oauth.code`. `phase` drives the UI:
 *  - `awaiting_browser` — loopback flows: open `authorizeUrl` in a new tab.
 *  - `awaiting_code` — copilot device flow: show `userCode` + `verificationUri`.
 *  - `exchanging` / `fetching_models` — spinner states.
 *  - `success` — `providerId` is now saved (the `providers.saved` broadcast follows).
 *  - `error` — `message` carries the reason.
 */
export interface WSAuthOAuthStatus {
  type: 'auth.oauth.status';
  payload: {
    kind: OAuthKind;
    phase: 'awaiting_browser' | 'awaiting_code' | 'exchanging' | 'fetching_models' | 'success' | 'error';
    providerId?: string | undefined;
    authorizeUrl?: string | undefined;
    verificationUri?: string | undefined;
    userCode?: string | undefined;
    /** True when a loopback listener bound (false → manual paste needed). */
    bound?: boolean | undefined;
    message?: string | undefined;
  };
}

export interface WSFilesList {
  type: 'files.list';
  payload: {
    files: string[];
  };
}

export type CompletionItemKind =
  | 'text'
  | 'method'
  | 'function'
  | 'constructor'
  | 'field'
  | 'variable'
  | 'class'
  | 'interface'
  | 'module'
  | 'property'
  | 'unit'
  | 'value'
  | 'enum'
  | 'keyword'
  | 'snippet'
  | 'file'
  | 'reference';

export interface WSCompletionRequest {
  type: 'completion.request';
  payload: {
    requestId: string;
    filePath: string;
    language: string;
    lineNumber: number;
    column: number;
    content?: string | undefined;
    prefix: string;
    suffix?: string | undefined;
    triggerCharacter?: string | undefined;
    triggerKind?: number | undefined;
    allowLlm?: boolean | undefined;
  };
}

export interface WSCompletionResult {
  type: 'completion.result';
  payload: {
    requestId: string;
    filePath: string;
    items: Array<{
      label: string;
      insertText: string;
      kind?: CompletionItemKind | undefined;
      detail?: string | undefined;
      documentation?: string | undefined;
      sortText?: string | undefined;
      source?: 'llm' | 'index' | 'lsp' | undefined;
    }>;
    error?: string | undefined;
  };
}

export interface WSTodosUpdated {
  type: 'todos.updated';
  payload: SessionScopedPayload & {
    todos: Array<{
      id: string;
      content: string;
      status: 'pending' | 'in_progress' | 'completed';
      activeForm?: string | undefined;
    }>;
  };
}

export interface WSTodosCleared {
  type: 'todos.cleared';
  payload?: Record<string, never>;
}

export interface WSModesList {
  type: 'modes.list';
  payload: {
    modes: Array<{
      id: string;
      name: string;
      description: string;
      isActive: boolean;
    }>;
    activeId: string;
  };
}

/** AutoPhase live state broadcast (see server/autophase-ws-handler.ts). */
export interface WSAutoPhaseState {
  type: 'autophase.state';
  payload: Record<string, unknown>;
}

export interface WSAutoPhaseProgress {
  type: 'autophase.progress';
  payload: Record<string, unknown>;
}

export interface WSAutoPhaseLifecycle {
  type:
    | 'autophase.paused'
    | 'autophase.resumed'
    | 'autophase.stopped'
    | 'autophase.saved'
    | 'autophase.completed'
    | 'autophase.failed'
    | 'autophase.error'
    | 'autophase.cleared'
    | 'autophase.reverted';
  payload: Record<string, unknown>;
}

export interface WSAutoPhaseList {
  type: 'autophase.list';
  payload: { graphs: unknown[] };
}

export interface WSEternalIteration {
  type: 'eternal.iteration';
  payload: { entry: Record<string, unknown> };
}

export interface WSAgentTimelineMessage {
  type: 'agent.timeline.message';
  payload: SessionScopedPayload & {
    subagentId: string;
    agentName: string;
    content: string;
    kind: 'text' | 'tool_use' | 'error' | 'status';
    iteration: number;
    ts: string;
    toolName?: string | undefined;
    costUsd?: number | undefined;
  };
}

export interface WSAgentStatusChanged {
  type: 'agent.status_changed';
  payload: SessionScopedPayload & {
    subagentId: string;
    agentName: string;
    status: 'spawned' | 'running' | 'completed' | 'failed' | 'timeout' | 'stopped' | 'budget_exhausted';
    ts: string;
    summary?: string | undefined;
    task?: string | undefined;
  };
}

/** One worktree lane in the swim-lane / DAG view. */
export interface WorktreeHandleView {
  handleId: string;
  ownerId: string;
  ownerLabel: string;
  /** Absolute checkout path (for open-in-terminal / remove). */
  dir?: string | undefined;
  branch: string;
  baseBranch: string;
  status:
    | 'allocating'
    | 'active'
    | 'committing'
    | 'merging'
    | 'merged'
    | 'needs-review'
    | 'failed';
  insertions: number;
  deletions: number;
  files: number;
  conflictFiles?: string[] | undefined;
  allocatedAt: number;
  lastEventAt: number;
  recentActivity: Array<{ kind: string; text: string; at: number }>;
}

/** Full worktree snapshot (broadcast on a timer, see worktree-ws-handler.ts). */
export interface WSWorktreeState {
  type: 'worktree.state';
  payload: { worktrees: WorktreeHandleView[]; baseBranch: string };
}

/** Incremental worktree lifecycle event — drives the flowing activity strip. */
export interface WSWorktreeEvent {
  type: 'worktree.event';
  payload: { kind: string; handleId: string; text: string; at: number };
}

/** One orphaned git artifact left by a previous/crashed run. */
export interface WorktreeOrphanView {
  /** Absolute checkout path (omitted for a branch-only orphan). */
  dir?: string | undefined;
  /** Branch name (`wstack/ap/*`), when known. */
  branch?: string | undefined;
  kind: 'worktree' | 'branch';
}

/** Disk-scanned orphan inventory + whether it is safe to clean right now. */
export interface WSWorktreeOrphans {
  type: 'worktree.orphans';
  payload: {
    orphans: WorktreeOrphanView[];
    /** False while a run is live (in this session or another process). */
    canClean: boolean;
    /** Why cleaning is blocked, when canClean is false. */
    reason?: string | undefined;
  };
}

/** Outcome of a worktree-panel orphan cleanup (bulk or single remove). */
export interface WSWorktreeCleanupResult {
  type: 'worktree.cleanup_result';
  payload: { ok: boolean; removed: number; reason?: string | undefined };
}

/** Compact per-worktree change summary. */
export interface WorktreeDiffSummary {
  files: Array<{ path: string; insertions: number; deletions: number }>;
  insertions: number;
  deletions: number;
  commits: number;
}

/** Outcome of a per-worktree squash-merge into base. */
export interface WSWorktreeMergeResult {
  type: 'worktree.merge_result';
  payload: {
    ok: boolean;
    branch: string;
    conflict?: boolean | undefined;
    conflictFiles?: string[] | undefined;
    reason?: string | undefined;
  };
}

/** Result of a per-worktree "View changes" request. */
export interface WSWorktreeDiffResult {
  type: 'worktree.diff_result';
  payload: { dir: string; summary: WorktreeDiffSummary | null };
}

export type WSClientMessage =
  | WSUserMessage
  | WSToolConfirmResult
  | {
      type: 'autophase.start';
      payload: {
        title: string;
        phases?: unknown[] | undefined;
        autonomous?: boolean | undefined;
        /** Per-run override of git-worktree isolation. Omitted → env default
         *  (WRONGSTACK_AUTOPHASE_WORKTREES). false → run on the current branch. */
        worktrees?: boolean | undefined;
      };
    }
  | { type: 'autophase.pause'; payload: Record<string, never> }
  | { type: 'autophase.resume'; payload: Record<string, never> }
  | { type: 'autophase.stop'; payload: Record<string, never> }
  | { type: 'autophase.clear'; payload?: Record<string, never> }
  | { type: 'autophase.revert'; payload?: Record<string, never> }
  | { type: 'autophase.status'; payload?: Record<string, never> }
  | { type: 'autophase.save'; payload?: Record<string, never> }
  | { type: 'autophase.list'; payload?: Record<string, never> }
  | { type: 'autophase.load'; payload: { graphId: string } }
  | { type: 'autophase.toggleAutonomous'; payload: { autonomous?: boolean | undefined } }
  | { type: 'autophase.selectPhase'; payload: { phaseId: string } }
  | { type: 'autophase.taskStatus'; payload: { taskId: string; status: string } }
  | { type: 'autophase.moveTask'; payload: { taskId: string; toPhaseId: string } }
  | {
      type: 'autophase.assignTask';
      payload: { taskId: string; agentId?: string | undefined; agentName?: string | undefined };
    }
  | {
      type: 'autophase.addTask';
      payload: {
        phaseId: string;
        title: string;
        description?: string | undefined;
        type?: string | undefined;
        priority?: string | undefined;
      };
    }
  | { type: 'autophase.retryTask'; payload: { taskId: string } }
  | { type: 'autophase.runTask'; payload: { taskId: string } }
  | { type: 'specs.list'; payload?: Record<string, never> }
  | { type: 'specs.get'; payload: { specId: string } }
  | {
      type: 'specs.taskStatus';
      payload: { graphId: string; taskId: string; status: string };
    }
  | { type: 'sdd.board.get'; payload?: Record<string, never> }
  | { type: 'sdd.board.list'; payload?: Record<string, never> }
  | { type: 'sdd.board.pause'; payload?: { runId?: string | undefined } }
  | { type: 'sdd.board.resume'; payload?: { runId?: string | undefined } }
  | { type: 'sdd.board.stop'; payload?: { runId?: string | undefined } }
  | { type: 'sdd.board.retry'; payload: { taskId: string; runId?: string | undefined } }
  | { type: 'sdd.board.retry_all_failed'; payload?: { runId?: string | undefined } }
  | {
      type: 'sdd.board.reassign';
      payload: { taskId: string; agentName: string; runId?: string | undefined };
    }
  | {
      type: 'sdd.board.set_task_model';
      payload: { taskId: string; model?: string | undefined; provider?: string | undefined; runId?: string | undefined };
    }
  | {
      type: 'sdd.board.set_task_fallbacks';
      payload: { taskId: string; fallbackModels?: string[] | undefined; runId?: string | undefined };
    }
  | {
      type: 'sdd.board.set_task_verification';
      payload: { taskId: string; verificationCommand?: string | undefined; runId?: string | undefined };
    }
  | { type: 'sdd.board.cancel_task'; payload: { taskId: string; runId?: string | undefined } }
  | { type: 'sdd.board.delete_task'; payload: { taskId: string; runId?: string | undefined } }
  | {
      type: 'sdd.board.split_task';
      payload: {
        taskId: string;
        subtasks: Array<{ title: string; description: string }>;
        runId?: string | undefined;
      };
    }
  | { type: 'sdd.board.cleanup_worktrees'; payload?: { runId?: string | undefined } }
  | { type: 'sdd.board.rollback'; payload?: { runId?: string | undefined } }
  | {
      type: 'sdd.board.destroy';
      payload?: { runId?: string | undefined; revertMerged?: boolean | undefined };
    }
  | { type: 'worktree.scan'; payload?: Record<string, never> }
  | { type: 'worktree.cleanup'; payload?: Record<string, never> }
  | { type: 'worktree.remove'; payload: { dir?: string | undefined; branch?: string | undefined } }
  | { type: 'worktree.merge'; payload: { branch: string } }
  | { type: 'worktree.diff'; payload: { dir: string; baseBranch?: string | undefined } }
  | { type: 'sdd.spec.start'; payload: { goal: string } }
  | { type: 'sdd.spec.message'; payload: { text: string } }
  | { type: 'sdd.spec.approve'; payload?: Record<string, never> }
  | { type: 'sdd.spec.get'; payload?: Record<string, never> }
  | {
      type: 'sdd.run.start';
      payload?: {
        parallelSlots?: number | undefined;
        model?: string | undefined;
        provider?: string | undefined;
        fallbackModels?: string[] | undefined;
        /** Per-run override of git-worktree isolation. Omitted → env default
         *  (WRONGSTACK_SDD_WORKTREES). false → run on the current branch. */
        worktrees?: boolean | undefined;
      };
    }
  | { type: 'abort'; payload: SessionScopedPayload }
  | { type: 'session.resume'; payload: { id: string } & SessionScopedPayload }
  | { type: 'session.new'; payload?: SessionScopedPayload }
  | { type: 'session.checkpoints'; payload?: SessionScopedPayload }
  | { type: 'session.rewind'; payload: { checkpointIndex: number } & SessionScopedPayload }
  | { type: 'context.clear'; payload?: SessionScopedPayload }
  | { type: 'context.compact'; payload: { aggressive: boolean } & SessionScopedPayload }
  | { type: 'context.repair'; payload?: SessionScopedPayload }
  | { type: 'context.debug'; payload?: SessionScopedPayload }
  | { type: 'context.modes.list'; payload?: SessionScopedPayload }
  | { type: 'context.mode.switch'; payload: { id: string } & SessionScopedPayload }
  | { type: 'context.mode.create'; payload: { id: string; name: string; description: string; thresholds: { warn: number; soft: number; hard: number }; preserveK: number; eliseThreshold: number } & SessionScopedPayload }
  | { type: 'context.mode.update'; payload: { id: string; name?: string | undefined; description?: string | undefined; thresholds?: { warn?: number | undefined; soft?: number | undefined; hard?: number | undefined } | undefined; preserveK?: number | undefined; eliseThreshold?: number | undefined } & SessionScopedPayload }
  | { type: 'context.mode.delete'; payload: { id: string } & SessionScopedPayload }
  | WSModelSwitch
  | { type: 'providers.list' }
  | { type: 'provider.models'; payload: { providerId: string } }
  | { type: 'providers.saved' }
  | { type: 'key.add'; payload: { providerId: string; label: string; apiKey: string } }
  | { type: 'key.update'; payload: { providerId: string; label: string; apiKey: string } }
  | { type: 'key.delete'; payload: { providerId: string; label: string } }
  | { type: 'key.set_active'; payload: { providerId: string; label: string } }
  | {
      type: 'provider.add';
      payload: { id: string; family: string; baseUrl?: string | undefined; apiKey?: string | undefined };
    }
  | { type: 'provider.remove'; payload: { providerId: string } }
  | { type: 'provider.clear_models'; payload: { providerId: string } }
  | { type: 'provider.undo_clear'; payload: { providerId: string; previousModels: string[] } }
  | {
      type: 'provider.update';
      payload: {
        id: string;
        family?: string | undefined;
        baseUrl?: string | undefined;
        envVars?: string[] | undefined;
        models?: string[] | undefined;
      };
    }
  | { type: 'provider.probe'; payload: { providerId: string; timeoutMs?: number | undefined } }
  | { type: 'auth.oauth.start'; payload: { kind: OAuthKind } }
  | { type: 'auth.oauth.code'; payload: { kind: OAuthKind; input: string } }
  | { type: 'auth.oauth.cancel'; payload: { kind: OAuthKind } }
  | { type: 'tools.list' }
  | { type: 'memory.list' }
  | { type: 'memory.remember'; payload: { text: string; scope?: MemoryScope | undefined } }
  | { type: 'memory.forget'; payload: { text: string; scope?: MemoryScope | undefined } }
  | { type: 'skills.list' }
  | { type: 'skills.content'; payload: { name: string; source: string } }
  | { type: 'prompts.list' }
  | { type: 'prompts.search'; payload: { query?: string | undefined; category?: string | undefined } }
  | { type: 'prompts.content'; payload: { slug: string } }
  | { type: 'prompts.favorite'; payload: { slug: string; favorite: boolean } }
  | { type: 'prompts.used'; payload: { slug: string } }
  | { type: 'prompts.recent' }
  | {
      type: 'prompts.create';
      payload: {
        title: string;
        content: string;
        description?: string | undefined;
        category?: string | undefined;
        tags?: string[] | undefined;
        variables?:
          | {
              name: string;
              description?: string | undefined;
              required?: boolean | undefined;
              multiline?: boolean | undefined;
              enum?: string[] | undefined;
            }[]
          | undefined;
      };
    }
  | { type: 'diag.get'; payload?: SessionScopedPayload }
  | { type: 'stats.get'; payload?: SessionScopedPayload }
  | { type: 'session.save'; payload?: SessionScopedPayload }
  | { type: 'sessions.list'; payload: { limit: number } & SessionScopedPayload }
  | { type: 'session.delete'; payload: { id: string } }
  | { type: 'modes.list' }
  | { type: 'mode.switch'; payload: { id: string } }
  | { type: 'files.list'; payload: { query?: string | undefined; limit?: number | undefined; path?: string | undefined } }
  | { type: 'files.tree'; payload: { path?: string | undefined } | Record<string, never> }
  | { type: 'files.read'; payload: { filePath: string } }
  | { type: 'files.write'; payload: { filePath: string; content: string } }
  | WSCompletionRequest
  | { type: 'todos.get'; payload?: SessionScopedPayload }
  | { type: 'todos.clear'; payload?: SessionScopedPayload }
  | { type: 'todos.remove'; payload: { id?: string | undefined; index?: number | undefined } & SessionScopedPayload }
  | { type: 'todo.update'; payload: { id: string; status?: 'pending' | 'in_progress' | 'completed' | undefined; activeForm?: string | undefined } & SessionScopedPayload }
  | { type: 'tasks.get'; payload?: SessionScopedPayload }
  | { type: 'task.update'; payload: { id: string; status: string } & SessionScopedPayload }
  | { type: 'plan.get'; payload?: SessionScopedPayload }
  | { type: 'plan.item.update'; payload: { target: string; status: 'open' | 'in_progress' | 'done' } & SessionScopedPayload }
  | { type: 'ping' }
  | { type: 'process.list' }
  | { type: 'process.kill'; payload: { pid: number } }
  | { type: 'process.killAll' }
  | { type: 'git.info' }
  | { type: 'git.changes' }
  | { type: 'git.diff'; payload: { path: string } }
  | { type: 'goal.get' }
  | { type: 'autonomy.switch'; payload: { mode: string } }
  | { type: 'prefs.update'; payload: Record<string, unknown> }
  | { type: 'prefs.get' }
  | { type: 'projects.list' }
  | { type: 'projects.add'; payload: { root: string; name?: string | undefined } }
  | { type: 'projects.select'; payload: { root: string; name?: string | undefined } }
  | { type: 'working_dir.set'; payload: { path: string } }
  | { type: 'shell.open'; payload: { path: string; target: 'terminal' | 'file-manager' } }
  | WSCollabJoin
  | WSCollabLeave
  | WSCollabAnnotate
  | WSCollabResolve
  | WSCollabRequestPause
  | WSCollabResume
  | WSCollabGrantControl
  | WSCollabInjectTool
  | { type: 'mailbox.messages'; payload: { limit?: number | undefined; incompleteOnly?: boolean | undefined } }
  | { type: 'mailbox.agents'; payload: { onlineOnly?: boolean | undefined } | Record<string, never> }
  | { type: 'mailbox.clear' }
  | { type: 'mailbox.purge'; payload?: { completedMaxAgeMs?: number; incompleteMaxAgeMs?: number } | undefined }
  | { type: 'brain.status' }
  | { type: 'brain.risk'; payload: { level: string } }
  | { type: 'brain.ask'; payload: { question: string } }
  | { type: 'model.refine'; payload: { text: string } }
  | { type: 'skills.list' }
  | { type: 'skills.content'; payload: { name: string; source: string } }
  | { type: 'skills.install'; payload: { ref: string; global?: boolean } }
  | { type: 'skills.uninstall'; payload: { name: string; global?: boolean } }
  | { type: 'skills.update'; payload: { name?: string; global?: boolean } }
  | { type: 'skills.create'; payload: { name: string; description: string; scope: 'project' | 'global' } }
  | { type: 'skills.export'; payload?: Record<string, unknown> }
  | { type: 'skills.edit'; payload: { name: string; body: string } }
  // ── Design Studio client messages ────────────────────────────────────────────
  | { type: 'design.list' }
  | {
      type: 'design.use';
      payload: { kit: string; stack?: string | undefined; overrides?: Record<string, string> | undefined };
    }
  | { type: 'design.state' }
  | { type: 'design.set'; payload: { overrides: Record<string, string> } }
  | {
      type: 'design.materialize';
      payload?: { stack?: string | undefined; out?: string | undefined } | undefined;
    }
  | { type: 'design.verify' }
  // ── MCP client messages (requests to server) ─────────────────────────────────
  | { type: 'mcp.list' }
  | { type: 'mcp.add'; payload: { name: string; transport: string; description?: string; enabled?: boolean; command?: string; args?: string[]; env?: Record<string, string>; allowedTools?: string[] } }
  | { type: 'mcp.remove'; payload: { name: string } }
  | { type: 'mcp.update'; payload: { name: string; transport?: string; description?: string; enabled?: boolean; command?: string; args?: string[]; env?: Record<string, string>; allowedTools?: string[] } }
  | { type: 'mcp.wake'; payload: { name: string } }
  | { type: 'mcp.sleep'; payload: { name: string } }
  | { type: 'mcp.discover'; payload: { name: string } }
  | { type: 'mcp.enable'; payload: { name: string } }
  | { type: 'mcp.disable'; payload: { name: string } }
  | { type: 'mcp.restart'; payload: { name: string } }
  // ── Integrated terminal (node-pty) client messages ───────────────────────────
  | { type: 'terminal.create'; payload: { id: string; cols?: number | undefined; rows?: number | undefined } }
  | { type: 'terminal.input'; payload: { id: string; data: string } }
  | { type: 'terminal.resize'; payload: { id: string; cols: number; rows: number } }
  | { type: 'terminal.close'; payload: { id: string } }
  // ── Misc client messages ─────────────────────────────────────────────────────
  | { type: 'plan.template_use'; payload: { template: string } }
  | { type: 'webui.shutdown' };

export type WSServerMessage =
  | WSSessionStart
  | WSSessionEnd
  | WSTextDelta
  | WSThinkingDelta
  | WSToolUseStart
  | WSToolProgress
  | WSToolExecuted
  | WSIterationStarted
  | WSIterationCompleted
  | WSIterationLimitReached
  | WSProviderResponse
  | WSProviderRetry
  | WSProviderError
  | WSProviderFallback
  | WSProviderStreamError
  | WSRunResult
  | WSSessionStats
  | WSError
  | WSToolConfirmNeeded
  | WSTrustPersisted
  | WSToolLoopDetected
  | WSDelegateStarted
  | WSDelegateCompleted
  | WSContextDebug
  | WSContextCompacted
  | WSCompactionFailed
  | WSContextRepaired
  | WSContextPct
  | WSContextMaxContext
  | WSTokenThreshold
  | WSTokenCostEstimateUnavailable
  | WSContextModesList
  | WSContextModeChanged
  | WSToolsList
  | WSMemoryList
  | WSSkillsList
  | WSSkillContent
  | WSDesignList
  | WSDesignUse
  | WSDesignState
  | WSDesignSet
  | WSDesignMaterialize
  | WSDesignVerify
  | WSSkillsInstalled
  | WSSkillsUninstalled
  | WSSkillsUpdated
  | WSSkillsCreated
  | WSSkillsEdited
  | WSSkillsExported
  | WSDiagGet
  | WSStatsGet
  | WSSessionsList
  | WSProviderCatalog
  | WSProviderModels
  | WSSavedProviders
  | WSProviderProbe
  | WSKeyOperationResult
  | WSAuthOAuthStatus
  | WSFilesList
  | { type: 'files.tree'; payload: { root: string; tree: unknown[]; error?: string | undefined } }
  | { type: 'files.read'; payload: { filePath: string; content: string; error?: string | undefined } }
  | { type: 'files.written'; payload: { filePath: string; success: boolean; error?: string | undefined } }
  | WSCompletionResult
  | WSTodosUpdated
  | WSTodosCleared
  | { type: 'tasks.updated'; payload: { tasks: unknown[]; error?: string | undefined } }
  | { type: 'plan.updated'; payload: { plan: unknown | null; error?: string | undefined } }
  | WSModesList
  | WSAutoPhaseState
  | WSAutoPhaseProgress
  | WSAutoPhaseLifecycle
  | WSAutoPhaseList
  | { type: 'specs.list'; payload: { specs: unknown[] } }
  | { type: 'specs.detail'; payload: Record<string, unknown> }
  | { type: 'sdd.board.snapshot'; payload: Record<string, unknown> | null }
  | { type: 'sdd.board.list'; payload: { boards: unknown[] } }
  | {
      type: 'sdd.board.lifecycle_result';
      payload: {
        op: 'cleanup_worktrees' | 'rollback' | 'destroy';
        ok: boolean;
        removed?: number;
        reverted?: number;
        deleted?: string[];
        reason?: string;
      };
    }
  | { type: 'sdd.spec.snapshot'; payload: Record<string, unknown> }
  | { type: 'sdd.spec.agent_text'; payload: { text: string } }
  | { type: 'sdd.spec.error'; payload: { message: string } }
  | { type: 'sdd.run.started'; payload: { runId: string } }
  | WSEternalIteration
  | WSAgentTimelineMessage
  | WSAgentStatusChanged
  | { type: 'subagent.event'; payload: SessionScopedPayload & Record<string, unknown> & { kind: string } }
  | WSWorktreeState
  | WSWorktreeEvent
  | WSWorktreeOrphans
  | WSWorktreeCleanupResult
  | WSWorktreeMergeResult
  | WSWorktreeDiffResult
  | WSCollabState
  | WSCollabParticipantJoined
  | WSCollabParticipantLeft
  | WSCollabEvent
  | WSCollabAnnotationAdded
  | WSCollabAnnotationResolved
  | WSCollabPauseGranted
  | WSCollabPauseReleased
  | WSCollabInjectionGranted
  | { type: 'session.checkpoints'; payload: { checkpoints: Array<{ index: number; iteration: number; timestamp: string; label: string; messageCount: number; tokens: number }> } }
  | { type: 'goal.updated'; payload: Record<string, unknown> | null }
  | { type: 'prefs.updated'; payload: Record<string, unknown> }
  | { type: 'client.status_update'; payload: Record<string, unknown> }
  | { type: 'sessions.status_update'; payload: { sessions: unknown[] } }
  | { type: 'mailbox.event'; payload: Record<string, unknown> & { event: string } }
  | { type: 'mailbox.received'; payload: Record<string, unknown> }
  | { type: 'mailbox.agent_registered'; payload: Record<string, unknown> }
  | { type: 'process.list'; payload: { processes: Array<{ pid: number; command: string; tool: string; startedAt: number; status: 'running' | 'exited' | 'killed'; protected?: boolean | undefined }> } }
  | { type: 'git.info'; payload: { branch: string; added: number; deleted: number; untracked: number; behind: number; ahead: number } }
  | { type: 'git.changes'; payload: { files: Array<{ path: string; status: string; added: number; deleted: number; staged: boolean }>; error?: string | undefined } }
  | { type: 'git.diff'; payload: { path: string; oldText?: string | undefined; newText?: string | undefined; binary?: boolean | undefined; tooLarge?: boolean | undefined; error?: string | undefined } }
  | { type: 'projects.list'; payload: { projects: Array<{ name: string; root: string; slug: string; lastSeen?: string | undefined }> } }
  | { type: 'projects.added'; payload: { name: string; root: string; slug: string; message: string } }
  | { type: 'projects.selected'; payload: { root: string; name: string; message: string } }
  | { type: 'working_dir.changed'; payload: { cwd: string; projectRoot: string } }
  | { type: 'brain.status'; payload: { maxAutoRisk: string; log: Array<{ at: number; kind: string; question: string; outcome: string }> } }
  | { type: 'brain.answer'; payload: SessionScopedPayload & { question: string; decision: { type: string; optionId?: string | undefined; text?: string | undefined; rationale?: string | undefined; reason?: string | undefined; prompt?: string | undefined } } }
  | { type: 'brain.event'; payload: SessionScopedPayload & Record<string, unknown> & { event: string } }
  | { type: 'session.damaged'; payload: { sessionId: string; detail: string } }
  | { type: 'session.rewound'; payload: SessionScopedPayload & { toPromptIndex: number; revertedFiles: string[]; removedEvents: number } }
  | { type: 'checkpoint.written'; payload: SessionScopedPayload & { promptIndex: number; promptPreview: string; ts: string; fileCount: number } }
  | { type: 'in_flight.started'; payload: SessionScopedPayload & { context: string; ts: string } }
  | { type: 'in_flight.ended'; payload: SessionScopedPayload & { reason: 'clean' | 'aborted' | 'recovered'; ts: string } }
  | { type: 'model.refine_result'; payload: { refined: string; english: string; error?: string | undefined } }
  // ── Coordinator / autonomous fleet events ──────────────────────────────
  | { type: 'coordinator.status'; payload: { status: 'idle' | 'running' | 'draining' | 'stopped'; mode?: string; subagentCount?: number; taskQueue?: { pending: number; running: number; completed: number; failed: number } } }
  | { type: 'coordinator.stats'; payload: { total: number; running: number; idle: number; stopped: number; inFlight: number; pending: number; completed: number; subagentStatuses?: Array<{ id: string; name: string; status: string; currentTask?: string }> } }
  | { type: 'fleet.concurrency_update'; payload: { fleetConcurrency: number; fleetConcurrencyMax: number } }
  | { type: 'budget.threshold_reached'; payload: { subagentId: string; taskId?: string; ts: number; kind: string; used: number; limit: number; timeoutMs: number } }
  | { type: 'budget.decision'; payload: { subagentId: string; kind: string; decision: 'extend' | 'deny'; extended?: { timeoutMs?: number; maxIterations?: number; maxToolCalls?: number } } }
  | { type: 'subagent.budget_extended'; payload: { subagentId: string; kind: string; extendedMs?: number; extendedTo?: number } }
  | { type: 'consensus.vote_initiated'; payload: { changeId: string; title: string; eligible: Array<{ agentId: string; agentName: string }> } }
  | { type: 'consensus.vote_cast'; payload: { changeId: string; voterId: string; value: 'approve' | 'reject' | 'abstain' } }
  | { type: 'consensus.vote_resolved'; payload: { changeId: string; result: 'approved' | 'rejected' | 'vetoed' | 'quorum_not_met'; approveCount: number; rejectCount: number } }
  | { type: 'task.pending'; payload: { taskId: string; description: string; priority?: number } }
  | { type: 'task.started'; payload: { taskId: string; subagentId: string } }
  | { type: 'task.completed'; payload: { taskId: string; subagentId: string; status: string; durationMs: number } }
  | { type: 'task.failed'; payload: { taskId: string; subagentId: string; error: string } }
  // ── MCP server events ───────────────────────────────────────────────────────
  | { type: 'mcp.list'; payload: { servers: Array<{ name: string; transport: string; status: string; enabled: boolean; description?: string; tools?: string[]; error?: string; pid?: number }> } }
  | { type: 'mcp.server.added'; payload: { server: { name: string; transport: string; status: string; enabled: boolean; description?: string; tools?: string[] } } }
  | { type: 'mcp.server.removed'; payload: { name: string } }
  | { type: 'mcp.server.updated'; payload: { server: { name: string; transport: string; status: string; enabled: boolean; description?: string; tools?: string[] } } }
  | { type: 'mcp.server.discovered'; payload: { name: string; tools: string[] } }
  | { type: 'mcp.server.sleeping'; payload: { name: string } }
  | { type: 'mcp.server.waking'; payload: { name: string } }
  | { type: 'mcp.server.connected'; payload: { name: string; pid?: number; toolCount?: number } }
  | { type: 'mcp.server.reconnected'; payload: { name: string; toolCount: number } }
  | { type: 'mcp.server.disconnected'; payload: { name: string; reason: string } }
  | { type: 'mcp.server.error'; payload: { name: string; error: string } }
  | { type: 'mcp.operation_result'; payload: { success: boolean; message: string } }
  | { type: 'mailbox.cleared'; payload: { error?: string | undefined } }
  | { type: 'mailbox.purged'; payload: Record<string, unknown> & { error?: string | undefined } }
  // ── Integrated terminal (node-pty) server events ──────────────────────────────
  | { type: 'terminal.output'; payload: { id: string; data: string } }
  | { type: 'terminal.exit'; payload: { id: string; exitCode: number; signal?: number | undefined } };

// Helper to broadcast to all clients
export type BroadcastFn = (msg: WSServerMessage) => void;

/** Narrow type for CollabPanel event handlers — only collab-related messages + errors. */
export type CollabPanelMessage =
  | WSCollabState
  | WSCollabParticipantJoined
  | WSCollabParticipantLeft
  | WSCollabAnnotationAdded
  | WSCollabAnnotationResolved
  | WSCollabPauseGranted
  | WSCollabPauseReleased
  | WSCollabInjectionGranted
  | WSError;

// ── Collaboration (Phase 1 of idea #13) ────────────────────────────────────
// Passive read-only session observer: a second client can join an active
// agent run and watch a live mirror of the kernel's iteration / tool /
// subagent events. Annotation and control hand-off land in Phase 2/3.

/**
 * Roles a collaboration participant can hold. The string union is the
 * wire contract — adding new roles (e.g. `controller`) in later phases
 * is a backward-compatible widening of this type as long as the server
 * gracefully rejects roles it does not yet implement.
 */
export type CollabRole = 'observer' | 'annotator' | 'controller';

// ── Client → Server ───────────────────────────────────────────────────────

export interface WSCollabJoin {
  type: 'collab.join';
  payload: { sessionId: string; role: CollabRole };
}

export interface WSCollabLeave {
  type: 'collab.leave';
  payload: { sessionId: string };
}

/**
 * Annotate a specific event in the session log. The `atEventIndex`
 * is a stable pointer the UI can scroll to / highlight. The server
 * persists the annotation and broadcasts it to every participant
 * in the same session, including the author.
 */
export interface WSCollabAnnotate {
  type: 'collab.annotate';
  payload: { sessionId: string; atEventIndex: number; text: string };
}

/** Mark an existing annotation as resolved. */
export interface WSCollabResolve {
  type: 'collab.resolve';
  payload: { sessionId: string; annotationId: string };
}

// ── Server → Client ───────────────────────────────────────────────────────

/** Sent on connect and every 2s while at least one participant is watching. */
export interface WSCollabState {
  type: 'collab.state';
  payload: {
    sessionId: string;
    participants: Array<{
      participantId: string;
      role: CollabRole;
      joinedAt: string;
    }>;
  };
}

/** Broadcast when a new participant joins the session. */
export interface WSCollabParticipantJoined {
  type: 'collab.participant.joined';
  payload: {
    participantId: string;
    sessionId: string;
    role: CollabRole;
    joinedAt: string;
  };
}

/** Broadcast when a participant leaves (explicit leave or WS close/error). */
export interface WSCollabParticipantLeft {
  type: 'collab.participant.left';
  payload: { participantId: string; sessionId: string };
}

/** Broadcast when a new annotation is added. Sent to all participants. */
export interface WSCollabAnnotationAdded {
  type: 'collab.annotation.added';
  payload: {
    sessionId: string;
    annotation: {
      id: string;
      atEventIndex: number;
      authorId: string;
      authorRole: 'annotator';
      text: string;
      createdAt: string;
      resolved: boolean;
    };
  };
}

/** Broadcast when an annotation is resolved. Sent to all participants. */
export interface WSCollabAnnotationResolved {
  type: 'collab.annotation.resolved';
  payload: {
    sessionId: string;
    annotationId: string;
    resolvedBy: string;
    resolvedAt: string;
  };
}

// ── Controller (Phase 3) ───────────────────────────────────────────────────
// The `controller` role can request a pause on the agent loop, resume
// it, and (later) inject manual tool calls. The pause/resume state is
// process-wide (single agent run per webui); the bus carries it.

/** Client → server: controller asks the agent loop to pause before the next tool call. */
export interface WSCollabRequestPause {
  type: 'collab.request_pause';
  payload: { sessionId: string };
}

/** Client → server: controller (or owner) clears the pause. */
export interface WSCollabResume {
  type: 'collab.resume';
  payload: { sessionId: string };
}

/**
 * Client → server: owner hands the controller role to a different
 * participant. The current implementation is metadata-only — the
 * existing controller's effective permissions don't change yet;
 * the wire is reserved for a future iteration where per-participant
 * RBAC becomes dynamic.
 */
export interface WSCollabGrantControl {
  type: 'collab.grant_control';
  payload: { sessionId: string; toParticipant: string };
}

/** Server → client: the bus transitioned to paused (controller's pause took effect). */
export interface WSCollabPauseGranted {
  type: 'collab.pause.granted';
  payload: {
    sessionId: string;
    pausedBy: string;
    pausedAt: string;
    /**
     * How long until the middleware auto-resumes (in ms). Clients
     * can render a countdown. Defaults to 60_000 on the server.
     */
    autoResumeInMs: number;
  };
}

/** Server → client: the bus transitioned back to running. */
export interface WSCollabPauseReleased {
  type: 'collab.pause.released';
  payload: {
    sessionId: string;
    /** 'controller' when a participant asked; 'timeout' when the middleware fired auto-resume. */
    reason: 'controller' | 'timeout';
    at: string;
  };
}

/**
 * Generic envelope wrapping a kernel event mirrored to observers.
 * `kind` matches the original kernel event name (e.g. `tool.started`),
 * `payload` is the original event payload (best-effort serialized),
 * `at` is the broadcast timestamp.
 *
 * `replay` is true when the event was sent from the on-disk session
 * log to a late-joining observer (Phase 1.5). Live events leave it
 * undefined. Clients use the flag to render a "history" affordance
 * (e.g. dim the styling or annotate the timestamp as "[joined late]").
 */
export interface WSCollabEvent {
  type: 'collab.event';
  payload: { kind: string; payload: unknown; at: string; replay?: boolean | undefined };
}

// ── Phase 4: manual tool-call injection (controller only) ───────────────────

/**
 * Client → server: a controller injects a synthetic tool_result for
 * the given tool_use_id. The next time the agent's toolCall pipeline
 * sees that id, the real tool is skipped and the injected content
 * is used. The injection is one-shot — consumed on first match.
 */
export interface WSCollabInjectTool {
  type: 'collab.inject_tool';
  payload: {
    sessionId: string;
    toolUseId: string;
    /** String or JSON-serializable value. */
    content: unknown;
    isError: boolean;
    /** Free-form context surfaced in the broadcast and audit log. */
    reason: string;
  };
}

/**
 * Server → client: an injection was queued or consumed. Sent to
 * every participant so observers can show "the controller just
 * replaced the tool result for tool X".
 */
export interface WSCollabInjectionGranted {
  type: 'collab.injection.granted';
  payload: {
    sessionId: string;
    toolUseId: string;
    toolName: string;
    authorId: string;
    reason: string;
    isError: boolean;
    /** 'queued' or 'consumed' — the bus does both. */
    phase: 'queued' | 'consumed';
    at: string;
  };
}
