import type { SessionScopedPayload } from './protocol-core.js';

export interface WSDiagGet {
  type: 'diag.get';
  payload: SessionScopedPayload & {
    provider: string;
    model: string;
    cwd: string;
    sessionId: string;
    tools: { count: number; names: string[] };
    /** Provider maxTools limit (0 = no limit). */
    maxTools: number;
    /** Tools dropped from requests because they exceed maxTools. */
    droppedTools: number;
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
    usage: {
      input: number;
      output: number;
      cacheRead?: number | undefined;
      cacheWrite?: number | undefined;
    };
    cache: {
      readTokens: number;
      writeTokens: number;
      hitRatio: number;
      providers?: Array<{
        provider: string;
        input: number;
        cacheRead: number;
        cacheWrite: number;
        hitRatio: number;
      }>;
    } | null;
    currentRequest?: { input: number; cacheRead: number; cacheWrite: number } | undefined;
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

export interface WSSessionInspect {
  type: 'session.inspect';
  payload: {
    id: string;
    title?: string | undefined;
    name?: string | undefined;
    model?: string | undefined;
    provider?: string | undefined;
    startedAt?: string | undefined;
    endedAt?: string | undefined;
    tokenTotal?: number | undefined;
    outcome?: 'completed' | 'error' | 'timeout' | 'aborted' | undefined;
    messageCount?: number | undefined;
    iterationCount?: number | undefined;
    toolCallCount?: number | undefined;
    toolErrorCount?: number | undefined;
    fileChangeCount?: number | undefined;
    compactionCount?: number | undefined;
    toolBreakdown?: Record<string, number> | undefined;
    events?: Array<{ ts: string; type: string; label: string; detail: string }> | undefined;
    fileEvents?:
      | Array<{ operation: string; filePath: string; toolName: string; ts: string }>
      | undefined;
    lastUserMessage?: string | undefined;
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

export interface ProviderCatalogModelMatch {
  providerId: string;
  providerName: string;
  modelId: string;
  name: string;
  description?: string | undefined;
  releaseDate?: string | undefined;
  contextWindow?: number | undefined;
  maxOutput?: number | undefined;
  inputCost?: number | undefined;
  outputCost?: number | undefined;
  capabilities: string[];
}

export interface WSCatalogModelSearchResult {
  type: 'provider.models.search_result';
  payload: {
    query: string;
    matches: ProviderCatalogModelMatch[];
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
      /** Per-model metadata. Mirrors CustomModelDefinition + ME-2 modelsDev. */
      customModels?:
        | Record<
            string,
            {
              name?: string | undefined;
              maxOutput?: number | undefined;
              capabilities?:
                | Partial<{
                    tools: boolean;
                    parallelTools: boolean;
                    vision: boolean;
                    streaming: boolean;
                    promptCache: boolean;
                    systemPrompt: boolean;
                    jsonMode: boolean;
                    reasoning: boolean;
                    maxContext: number;
                    maxOutput: number;
                    cacheControl: string;
                  }>
                | undefined;
              modelsDev?: Record<string, unknown> | undefined;
            }
          >
        | undefined;
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
    /**
     * The tab whose request this answers.
     *
     * This is the server's general-purpose result channel — provider keys,
     * prefs, session operations, MCP, git, shell, the worklist — and it used
     * to carry no session at all. One socket serves up to four tabs, so a
     * background tab's failure toast popped on whichever tab was in front
     * while the tab that actually failed showed nothing.
     *
     * Optional because a result raised outside a dispatch (a watcher, a
     * timer) genuinely has no asking tab; those still fall back to the tab in
     * front. The server stamps this at the dispatch boundary — see
     * `runWithDispatchSession` in webui-server/ws-utils.ts, and
     * docs/audit/webui-full-review-2026-09-03.md B-05.
     */
    sessionId?: string | undefined;
  };
}

export interface WSModelSwitchResult {
  type: 'model.switch_result';
  payload: {
    requestId?: string | undefined;
    success: boolean;
    message: string;
    provider?: string | undefined;
    model?: string | undefined;
    previousProvider?: string | undefined;
    previousModel?: string | undefined;
    /** A leader run was active when the atomic switch committed. */
    runActive: boolean;
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
    phase:
      | 'awaiting_browser'
      | 'awaiting_code'
      | 'exchanging'
      | 'fetching_models'
      | 'success'
      | 'error';
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
      /** Board-derived titles of the unfinished work this row waits on. */
      blockedBy?: string[] | undefined;
      kanbanBoardId?: string | undefined;
      kanbanTaskId?: string | undefined;
    }>;
  };
}

export interface WSTodosCleared {
  type: 'todos.cleared';
  payload?: Record<string, never>;
}
