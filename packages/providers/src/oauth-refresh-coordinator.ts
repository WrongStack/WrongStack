/**
 * OAuthRefreshCoordinator — shared refresh state + single-flight machinery
 * for OAuth providers.
 *
 * All three OAuth providers in this package (`openai-codex`, `anthropic-oauth`,
 * `github-copilot`) implemented the same pattern by hand:
 *   1. Hold a refresh token, expiry, and `refreshFn` callable
 *   2. Wrap the refresh call in `createSingleFlightRefresh` so concurrent
 *      requests share one upstream call + one persistence callback
 *   3. Re-check the expiry before each request, refresh on 401
 *
 * The refresh-token storage LOCATION differs (Codex rotates its refresh
 * token on every refresh; Anthropic + Copilot do not), and the `onRefresh`
 * payload shape differs (Codex includes `accountId`), so this is a
 * composition helper, not a base class — each provider wires it up with
 * two callbacks that describe the host-specific pieces.
 *
 * Why composition instead of inheritance: the three providers extend
 * different base classes (`WireAdapter` for codex, `WireFormatProvider`
 * for the other two), so a shared base class would compete with
 * existing inheritance. Composition also keeps each provider's token
 * fields (`this.access`, `this.refresh`, `this.expiresAt`, …) where the
 * build headers/body methods can read them directly — moving the state
 * into a mixin would force every read site to go through getters.
 */

import { createSingleFlightRefresh } from './oauth-refresh.js';

/** Default skew applied to expiry checks — refresh this many ms before stated expiry. */
export const DEFAULT_REFRESH_SKEW_MS = 60_000;

/**
 * Derived token shape the coordinator tracks after projecting upstream
 * tokens. `refreshKey` is only returned if the host rotates it (Codex
 * does; Anthropic + Copilot return the same key).
 */
export interface DerivedTokens {
  accessToken: string;
  expiresAt: number;
  refreshKey?: string | undefined;
}

/**
 * Host-supplied callbacks that describe how to project, apply, and
 * persist tokens for a specific provider. Extracted from the full
 * coordinator options so they can be documented, tested, and reused
 * independently of the lifecycle state (`initialRefreshKey`,
 * `initialExpiresAt`, `label`, `refreshSkewMs`).
 *
 * Each provider wires these callbacks to its own token fields:
 *
 * ```ts
 * new OAuthRefreshCoordinator<Tokens, Payload>({
 *   ...lifecycleState,
 *   hooks: {
 *     refreshFn: (key, signal) => this.refreshFn(key, signal),
 *     projectTokens: (t) => ({ accessToken: t.access, ... }),
 *     applyTokens: (derived) => { this.access = derived.accessToken; ... },
 *     formatPayload: (_t, derived) => ({ accessToken: derived.accessToken, ... }),
 *     onRefresh: opts.onRefresh,
 *   },
 * });
 * ```
 */
export interface RefreshHooks<TTokens, TPayload> {
  /** The upstream refresh call. */
  refreshFn: (refreshKey: string, signal?: AbortSignal) => Promise<TTokens>;

  /**
   * Project the upstream tokens into the access token + expiry pair this
   * coordinator tracks. Return `refreshKey` only if the host rotates it.
   */
  projectTokens: (tokens: TTokens) => DerivedTokens;

  /**
   * Apply the projected values back to the host's mutable state (e.g.
   * `this.access = derived.accessToken`). Called inside the single-flight
   * slot, exactly once per actual refresh.
   */
  applyTokens: (derived: DerivedTokens) => void;

  /**
   * Map the upstream's token shape into the host's payload shape. Called
   * AFTER `applyTokens`, so the payload can read host state that was
   * mutated by `applyTokens` (e.g. Codex's `accountId` re-derivation).
   */
  formatPayload: (tokens: TTokens, derived: DerivedTokens) => TPayload;

  /**
   * Persistence callback. Fires once per actual refresh (single-flighted),
   * with the host-shaped payload derived from the new tokens.
   */
  onRefresh?: ((payload: TPayload) => void) | undefined;
}

export interface OAuthRefreshCoordinatorOptions<TTokens, TPayload> {
  /**
   * Initial refresh key — the value passed to `refreshFn` to mint a new
   * token pair. Most providers pass this from constructor credentials.
   * May be `undefined` for providers that mint the first token without a
   * refresh (e.g. Copilot starts with an empty copilot token and mints on
   * first request).
   */
  initialRefreshKey: string | undefined;
  /** Initial expiry in epoch ms. `undefined` means "refresh on every request". */
  initialExpiresAt: number | undefined;
  /** How many ms before stated expiry we should proactively refresh. */
  refreshSkewMs?: number;
  /**
   * Human-readable label used in error messages when the refresh key is
   * missing — e.g. "Codex OAuth", "Anthropic OAuth", "GitHub Copilot".
   */
  label: string;
  /** Host-supplied callbacks for projecting, applying, and persisting tokens. */
  hooks: RefreshHooks<TTokens, TPayload>;
}

export class OAuthRefreshCoordinator<TTokens, TPayload> {
  /** Single-flight wrapper around the refresh call. */
  private readonly singleFlight: ReturnType<typeof createSingleFlightRefresh<TTokens>>;
  private readonly hooks: RefreshHooks<TTokens, TPayload>;
  private readonly refreshSkewMs: number;
  private readonly label: string;

  /** Current refresh key. Updated after providers rotate it. */
  private refreshKey: string | undefined;

  /** Last refreshed expiry, in epoch ms. */
  private expiresAt: number | undefined;

  constructor(opts: OAuthRefreshCoordinatorOptions<TTokens, TPayload>) {
    this.hooks = opts.hooks;
    this.refreshSkewMs = opts.refreshSkewMs ?? DEFAULT_REFRESH_SKEW_MS;
    this.label = opts.label;
    this.expiresAt = opts.initialExpiresAt;
    this.refreshKey = opts.initialRefreshKey;
    this.singleFlight = createSingleFlightRefresh<TTokens>((signal) => this.performRefresh(signal));
  }

  /**
   * Update the cached expiry when the host pre-loads a token from
   * persistent storage. Used by the constructor's initial-state path
   * for providers that store their own expiry separately.
   */
  setExpiresAt(expiresAt: number | undefined): void {
    this.expiresAt = expiresAt;
  }

  /**
   * Returns true when the token is known-stale or never-seen (no expiry
   * recorded). Callers should refresh before the next request.
   */
  isStale(): boolean {
    if (this.expiresAt === undefined || !Number.isFinite(this.expiresAt)) return true;
    return Date.now() >= this.expiresAt - this.refreshSkewMs;
  }

  /**
   * No-op if a refresh key is unavailable, the cached expiry is still
   * fresh, OR a refresh is already in flight (which will mutate the
   * expiry once it resolves). Otherwise, kicks off a refresh.
   */
  async ensureFreshToken(signal: AbortSignal): Promise<void> {
    if (!this.refreshKey) return;
    if (!this.isStale()) return;
    await this.doRefresh(signal);
  }

  /**
   * Force a refresh. Returns immediately if no refresh key is available;
   * otherwise coalesces with any in-flight refresh so concurrent callers
   * share one upstream call.
   */
  async doRefresh(signal: AbortSignal): Promise<void> {
    if (!this.refreshKey) return;
    await this.singleFlight.refresh(signal);
  }

  /**
   * The single-flighted work function: call the upstream, mutate host
   * state, fire the persistence callback. Concurrent callers share one
   * execution — upstream hit once, host state mutates once, `onRefresh`
   * fires once per actual refresh. Always go through `singleFlight` so
   * `runRefresh` calls participate in the same single-flight slot as
   * `doRefresh` / `ensureFreshToken` (otherwise direct callers would race
   * past the coalescing and the upstream would be hit twice).
   */
  runRefresh(signal?: AbortSignal): Promise<TTokens> {
    return this.singleFlight.refresh(signal);
  }

  /**
   * Internal: the actual work performed inside the single-flight slot.
   * Always called via `singleFlight.refresh()` so concurrent callers share
   * one execution. Exposed as a method (not a closure) so the per-host
   * error message (`${this.label}: refresh key missing`) reads `this`.
   */
  private async performRefresh(signal?: AbortSignal): Promise<TTokens> {
    const refreshKey = this.refreshKey;
    if (!refreshKey) {
      throw new Error(`${this.label}: refresh key missing`);
    }
    const tokens = await this.hooks.refreshFn(refreshKey, signal);
    const derived = this.hooks.projectTokens(tokens);
    this.expiresAt = derived.expiresAt;
    if (derived.refreshKey) this.refreshKey = derived.refreshKey;
    this.hooks.applyTokens(derived);
    this.hooks.onRefresh?.(this.hooks.formatPayload(tokens, derived));
    return tokens;
  }
}
