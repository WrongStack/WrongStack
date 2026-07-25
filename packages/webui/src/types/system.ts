import type { SessionScopedPayload } from './protocol-core.js';

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
    usage: {
      input: number;
      output: number;
      cacheRead?: number | undefined;
      cacheWrite?: number | undefined;
    };
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
    }>;
  };
}

export interface WSTodosCleared {
  type: 'todos.cleared';
  payload?: Record<string, never>;
}
