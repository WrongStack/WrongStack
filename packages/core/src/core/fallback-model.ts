/**
 * Cross-provider fallback model extension.
 *
 * Lives in core so EVERY agent surface can reuse it: the CLI leader, the CLI
 * director/host subagent factory, and the runtime light subagent factory (used
 * by standalone SDD runs). It wraps the provider runner and, when the active
 * model 429s / overloads / stream-hangs, rotates through a fallback chain. The
 * chain is recomputed from live config every turn, so changes take effect
 * without a restart; an empty chain makes the wrapper a no-op.
 *
 * Moved here from `@wrongstack/cli` (it only ever depended on core types) so the
 * runtime light factory can wire fallbacks for SDD worker subagents.
 */

import type { ProviderModelStatusTracker } from '../coordination/provider-status-tracker.js';
import type { AgentExtension } from '../extension/extension-points.js';
import type { EventBus } from '../kernel/events.js';
import { isTextBlock, isToolUseBlock } from '../types/blocks.js';
import type { Config } from '../types/config.js';
import type { Logger } from '../types/logger.js';
import {
  isFallbackWorthy,
  type Provider,
  ProviderError,
  type Response,
} from '../types/provider.js';
import type { FallbackChain, FallbackChainEntry } from './fallback-profile-manager.js';
import { FallbackProfileManager } from './fallback-profile-manager.js';
import { evaluateModelCalendar, logicalCalendarTarget } from './model-availability-calendar.js';
import { bindRequestProvider } from './request-provider-binding.js';

export type { ModelRef } from './model-ref.js';
// Compatibility: the canonical leaf implementation lives in model-ref.ts.
export { formatModelRef, normalizeModelRef, parseModelRef } from './model-ref.js';

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
  /** Test hook for deterministic cooldown assertions. */
  now?: (() => number) | undefined;
  /**
   * Shared provider/model status tracker. When set, the extension records
   * failures and successes in the tracker, and skips blocked entries in
   * the fallback chain.
   */
  statusTracker?: ProviderModelStatusTracker | undefined;
}

export function fallbackProfileChain(config: Config, profileName: string | undefined): string[] {
  if (!profileName) return [];
  const mgr = new FallbackProfileManager(config);
  return mgr.resolve(profileName).map((e) => `${e.providerId}/${e.model}`);
}

/**
 * Check if an error should trigger a fallback. Returns the status for
 * logging, or null if the error doesn't warrant a fallback attempt.
 *
 * Branches on the canonical `ProviderError.kind`: capacity/availability
 * failures (rate limit, overload, server error, stream hang, timeout,
 * network) are worth trying on another provider; request-shaped failures
 * (auth, invalid request, context overflow, content filter) would fail
 * identically anywhere — or need a different remedy (compaction, key fix) —
 * so they surface instead.
 */
function shouldFallback(err: unknown): number | null {
  if (!(err instanceof ProviderError) && !ProviderError.isProviderError(err)) return null;
  const kind = (err as ProviderError).kind;
  return isFallbackWorthy(kind) ? (err as ProviderError).status : null;
}

function isUsableModelResponse(response: Response): boolean | undefined {
  if (!response?.content) return undefined;
  return response.content.some(
    (block) => isToolUseBlock(block) || (isTextBlock(block) && block.text.trim().length > 0),
  );
}

function ensureUsableModelResponse(
  response: Response,
  providerId: string,
  model: string,
): Response {
  const usable = isUsableModelResponse(response);
  // undefined content means the caller didn't provide a content field (e.g. test mocks) — let it through
  if (usable !== false) return response;
  throw new ProviderError(
    `Empty response from ${providerId}/${model}; trying the next configured model`,
    503,
    true,
    providerId,
    { kind: 'overloaded' },
  );
}

export function smartDefaultFallbackChain(config: Config): string[] {
  const mgr = new FallbackProfileManager(config);
  return mgr.resolveEffective({ fallbackAuto: true }).map((e) => `${e.providerId}/${e.model}`);
}

/**
 * The effective fallback chain for a turn: the explicit `fallbackModels` list
 * when non-empty, otherwise the smart default (unless `fallbackAuto` is off).
 */
export function effectiveFallbackChain(config: Config): string[] {
  const mgr = new FallbackProfileManager(config);
  return mgr
    .resolveEffective({
      fallbackModels: config.fallbackModels,
      fallbackAuto: config.fallbackAuto,
    })
    .map((e) => `${e.providerId}/${e.model}`);
}

const DEFAULT_PRIMARY_COOLDOWN_MS = 60_000;
const DEFAULT_PRIMARY_COOLDOWN_MAX_MS = 10 * 60_000;

function sameTarget(
  a: { providerId: string; model: string } | undefined,
  b: { providerId: string; model: string },
): boolean {
  return !!a && a.providerId === b.providerId && a.model === b.model;
}

function fallbackCandidates(
  config: Config,
  current: { providerId: string; model: string },
  opts: {
    fallbackModels?: readonly string[] | undefined;
    fallbackProfile?: string | undefined;
    sharedManager?: FallbackProfileManager | undefined;
    primary?: { providerId: string; model: string } | undefined;
    closedWorld?: boolean | undefined;
  } = {},
): FallbackChain {
  const mgr = opts.sharedManager ?? new FallbackProfileManager(config);
  const configuredPrimary = opts.primary ?? primaryTarget(config);
  // The effective fallbackAuto: honour the config explicitly, fall back to
  // !closedWorld only when config.fallbackAuto is undefined/null.
  const configFallbackAuto = config.fallbackAuto;
  const effectiveFallbackAuto =
    configFallbackAuto !== undefined && configFallbackAuto !== null
      ? configFallbackAuto
      : !opts.closedWorld;
  const selectedChain = mgr.resolveEffective({
    fallbackModels: opts.fallbackModels ?? config.fallbackModels,
    fallbackProfile: opts.fallbackProfile,
    fallbackAuto: effectiveFallbackAuto,
    exclude: current,
  });
  const candidates: FallbackChainEntry[] = [];

  // A model allowlist is a permission boundary. Never append the session
  // model, default profile, or auto-discovered providers outside that boundary.
  if (opts.closedWorld) {
    candidates.push(...selectedChain);
    const seen = new Set<string>();
    return Object.freeze(
      candidates.filter((entry) => {
        const key = `${entry.providerId}/${entry.model}`;
        if (key === `${current.providerId}/${current.model}` || seen.has(key)) return false;
        seen.add(key);
        return true;
      }),
    );
  }

  if (opts.fallbackProfile !== 'default') {
    candidates.push(...mgr.resolve('default', { exclude: current }));
  }

  // Always try the session's configured primary first when we're not already on it.
  if (!sameTarget(configuredPrimary, current)) {
    candidates.push({
      providerId: configuredPrimary.providerId,
      model: configuredPrimary.model,
      providerSwitched: configuredPrimary.providerId !== current.providerId,
    });
  }

  // Then try the role-selected or explicit chain.
  candidates.push(...selectedChain);

  // Finally try every other configured provider as a last resort — but only
  // when fallbackAuto is actually enabled.
  if (effectiveFallbackAuto) {
    const smartDefaults = mgr.resolveEffective({ fallbackAuto: true, exclude: current });
    candidates.push(...smartDefaults);
  }

  const seen = new Set<string>();
  return Object.freeze(
    candidates.filter((entry) => {
      const key = `${entry.providerId}/${entry.model}`;
      if (key === `${current.providerId}/${current.model}` || seen.has(key)) return false;
      seen.add(key);
      return true;
    }),
  );
}

const primaryTarget = (cfg: Config) => ({ providerId: cfg.provider, model: cfg.model });

function maxContextOf(provider: Provider): number {
  const max = provider.capabilities.maxContext;
  return typeof max === 'number' && Number.isFinite(max) ? max : 0;
}

function contextWindowWarning(
  currentProvider: Provider,
  nextProvider: Provider,
  currentTokens: unknown,
):
  | { fromMaxContext: number; toMaxContext: number; currentTokens?: number | undefined }
  | undefined {
  const fromMaxContext = maxContextOf(currentProvider);
  const toMaxContext = maxContextOf(nextProvider);
  if (fromMaxContext <= 0 || toMaxContext <= 0 || toMaxContext >= fromMaxContext) return undefined;
  return {
    fromMaxContext,
    toMaxContext,
    ...(typeof currentTokens === 'number' && currentTokens > 0 ? { currentTokens } : {}),
  };
}

/**
 * Build the cross-provider fallback extension. Always returns an extension —
 * the effective chain (`effectiveFallbackChain`) is recomputed every turn from
 * the live config, so a chain that is empty at boot but populated later (via
 * `/fallback add` or the smart default kicking in once a key is added) takes
 * effect WITHOUT a restart. An empty chain makes the wrapper a no-op (it just
 * rethrows the original error).
 *
 * Mechanism (see plan): wraps the provider runner. The inner runner already
 * applies the per-model retry policy (backoff, up to 5 tries for 429), so the
 * fallback only engages AFTER the active model's own retries are exhausted.
 * Because the wrapper resolves within a single provider call, it does not
 * consume the agent loop's `recoveryRetries` budget — chains longer than two
 * entries work. `beforeRun` keeps the last working fallback while the primary
 * is cooling down, then restores the configured primary for a half-open probe.
 */
export function createFallbackModelExtension(deps: FallbackModelDeps): AgentExtension {
  // True when a prior turn left the live context on a fallback model.
  let dirty = false;
  let primaryFailureStreak = 0;
  let blockedPrimary: { providerId: string; model: string } | undefined;
  let primaryBlockedUntil = 0;

  const now = () => deps.now?.() ?? Date.now();
  const cooldownBase = () => Math.max(0, deps.primaryCooldownMs ?? DEFAULT_PRIMARY_COOLDOWN_MS);
  const cooldownMax = () =>
    Math.max(cooldownBase(), deps.primaryCooldownMaxMs ?? DEFAULT_PRIMARY_COOLDOWN_MAX_MS);
  const selectedPrimary = (cfg: Config) => deps.getPrimaryTarget?.() ?? primaryTarget(cfg);
  const primaryInCooldown = (cfg: Config) =>
    sameTarget(blockedPrimary, selectedPrimary(cfg)) && now() < primaryBlockedUntil;

  const markPrimaryFailure = (cfg: Config) => {
    const primary = selectedPrimary(cfg);
    primaryFailureStreak = sameTarget(blockedPrimary, primary) ? primaryFailureStreak + 1 : 1;
    blockedPrimary = primary;
    const base = cooldownBase();
    if (base <= 0) {
      primaryBlockedUntil = 0;
      return;
    }
    const multiplier = 2 ** Math.max(0, primaryFailureStreak - 1);
    primaryBlockedUntil = now() + Math.min(cooldownMax(), base * multiplier);
  };

  const resetPrimaryLadder = (cfg: Config) => {
    if (!sameTarget(blockedPrimary, selectedPrimary(cfg))) return;
    primaryFailureStreak = 0;
    blockedPrimary = undefined;
    primaryBlockedUntil = 0;
  };

  return {
    name: 'fallback-model',

    beforeRun: async (ctx) => {
      if (!dirty) return;
      const cfg = deps.getConfig();
      const primary = selectedPrimary(cfg);
      if (primaryInCooldown(cfg)) return;
      if (
        !evaluateModelCalendar(cfg.modelAvailabilitySchedule, primary.providerId, primary.model)
          .allowed ||
        (deps.statusTracker && !deps.statusTracker.isAvailable(primary.providerId, primary.model))
      )
        return;
      try {
        ctx.provider = await deps.buildProvider(primary.providerId, primary.model);
        ctx.model = primary.model;
        await deps.onModelSwitch?.(primary.providerId, primary.model);
        // The next provider call is the half-open primary probe. If it
        // succeeds, the wrapper resets the ladder; if it fails, the catch path
        // marks a longer cooldown and rotates back through the chain.
        primaryBlockedUntil = 0;
      } catch (err) {
        deps.logger?.warn(
          `fallback-model: could not restore primary "${primary.providerId}/${primary.model}": ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
        markPrimaryFailure(cfg);
        return;
      }
      dirty = false;
    },

    wrapProviderRunner: async (ctx, request, inner) => {
      // ── Before calling, check if the current provider/model is blocked ──
      const tracker = deps.statusTracker;
      const calendar = evaluateModelCalendar(
        deps.getConfig().modelAvailabilitySchedule,
        ctx.provider.id,
        ctx.model,
      );
      const trackerBlocked = tracker ? !tracker.isAvailable(ctx.provider.id, ctx.model) : false;
      if (trackerBlocked || !calendar.allowed) {
        deps.logger?.warn(
          `provider-status: "${ctx.provider.id}/${ctx.model}" is blocked — trying fallback chain`,
        );
        // Emit active_blocked so the UI can surface a prominent warning
        const status = tracker?.getStatus(ctx.provider.id, ctx.model);
        const logical =
          tracker?.logicalIdentity(ctx.provider.id, ctx.model) ??
          logicalCalendarTarget(ctx.provider.id, ctx.model);
        deps.events.emit('provider.active_blocked', {
          providerId: logical.providerId,
          model: logical.model,
          state: 'blocked',
          fallbackProviderId: '',
          fallbackModel: '',
          lastError:
            calendar.rule?.label ??
            (calendar.rule ? 'Blocked by model availability calendar' : undefined) ??
            status?.lastErrorMessage ??
            'Rate limit or repeated failures',
          sessionId: ctx.session?.id,
          timestamp: Date.now(),
        });
        // Skipping the blocked primary — simulate a fallback-worthy error
        const skipErr = new ProviderError(
          `Skipping unavailable "${ctx.provider.id}/${ctx.model}" — try fallback`,
          429,
          true,
          ctx.provider.id,
          { kind: 'rate_limit' },
        );
        return runFallbackChain(ctx, request, inner, skipErr, true);
      }

      try {
        const response = ensureUsableModelResponse(
          await inner(ctx, request),
          ctx.provider.id,
          ctx.model,
        );
        // Record success in the tracker
        tracker?.recordSuccess(ctx.provider.id, ctx.model, {
          sessionId: ctx.session?.id,
          agentId: ctx.agentId,
        });
        const cfg = deps.getConfig();
        const primary = selectedPrimary(cfg);
        if (ctx.provider.id === primary.providerId && ctx.model === primary.model) {
          resetPrimaryLadder(cfg);
        }
        return response;
      } catch (firstErr) {
        return runFallbackChain(ctx, request, inner, firstErr);
      }

      // ── Shared fallback-chain runner with tracker integration ──
      async function runFallbackChain(
        ctx_: typeof ctx,
        request_: typeof request,
        inner_: typeof inner,
        firstErr_: unknown,
        alreadyTracked = false,
      ): Promise<Response> {
        let lastErr: unknown = firstErr_;
        const cfg = deps.getConfig();
        const current = { providerId: ctx_.provider.id, model: ctx_.model };

        // Record the failure in the tracker (real ProviderError, not our synthetic skip)
        const firstErrIsProvider = firstErr_ instanceof ProviderError || ProviderError.isProviderError(firstErr_);
        if (!alreadyTracked && firstErrIsProvider && tracker) {
          tracker.recordFailure(
            ctx_.provider.id,
            ctx_.model,
            (firstErr_ as ProviderError).kind,
            (firstErr_ as ProviderError).status,
            (firstErr_ as ProviderError).describe(),
            {
              sessionId: ctx_.session?.id,
              agentId: ctx_.agentId,
              retryAfterMs: firstErr_.body?.retryAfterMs,
            },
          );
        }

        const chain = fallbackCandidates(cfg, current, {
          fallbackModels: deps.getFallbackModels?.(),
          fallbackProfile: deps.getFallbackProfile?.(),
          sharedManager: deps.fallbackProfileManager,
          primary: selectedPrimary(cfg),
          closedWorld: deps.isClosedWorld?.() ?? false,
        });

        // Filter blocked entries from the chain via the tracker
        const usableChain = tracker
          ? chain.filter((e) => tracker.isAvailable(e.providerId, e.model))
          : chain;

        if (
          !alreadyTracked &&
          shouldFallback(firstErr_) !== null &&
          sameTarget(selectedPrimary(cfg), current)
        ) {
          markPrimaryFailure(cfg);
        }

        // Gate ONCE, on the error that TRIGGERED the fallback — not per entry
        // on `lastErr`.
        //
        // `lastErr` is reassigned by every failed attempt below, so the old
        // per-entry check let ONE bad candidate abort the whole chain: a model
        // id that no longer exists on its provider answers 404, which
        // classifies as `invalid_request` (not fallback-worthy), and the next
        // iteration hit `break`. Every healthy entry after it went untried and
        // the turn died with "model not found" while a working fallback sat
        // one slot down. Stale entries are easy to acquire — `resolveRefs`
        // never validates `fallbackModels` against the provider's model list,
        // `buildProvider` ignores the model argument entirely, and
        // `config.providers[].models` is an unrefreshed snapshot.
        //
        // A per-entry failure now just moves to the next candidate; only the
        // triggering error decides whether we fall back at all.
        const status = shouldFallback(firstErr_);
        if (status === null) throw firstErr_; // not a fallback-worthy error

        for (const entry of usableChain) {
          if (
            !evaluateModelCalendar(cfg.modelAvailabilitySchedule, entry.providerId, entry.model)
              .allowed
          )
            continue;

          // Re-check tracker availability right before attempting this entry.
          // The chain was computed from a snapshot of `isAvailable`, but an
          // intervening failure — from a concurrent subagent, a prior entry
          // in this loop, or a race with the one-shot LLM helper — may have
          // pushed this (providerId, model) into the waiting room since then.
          // A stale-chain call would waste time and burn rate-limit budget.
          if (tracker && !tracker.isAvailable(entry.providerId, entry.model)) {
            deps.logger?.warn(
              `provider-status: "${entry.providerId}/${entry.model}" entered the waiting room` +
                ` since the chain was computed — skipping`,
            );
            continue;
          }

          const targetProviderId = entry.providerId;
          const targetModel = entry.model;
          if (targetProviderId === ctx_.provider.id && targetModel === ctx_.model) continue;
          if (
            primaryInCooldown(cfg) &&
            sameTarget(selectedPrimary(cfg), {
              providerId: targetProviderId,
              model: targetModel,
            })
          ) {
            continue;
          }

          const from = { providerId: ctx_.provider.id, model: ctx_.model };
          const logicalFrom = tracker?.logicalIdentity(from.providerId, from.model) ?? from;

          let nextProvider: Provider;
          try {
            nextProvider = await deps.buildProvider(targetProviderId, targetModel);
          } catch (err) {
            deps.logger?.warn(
              `fallback-model: skipping "${targetProviderId}/${targetModel}" — cannot build provider "${targetProviderId}": ${
                err instanceof Error ? err.message : String(err)
              }`,
            );
            continue;
          }

          const providerSwitched = nextProvider.id !== from.providerId;
          const warning = contextWindowWarning(ctx_.provider, nextProvider, ctx_.lastRequestTokens);
          ctx_.provider = nextProvider;
          ctx_.model = targetModel;
          request_.model = targetModel;
          bindRequestProvider(request_, nextProvider);
          dirty = true;
          await deps.onModelSwitch?.(targetProviderId, targetModel);

          deps.events.emit('provider.fallback', {
            sessionId: ctx_.session?.id,
            from: logicalFrom,
            to: tracker?.logicalIdentity(nextProvider.id, targetModel) ?? {
              providerId: nextProvider.id,
              model: targetModel,
            },
            status,
            providerSwitched,
            ...(warning ? { contextWindowWarning: warning } : {}),
          });

          try {
            const response = ensureUsableModelResponse(
              await inner_(ctx_, request_),
              ctx_.provider.id,
              ctx_.model,
            );
            tracker?.recordSuccess(nextProvider.id, targetModel, {
              sessionId: ctx_.session?.id,
              agentId: ctx_.agentId,
            });
            return response;
          } catch (err) {
            // Record fallback failure too
            if ((err instanceof ProviderError || ProviderError.isProviderError(err)) && tracker) {
              tracker.recordFailure(
                nextProvider.id,
                targetModel,
                (err as ProviderError).kind,
                (err as ProviderError).status,
                (err as ProviderError).describe(),
                {
                  sessionId: ctx_.session?.id,
                  agentId: ctx_.agentId,
                  retryAfterMs: err.body?.retryAfterMs,
                },
              );
            }
            lastErr = err;
          }
        }

        throw lastErr;
      }
    },
  };
}
