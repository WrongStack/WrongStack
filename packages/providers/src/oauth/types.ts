/**
 * Public types for the headless OAuth login engine.
 *
 * The engine drives a subscription sign-in (ChatGPT / Claude / Copilot) to
 * completion and returns a {@link OAuthLoginOutcome} — a persistence-agnostic
 * description of the provider + credential to save. The caller persists it
 * with whatever config store it owns (CLI `mutateConfigProviders`, WebUI
 * provider stores), so the engine never touches config files.
 */

import type { ModelsRegistry, ProviderApiKey } from '@wrongstack/core';

/** Which subscription login to run. */
export type OAuthKind = 'chatgpt' | 'claude' | 'copilot';

/** Progress phase surfaced to the caller while a flow is in motion. */
export type OAuthPhase =
  | 'awaiting_browser'
  | 'awaiting_code'
  | 'exchanging'
  | 'fetching_models'
  | 'success'
  | 'error';

/**
 * Everything needed to persist a successful login. Free of any IO — the
 * caller upserts `apiKey` onto the provider keyed by `providerId` and sets the
 * `family` / `baseUrl` / `models` fields.
 */
export interface OAuthLoginOutcome {
  /** Canonical provider id: openai-codex | anthropic-oauth | github-copilot. */
  providerId: string;
  /** Wire family to stamp on the provider config. */
  family: string;
  /** Default base URL (only applied when the provider has none yet). */
  baseUrl: string;
  /** Discovered model ids (live backend → catalog → fallback). */
  models: string[];
  /** The credential to upsert (label `oauth-default`, `authMethod: 'oauth'`). */
  apiKey: ProviderApiKey;
}

/**
 * A live login session. For loopback flows (chatgpt/claude) the session is
 * already listening on the callback port; for the device flow (copilot) it
 * carries the user code to display. The caller surfaces `authorizeUrl` /
 * `userCode`, then awaits {@link waitForCompletion}.
 */
export interface OAuthSession {
  kind: OAuthKind;
  /** Canonical provider id the outcome will be stored under. */
  providerId: string;
  /** True when a loopback listener bound; false → manual paste required. */
  bound: boolean;
  /** Loopback flows (chatgpt/claude): URL to open in the browser. */
  authorizeUrl?: string | undefined;
  /** Device flow (copilot): URL the user visits to enter the code. */
  verificationUri?: string | undefined;
  /** Device flow (copilot): the code the user types at `verificationUri`. */
  userCode?: string | undefined;
  /**
   * Drive the flow to completion: await the loopback callback (chatgpt/claude)
   * or poll the device endpoint (copilot), then exchange + fetch models.
   * Resolves with the outcome, or `null` if cancelled / expired.
   */
  waitForCompletion(signal?: AbortSignal): Promise<OAuthLoginOutcome | null>;
  /**
   * Manual-paste fallback for loopback flows (port busy / remote browser):
   * submit the pasted redirect URL or code. Throws on the device flow.
   */
  completeWithCode(input: string, signal?: AbortSignal): Promise<OAuthLoginOutcome>;
  /** Tear down any loopback listener / cancel a pending wait. */
  close(): void;
}

/** Optional dependencies for {@link OAuthKind} flows. */
export interface BeginOAuthDeps {
  /** Used by the ChatGPT flow's tier-2 model lookup (best-effort). */
  modelsRegistry?: ModelsRegistry | undefined;
}
