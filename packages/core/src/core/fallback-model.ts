import {
  contextWindowWarning,
  ensureUsableModelResponse,
  fallbackCandidates,
  maxContextOf,
  primaryTarget,
  sameTarget,
  shouldFallback,
} from './fallback-model-selection.js';

export {
  effectiveFallbackChain,
  fallbackProfileChain,
  runtimeFallbackChain,
  smartDefaultFallbackChain,
} from './fallback-model-selection.js';

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
import { randomUUID } from 'node:crypto';
import type { Config } from '@wrongstack/contracts/types/config';
import type { AgentExtension } from '@wrongstack/contracts/types/extension-points';
import { type Provider, ProviderError, type Response } from '@wrongstack/contracts/types/provider';
import {
  configuredProviderIdentities,
  providerIdentities,
} from '../utils/provider-catalog-binding.js';
import { resolveEventSessionId } from './context.js';
import type { FallbackModelDeps } from './fallback-model-types.js';
import { evaluateModelCalendar, logicalCalendarTarget } from './model-availability-calendar.js';
import { shouldRecordProviderFailure } from './provider-runner.js';
import { bindRequestProvider } from './request-provider-binding.js';

export type { FallbackGateFn, FallbackModelDeps } from './fallback-model-types.js';

// Compatibility: the canonical leaf implementation lives in model-ref.ts.
export { formatModelRef, normalizeModelRef, parseModelRef } from './model-ref.js';

const DEFAULT_PRIMARY_COOLDOWN_MS = 60_000;
const DEFAULT_PRIMARY_COOLDOWN_MAX_MS = 10 * 60_000;
const DEFAULT_PRIMARY_RECOVERY_SUCCESSES = 2;

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
  let primaryRecoveryHits = 0;
  let stickyTurnsElapsed = 0;
  // Remembers the last fallback model that succeeded so the chain can
  // front-load it on subsequent primary failures — avoiding a full
  // re-traversal through flaky entries that were already tried.
  let lastWorkingFallback: { providerId: string; model: string } | undefined;
  let blockedPrimary: { providerId: string; model: string } | undefined;
  let primaryBlockedUntil = 0;

  const now = () => deps.now?.() ?? Date.now();
  // Stickiness is read from the LIVE config on every use, with the explicit
  // dep as the override. Reading it once at construction (the old behavior)
  // meant `/config`-style edits to `fallbackStickiness` needed a full restart
  // even though every other fallback input is recomputed per turn.
  const liveStickiness = () => deps.getConfig().fallbackStickiness;
  const cooldownBase = () =>
    Math.max(
      0,
      deps.primaryCooldownMs ??
        liveStickiness()?.primaryProbeInterval ??
        DEFAULT_PRIMARY_COOLDOWN_MS,
    );
  const cooldownMax = () =>
    Math.max(cooldownBase(), deps.primaryCooldownMaxMs ?? DEFAULT_PRIMARY_COOLDOWN_MAX_MS);
  const selectedPrimary = (cfg: Config) => deps.getPrimaryTarget?.() ?? primaryTarget(cfg);
  const primaryInCooldown = (cfg: Config) =>
    sameTarget(blockedPrimary, selectedPrimary(cfg)) && now() < primaryBlockedUntil;

  const markPrimaryFailure = (cfg: Config) => {
    const primary = selectedPrimary(cfg);
    primaryFailureStreak = sameTarget(blockedPrimary, primary) ? primaryFailureStreak + 1 : 1;
    // A failure breaks any in-progress recovery chain.
    primaryRecoveryHits = 0;
    // A new fallback hop starts the sticky-dwell window from zero.
    stickyTurnsElapsed = 0;
    blockedPrimary = primary;
    const base = cooldownBase();
    if (base <= 0) {
      primaryBlockedUntil = 0;
      return;
    }
    const multiplier = 2 ** Math.max(0, primaryFailureStreak - 1);
    primaryBlockedUntil = now() + Math.min(cooldownMax(), base * multiplier);
  };

  const recoveryTarget = () =>
    Math.max(1, deps.primaryRecoverySuccesses ?? DEFAULT_PRIMARY_RECOVERY_SUCCESSES);

  const stickyTarget = () =>
    Math.max(0, deps.stickyFallbackTurns ?? liveStickiness()?.stickyFallbackTurns ?? 0);

  /** Whether the mandatory fallback dwell period is still in effect. */
  const inStickyWindow = () => stickyTurnsElapsed < stickyTarget();

  /**
   * Graduated primary recovery: a single success does NOT fully reset the
   * failure ladder.  The streak is retained so the next failure continues
   * the exponential backoff instead of restarting at 1 — preventing an
   * intermittently-available primary from causing endless model bouncing.
   * Only after `recoveryTarget()` consecutive successes is the ladder
   * fully cleared.
   */
  const onPrimarySuccess = (cfg: Config) => {
    if (!sameTarget(blockedPrimary, selectedPrimary(cfg))) return;
    primaryRecoveryHits += 1;
    if (primaryRecoveryHits >= recoveryTarget()) {
      // Enough consecutive successes — fully clear the ladder.
      primaryFailureStreak = 0;
      primaryRecoveryHits = 0;
      stickyTurnsElapsed = 0;
      lastWorkingFallback = undefined;
      blockedPrimary = undefined;
      primaryBlockedUntil = 0;
    } else {
      // Partial recovery: allow probing next turn but retain the streak
      // so a subsequent failure continues the exponential backoff.
      primaryBlockedUntil = 0;
    }
  };

  return {
    name: 'fallback-model',

    beforeRun: async (ctx) => {
      if (!dirty) return;
      const cfg = deps.getConfig();
      const primary = selectedPrimary(cfg);

      // ── Sticky fallback dwell ──────────────────────────────────────
      // Count this turn as one completed turn on the working fallback.
      // If we haven't yet dwelled for `stickyTarget()` turns, stay on
      // the fallback even if the cooldown timer has expired.
      stickyTurnsElapsed += 1;
      if (inStickyWindow()) return;

      if (primaryInCooldown(cfg)) return;
      if (
        !evaluateModelCalendar(
          cfg.modelAvailabilitySchedule,
          configuredProviderIdentities(cfg.providers, primary.providerId),
          primary.model,
        ).allowed ||
        (deps.statusTracker && !deps.statusTracker.isAvailable(primary.providerId, primary.model))
      )
        return;
      try {
        const primaryProvider = await deps.buildProvider(primary.providerId, primary.model);
        // A fallback can safely carry a larger history than the recovered
        // primary. Do this check *after* building the target provider so its
        // own, model-specific maxContext is authoritative. This mirrors the
        // fallback-chain pre-filter below and prevents a half-open probe from
        // repeatedly sending a request the primary cannot accept.
        const currentTokens = ctx.lastRequestTokens;
        const maxContext = maxContextOf(primaryProvider);
        if (maxContext > 0 && typeof currentTokens === 'number' && currentTokens > maxContext) {
          deps.events.emit('provider.primary_probe_context_blocked', {
            sessionId: resolveEventSessionId(ctx),
            providerId: primary.providerId,
            model: primary.model,
            currentTokens,
            maxContext,
            timestamp: now(),
          });
          deps.logger?.warn(
            `fallback-model: deferring primary probe "${primary.providerId}/${primary.model}" — ` +
              `context (${currentTokens}) exceeds target window (${maxContext})`,
          );
          markPrimaryFailure(cfg);
          return;
        }
        const restoredFrom = { providerId: ctx.provider.id, model: ctx.model };
        ctx.provider = primaryProvider;
        ctx.model = primary.model;
        await deps.onModelSwitch?.(primary.providerId, primary.model);
        deps.events.emit('provider.primary_restored', {
          sessionId: resolveEventSessionId(ctx),
          from: restoredFrom,
          to: { providerId: primary.providerId, model: primary.model },
          timestamp: now(),
        });
        // The next provider call is the half-open primary probe. If it
        // succeeds, onPrimarySuccess will either partially clear (allowing
        // another probe) or fully reset the ladder (after recoveryTarget
        // consecutive successes). If it fails, the catch path marks a
        // longer cooldown and rotates back through the chain.
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
      const liveConfig = deps.getConfig();
      const calendar = evaluateModelCalendar(
        liveConfig.modelAvailabilitySchedule,
        [
          ...new Set([
            ...providerIdentities(ctx.provider),
            ...configuredProviderIdentities(liveConfig.providers, ctx.provider.id),
          ]),
        ],
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
          sessionId: resolveEventSessionId(ctx),
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
          ctx.signal,
        );
        // Record success in the tracker
        tracker?.recordSuccess(ctx.provider.id, ctx.model, {
          sessionId: resolveEventSessionId(ctx),
          agentId: ctx.agentId,
        });
        const cfg = deps.getConfig();
        const primary = selectedPrimary(cfg);
        if (ctx.provider.id === primary.providerId && ctx.model === primary.model) {
          onPrimarySuccess(cfg);
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
        // If the user already aborted (the signal fired before or during the
        // primary call), do NOT rotate through fallbacks. The abort error
        // should propagate immediately so the agent loop sees 'aborted'
        // instead of burning time and money trying every configured model.
        if (ctx_.signal?.aborted) throw firstErr_;

        let lastErr: unknown = firstErr_;
        const cfg = deps.getConfig();
        const current = { providerId: ctx_.provider.id, model: ctx_.model };

        // Record the failure in the tracker (real ProviderError, not our synthetic skip)
        const firstErrIsProvider =
          firstErr_ instanceof ProviderError || ProviderError.isProviderError(firstErr_);
        // `shouldRecordProviderFailure` — the provider runner is the single wire
        // funnel and already wrote this failure to the waiting room. Counting
        // it again here would halve every consecutive-failure threshold.
        if (
          !alreadyTracked &&
          firstErrIsProvider &&
          tracker &&
          shouldRecordProviderFailure(firstErr_)
        ) {
          tracker.recordFailure(
            ctx_.provider.id,
            ctx_.model,
            (firstErr_ as ProviderError).kind,
            (firstErr_ as ProviderError).status,
            (firstErr_ as ProviderError).describe(),
            {
              sessionId: resolveEventSessionId(ctx_),
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
        let usableChain = tracker
          ? chain.filter((e) => tracker.isAvailable(e.providerId, e.model))
          : chain;

        // Drop calendar-blocked entries up front. The execution loop below
        // deterministically skips them (`!evaluateModelCalendar(...).allowed`
        // → continue), so the fallback-gate modal must not offer models whose
        // pick would be silently ignored — and the last-working-fallback
        // re-order must not front-load one either.
        usableChain = usableChain.filter(
          (e) =>
            evaluateModelCalendar(
              cfg.modelAvailabilitySchedule,
              configuredProviderIdentities(cfg.providers, e.providerId),
              e.model,
            ).allowed,
        );

        // ── Last-working-fallback prioritization ──────────────────────
        // If a prior turn found a model that worked, move it to the front
        // of the chain so we don't re-traverse flaky entries that already
        // failed. The dedup filter in fallbackCandidates already removed
        // duplicates, so this is a stable re-order, not a duplication.
        if (
          lastWorkingFallback &&
          usableChain.length > 1 &&
          // Don't front-load if the last-working is the current model
          // (we're already on it) or if it's now blocked.
          !(
            lastWorkingFallback.providerId === current.providerId &&
            lastWorkingFallback.model === current.model
          ) &&
          !(
            tracker &&
            !tracker.isAvailable(lastWorkingFallback.providerId, lastWorkingFallback.model)
          )
        ) {
          const lwfKey = `${lastWorkingFallback.providerId}/${lastWorkingFallback.model}`;
          const lwfEntry = usableChain.find((e) => `${e.providerId}/${e.model}` === lwfKey);
          if (lwfEntry) {
            usableChain = [
              lwfEntry,
              ...usableChain.filter((e) => `${e.providerId}/${e.model}` !== lwfKey),
            ];
          }
        }

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

        // ── Fallback gate (countdown + manual pick modal) ──────────────
        // When a gate function is configured, pause BEFORE iterating the
        // chain and let the UI show a modal. The gate emits
        // `provider.fallback_pending`, waits for the user's choice or the
        // countdown timer, then returns the selected model or null to accept
        // the default (chain head). If a specific model is chosen, we
        // reorder usableChain to front-load it.
        //
        // The requestId is generated HERE (not inside the gate) so the
        // `provider.fallback` completion event can carry it — clients match
        // the modal to the right gate when parallel requests fail on the
        // same primary.
        let gateRequestId: string | undefined;
        const configuredGateSeconds = cfg.fallbackGateSeconds ?? deps.fallbackGateSeconds;
        if (configuredGateSeconds !== 0 && deps.fallbackGate && usableChain.length > 0) {
          gateRequestId = randomUUID();
          const autoSwitchSeconds = Math.max(1, configuredGateSeconds ?? 7);
          const gateCandidates = usableChain.map((e) => ({
            providerId: e.providerId,
            model: e.model,
          }));
          try {
            const choice = await deps.fallbackGate({
              events: deps.events,
              sessionId: resolveEventSessionId(ctx_),
              from: {
                providerId: ctx_.provider.id,
                model: ctx_.model,
              },
              status,
              candidates: gateCandidates,
              autoSwitchSeconds,
              requestId: gateRequestId,
            });
            if (choice) {
              const chosen = usableChain.find(
                (e) => e.providerId === choice.providerId && e.model === choice.model,
              );
              if (chosen) {
                usableChain = [
                  chosen,
                  ...usableChain.filter(
                    (e) => !(e.providerId === choice.providerId && e.model === choice.model),
                  ),
                ];
              }
            }
          } catch (gateErr) {
            // Gate errors never block the fallback chain — proceed with
            // the default ordering.
            deps.logger?.warn(
              `fallback-model: gate error — proceeding with default chain: ${
                gateErr instanceof Error ? gateErr.message : String(gateErr)
              }`,
            );
          }
        }

        // The gate may have waited seconds for a countdown. If the user
        // aborted during that wait, don't start trying fallback entries.
        if (ctx_.signal?.aborted) throw firstErr_;

        for (const entry of usableChain) {
          // If the user aborted (or a prior fallback attempt took long
          // enough for them to do so), stop rotating immediately.
          if (ctx_.signal?.aborted) throw lastErr;

          if (
            !evaluateModelCalendar(
              cfg.modelAvailabilitySchedule,
              configuredProviderIdentities(cfg.providers, entry.providerId),
              entry.model,
            ).allowed
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

          // Pre-filter: if we know the current request's token count and this
          // fallback model's context window is provably too small, skip it
          // instead of dispatching a call that will fail with context_overflow
          // (which is NOT fallback-worthy and would surface as an error to the
          // user). The check is conservative: only skips when the INPUT alone
          // exceeds the window — if input fits, the call may still succeed.
          const entryMaxContext = maxContextOf(nextProvider);
          const currentTokens = ctx_.lastRequestTokens;
          if (
            entryMaxContext > 0 &&
            typeof currentTokens === 'number' &&
            currentTokens > 0 &&
            currentTokens > entryMaxContext
          ) {
            deps.logger?.warn(
              `fallback-model: skipping "${targetProviderId}/${targetModel}" — context window ` +
                `(${entryMaxContext}) is smaller than current request tokens (${currentTokens})`,
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
            sessionId: resolveEventSessionId(ctx_),
            from: logicalFrom,
            to: tracker?.logicalIdentity(nextProvider.id, targetModel) ?? {
              providerId: nextProvider.id,
              model: targetModel,
            },
            status,
            providerSwitched,
            // Correlate this completion with the gate that paused for the
            // user's pick — clients clear the fallback modal only when the
            // requestId matches the pending request.
            ...(gateRequestId ? { requestId: gateRequestId } : {}),
            ...(warning ? { contextWindowWarning: warning } : {}),
          });

          // The provider build and model-switch hooks above are async; the
          // user may have aborted while they were pending. Re-check right
          // before dispatching the fallback request so we don't launch a new
          // provider call after cancellation.
          if (ctx_.signal?.aborted) throw lastErr;

          try {
            const response = ensureUsableModelResponse(
              await inner_(ctx_, request_),
              ctx_.provider.id,
              ctx_.model,
              ctx_.signal,
            );
            tracker?.recordSuccess(nextProvider.id, targetModel, {
              sessionId: resolveEventSessionId(ctx_),
              agentId: ctx_.agentId,
            });
            // Remember this model so the next chain traversal front-loads it.
            lastWorkingFallback = { providerId: nextProvider.id, model: targetModel };
            return response;
          } catch (err) {
            // Record fallback failure too
            if (
              (err instanceof ProviderError || ProviderError.isProviderError(err)) &&
              tracker &&
              shouldRecordProviderFailure(err)
            ) {
              tracker.recordFailure(
                nextProvider.id,
                targetModel,
                (err as ProviderError).kind,
                (err as ProviderError).status,
                (err as ProviderError).describe(),
                {
                  sessionId: resolveEventSessionId(ctx_),
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
