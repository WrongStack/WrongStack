import type { EventBus } from '@wrongstack/contracts/kernel/events';
import type { Config } from '@wrongstack/contracts/types/config';
import type { Logger } from '@wrongstack/contracts/types/logger';
import type { Provider } from '@wrongstack/contracts/types/provider';
import type { ProviderStatusTrackerPort } from '@wrongstack/contracts/types/provider-status';
import type { FallbackProfileManager } from './fallback-profile-manager.js';

export interface FallbackModelDeps {
  /** Returns the live config (re-read each turn so `/model` switches are honored). */
  getConfig: () => Config;
  /** Shared live manager from the runtime container. */
  fallbackProfileManager?: FallbackProfileManager | undefined;
  /** Live named profile selected for this worker (for example by `/setmodel`). */
  getFallbackProfile?: (() => string | undefined) | undefined;
  /** Live task/role-specific chain. Explicit task fallbacks may return a stable list. */
  getFallbackModels?: (() => readonly string[] | undefined) | undefined;
  /** Worker-local primary; prevents a subagent fallback from restoring the leader model. */
  getPrimaryTarget?: (() => { providerId: string; model: string } | undefined) | undefined;
  /** When true, only the explicitly supplied fallback chain may be attempted. */
  isClosedWorld?: (() => boolean) | undefined;
  /**
   * Builds a credential-resolved Provider for a provider id (alias-resolved),
   * WITHOUT persisting anything to config/configStore. Supplied by the boot
   * path, which shares this with the `/model` switch logic. May be async — the
   * subagent host resolves a provider's real context window asynchronously.
   */
  buildProvider: (providerId: string, modelId?: string | undefined) => Provider | Promise<Provider>;
  /**
   * Called after the active model changes (a fallback hop or the primary
   * restore) so the host can refresh the auto-compaction / context-window
   * denominator — important when a fallback crosses to a smaller-window model.
   */
  onModelSwitch?: (providerId: string, modelId: string) => void | Promise<void>;
  events: EventBus;
  /** Optional — warnings about un-buildable fallback providers. */
  logger?: Logger | undefined;
  /**
   * Base cooldown after the configured primary fails with a fallback-worthy
   * error. While active, `beforeRun` leaves the context on the working fallback
   * instead of retrying the primary at the start of every turn. Default: 60s.
   * Set 0 to preserve the legacy "probe primary every turn" behavior.
   */
  primaryCooldownMs?: number | undefined;
  /**
   * Maximum exponential cooldown for repeated failed primary probes. Default:
   * 10 minutes. Ignored when `primaryCooldownMs` is 0.
   */
  primaryCooldownMaxMs?: number | undefined;
  /**
   * Number of consecutive primary successes required to fully reset the
   * failure ladder after a cooldown expiry. Set 1 for the legacy "one
   * success fully resets" behavior; higher values prevent an
   * intermittently-available primary from causing model bouncing — the
   * streak is retained across a single success so the next failure
   * continues the exponential backoff instead of restarting at 1.
   * Default: 2.
   */
  primaryRecoverySuccesses?: number | undefined;
  /**
   * Minimum number of turns to dwell on a working fallback before the
   * primary becomes eligible for a half-open probe — even if the cooldown
   * timer has already expired. Default: 0 (timer alone governs).
   * Set to e.g. 3 to require three full turns on the fallback before the
   * system risks switching back to the primary.
   */
  stickyFallbackTurns?: number | undefined;
  /** Test hook for deterministic cooldown assertions. */
  now?: (() => number) | undefined;
  /**
   * Shared provider/model status tracker. When set, the extension records
   * failures and successes in the tracker, and skips blocked entries in
   * the fallback chain.
   */
  statusTracker?: ProviderStatusTrackerPort | undefined;
  /**
   * When set, the fallback chain pauses BEFORE attempting any fallback entry
   * and emits `provider.fallback_pending`. The gate waits for a choice
   * (manual pick or auto-countdown) before proceeding. This lets the UI show
   * a modal with a countdown and manual model selection on every fallback hop.
   *
   * Returns the chosen model reference, or `null` to auto-switch to the next
   * candidate (countdown expired or user accepted the default).
   */
  fallbackGate?: FallbackGateFn | undefined;
  /**
   * Seconds the UI counts down before auto-switching. Default: 7.
   */
  fallbackGateSeconds?: number | undefined;
}

/**
 * Gate function invoked when the fallback chain is about to engage. It should
 * emit `provider.fallback_pending` on the supplied `events` bus — carrying a
 * unique `requestId` and a `timestamp` in the payload — wait for the UI's
 * `provider.fallback_choice` emission echoing that `requestId` (or the
 * countdown), and resolve with the selected model or `null` to accept the
 * default next. See `createFallbackGate` in the CLI wiring for a reference
 * implementation.
 */
export type FallbackGateFn = (params: {
  events: EventBus;
  sessionId: string | undefined;
  from: { providerId: string; model: string };
  status: number;
  candidates: Array<{ providerId: string; model: string }>;
  autoSwitchSeconds: number;
  /**
   * Correlation id owned by the caller (the fallback-model extension). The
   * gate MUST echo it in `provider.fallback_pending` so the UI's choice
   * reply and the eventual `provider.fallback` completion event share the
   * same id — clients use it to match the modal to the right gate when
   * parallel requests fail on the same primary.
   */
  requestId: string;
}) => Promise<{ providerId: string; model: string } | null>;
