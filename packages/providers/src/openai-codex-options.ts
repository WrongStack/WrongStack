import type { Capabilities, ProviderApiKey, ReasoningEffort } from '@wrongstack/contracts/types';
import type { CodexResponseMetadata, CodexWebSocketFactory } from './codex-websocket.js';
import type { CodexTokens } from './oauth/codex-protocol.js';
import type { CodexLiveModel } from './openai-codex-model-policy.js';
import type { WireAdapterStreamOptions } from './wire-adapter.js';

/**
 * Token shape returned by a refresh. Structurally the shared
 * {@link CodexTokens}; kept as a named alias because it is part of this
 * package's published surface.
 */
export type CodexOAuthTokens = CodexTokens;

// ── Provider ────────────────────────────────────────────────────────────────

export interface CodexCredentials {
  /** The OAuth access token (a JWT). */
  accessToken: string;
  /** The refresh token, used to mint a new access token before/at expiry. */
  refreshToken?: string | undefined;
  /** Access-token expiry, epoch ms. When absent, refresh only fires on 401. */
  expiresAt?: number | undefined;
  /** Cached ChatGPT account id. Re-derived from the live token when missing. */
  accountId?: string | undefined;
}

export interface OpenAICodexProviderOptions {
  credentials: CodexCredentials;
  baseUrl?: string | undefined;
  id?: string | undefined;
  fetchImpl?: typeof fetch | undefined;
  capabilities?: Partial<Capabilities> | undefined;
  streamOpts?: WireAdapterStreamOptions | undefined;
  /**
   * Persist rotated tokens after a successful refresh. The CLI wires this to
   * write back to the encrypted config so the new access/refresh pair survive
   * the session.
   */
  onRefresh?:
    | ((creds: {
        accessToken: string;
        refreshToken: string;
        expiresAt: number;
        accountId: string | undefined;
      }) => void)
    | undefined;
  /** Observe response metadata surfaced inside the Responses stream. */
  onResponseMetadata?: ((metadata: CodexResponseMetadata) => void) | undefined;
  /**
   * Receives the account's picker-visible model list every time the live
   * `/codex/models` catalog is re-read, so a host can keep its stored list in
   * step with the backend.
   *
   * The stored list used to be written once, at login, and never again: an
   * account that gained `gpt-6-astra` a week later kept whatever the login
   * happened to resolve. This rides the catalog probe the transport already
   * performs at request boundaries, so keeping the list live costs no extra
   * request.
   */
  onModels?: ((models: CodexLiveModel[]) => void) | undefined;
  /** Enable the Responses WebSocket transport; defaults on for the real fetch. */
  webSocket?: boolean | undefined;
  /** Injectable WebSocket factory for hosts and tests. */
  webSocketFactory?: CodexWebSocketFactory | undefined;
  /** Best-effort WebSocket prewarm before the first real response. */
  webSocketPrewarm?: boolean | undefined;
  /**
   * The stored account entry this transport was built from. With it, and a
   * host-installed subscription refresh transaction, every refresh runs under
   * the config file lock against the entry as it is ON DISK: a token another
   * process already rotated is adopted instead of replayed, and the rotation is
   * persisted atomically with the exchange. Codex rotates its refresh token on
   * every use, so two processes (TUI + WebUI, an editor's `wstack acp`)
   * refreshing from the same stored pair used to end with one of them getting
   * `refresh_token_reused` and the account needing a fresh sign-in.
   */
  credential?: ProviderApiKey | undefined;
  /** Override the refresh call (tests). */
  refreshFn?:
    | ((refreshToken: string, signal?: AbortSignal) => Promise<CodexOAuthTokens>)
    | undefined;
  /**
   * Reasoning effort for the Codex (gpt-5.x) reasoning models. Sent as
   * `reasoning.effort` with `summary: 'auto'` so chain-of-thought streams back
   * as thinking deltas. Request-level reasoning settings override this default.
   * Default 'medium'. Set 'none' to omit reasoning entirely.
   */
  reasoningEffort?: ReasoningEffort | undefined;
  /** Used only when the live model catalog explicitly supports verbosity. */
  textVerbosity?: 'low' | 'medium' | 'high' | undefined;
}
