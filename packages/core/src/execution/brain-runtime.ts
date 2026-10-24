/**
 * BrainRuntime — the live, rebuildable owner of `config.brain`.
 *
 * The Brain chain used to be assembled once at boot; every knob except the
 * risk ceiling and escalation mode was frozen until restart. This module
 * makes the whole `BrainConfig` surface live-editable AND persistable from
 * any host surface (/brain subcommands, TUI Brain panel, WebUI BrainSection):
 *
 *   - `arbiter` is a STABLE delegating handle (`decide` reads a mutable
 *     `current`), so hosts wrap it once in their EscalationRouting/Observable
 *     layers and no consumer ever needs a rebind after a settings change.
 *   - `apply(patch)` normalizes + validates the patch, commits it, rebuilds
 *     the tier chain when a structural knob changed (pool, council, timeout,
 *     ledger guard), and persists through an injected callback — core never
 *     touches config files itself.
 *   - `getSnapshot()` is the JSON-safe truth both UIs render: configured
 *     values plus derived facts (resolved pool/council labels, EFFECTIVE
 *     council enablement, session-model fallback).
 *
 * Persistence contract: `config.brain` is on the in-project deny list, so
 * the injected `persist` MUST write the GLOBAL config. A persist failure
 * never rolls back the live change; it is reported via the returned promise.
 *
 * @module brain-runtime
 */

import type { BrainConfig } from '@wrongstack/contracts/types/config';
import {
  type BrainArbiter,
  type BrainDecisionRequest,
  DefaultBrainArbiter,
} from '../brain/brain.js';
import { BrainDecisionCache, createCachingBrainArbiter } from '../brain/brain-cache.js';
import { type BrainDecisionExplanation, explainBrainDecision } from '../brain/brain-explain.js';
import { createLedgerGuardBrainArbiter } from '../brain/brain-ledger.js';
import {
  type CompiledBrainRule,
  compileBrainRules,
  createRuleBrainArbiter,
} from '../brain/brain-rules.js';
import { BrainTierCounter } from '../brain/brain-telemetry.js';
import { createTieredBrainArbiter } from './autonomy-brain.js';
import { assembleBrainTiers } from './brain-chain.js';
import { BrainCircuitBreaker } from './brain-circuit.js';
import { hasAdaptiveBrainRisk, hasBrainProductDefaults } from './brain-runtime-defaults.js';

export { type BrainDefaultsContext, resolveBrainConfigDefaults } from './brain-runtime-defaults.js';

import { createBrainPersistenceQueue } from './brain-persistence.js';
import {
  brainConfigForPersist,
  normalizeEntry,
  normalizeInitial,
  normalizeVoter,
} from './brain-runtime-normalize.js';
import { mergeBrainConfigPatch } from './brain-runtime-patch.js';
import type {
  BrainConfigSnapshot,
  BrainRuntime,
  BrainRuntimeOptions,
} from './brain-runtime-types.js';
import { createSystemOneBrainTier } from './brain-system-one.js';

export function createBrainRuntime(opts: BrainRuntimeOptions): BrainRuntime {
  let cfg: BrainConfig = normalizeInitial(opts.initialConfig);
  let adaptiveRisk = hasAdaptiveBrainRisk(opts.initialConfig);
  let poolLabels: string[] = [];
  let councilLabels: string[] = [];
  let judgeLabel: string | undefined;
  let judgeIsVoter = false;
  let circuit: BrainCircuitBreaker | undefined;
  let decisionCache: BrainDecisionCache | undefined;
  let compiledRules: CompiledBrainRule[] = [];
  let peekRule: ReturnType<typeof createRuleBrainArbiter>['peekDecision'] | undefined;
  let ruleErrors: string[] = [];
  let current: BrainArbiter;
  let disposed = false;
  const effectiveMaxAutoRisk = () =>
    adaptiveRisk ? (councilLabels.length > 0 ? 'all' : 'high') : (cfg.maxAutoRisk ?? 'medium');
  const effectiveHumanTimeout = () =>
    cfg.humanTimeoutMs ?? (hasBrainProductDefaults(opts.initialConfig) ? 120_000 : undefined);
  const persistConfig = createBrainPersistenceQueue(opts.persist);
  const tierCounter = new BrainTierCounter();
  const offTierStats = opts.events?.on('brain.tier_transition', (e) => {
    if (e.terminal) {
      tierCounter.record(e.tier);
    }
  });

  // Digest + streak wrappers check the host's live ledger enablement per call
  // so a ledger toggle takes effect without re-plumbing.
  const getDecisionDigest = (request: BrainDecisionRequest): string | undefined => {
    const ledger = opts.ledger;
    if (!ledger?.isEnabled()) return undefined;
    return ledger.getDecisionDigest?.(request);
  };

  function rebuild(): void {
    const breakerCfg = cfg.llm?.circuitBreaker;
    circuit = new BrainCircuitBreaker({
      failureThreshold: breakerCfg?.failureThreshold,
      cooldownMs: breakerCfg?.cooldownMs,
    });
    const tiers = assembleBrainTiers({
      brainConfig: cfg,
      defaultProviderId: opts.defaultProviderId,
      sessionProvider: opts.sessionProvider,
      sessionModel: opts.sessionModel,
      resolveProvider: opts.resolveProvider,
      getDecisionDigest,
      events: opts.events,
      traceContent: cfg.trace?.content === undefined || cfg.trace.content === 'full',
      circuit,
    });
    poolLabels = tiers.poolLabels;
    councilLabels = tiers.councilLabels;
    judgeLabel = tiers.judgeLabel;
    judgeIsVoter = tiers.judgeIsVoter;
    const tiered = createTieredBrainArbiter({
      policy: new DefaultBrainArbiter({ heuristics: cfg.heuristics }),
      autonomous: tiers.autonomous,
      getMaxAutoRisk: effectiveMaxAutoRisk,
      council: tiers.council,
      getCouncilMinRisk: tiers.getCouncilMinRisk,
      // Product default 'when-decided', not the bare-API 'never': the tier
      // distinguishes a model that CONSIDERED the question and refused from a
      // pool that was never reached (`readLlmDenyKind`), and with 'never' that
      // distinction is unreachable — every refusal is discarded, so the LLM
      // tier can express agreement but never disagreement. Infrastructure
      // failures (unavailable / unparseable) still fall through untouched.
      // Same split as `maxAutoRisk`: the raw arbiter stays conservative for
      // callers that wire it directly; the product default lives here.
      getDenyIsTerminal: () => cfg.llm?.denyIsTerminal ?? 'when-decided',
      events: opts.events,
      systemOne: opts.getSystemOneJudge
        ? createSystemOneBrainTier({
            getJudge: opts.getSystemOneJudge,
            getDecisionDigest,
          })
        : undefined,
    });

    // Deterministic rules sit in FRONT of the tiered chain so a configured
    // rule settles the question before the policy/council/LLM ladder runs.
    // Compiled once per rebuild; the arbiter reads the array by reference so
    // there is no per-decision compilation cost.
    const compileResult = compileBrainRules(cfg.rules);
    compiledRules = compileResult.rules;
    ruleErrors = compileResult.errors;
    const ruleArbiter =
      compiledRules.length > 0
        ? createRuleBrainArbiter({
            inner: tiered,
            getRules: () => compiledRules,
            events: opts.events,
          })
        : undefined;
    peekRule = ruleArbiter?.peekDecision;
    const ruled: BrainArbiter = ruleArbiter ?? tiered;

    // Decision cache wraps the tiers but stays INSIDE the ledger guard: a
    // guard denial must always be evaluated against the live failure
    // history, never served from a cache.
    decisionCache?.stop();
    decisionCache = new BrainDecisionCache({
      enabled: cfg.cache?.enabled,
      ttlMs: cfg.cache?.ttlMs,
      maxEntries: cfg.cache?.maxEntries,
      events: opts.events,
    });
    decisionCache.start();
    const cached: BrainArbiter =
      cfg.cache?.enabled === true
        ? createCachingBrainArbiter({ inner: ruled, cache: decisionCache, events: opts.events })
        : ruled;

    // The ledger guard stays OUTERMOST: a guard denial must be terminal, and
    // must not be overridable by a rule that would resurrect the very action
    // the observed failure history condemned.
    const streakFor = opts.ledger?.failureStreakFor;
    current =
      streakFor && opts.ledger?.isEnabled()
        ? createLedgerGuardBrainArbiter({
            inner: cached,
            failureStreakFor: streakFor,
            denyAfter: cfg.ledger?.autoDenyAfterFailures,
            events: opts.events,
          })
        : cached;
  }
  rebuild();

  function getSnapshot(): BrainConfigSnapshot {
    const councilCfg = cfg.council;
    const voters = (councilCfg?.voters ?? []).map((v) => normalizeVoter(v));
    return {
      mode: cfg.mode ?? 'interactive',
      maxAutoRisk: effectiveMaxAutoRisk(),
      models: (cfg.models ?? []).map((m) => normalizeEntry(m)),
      strategy: cfg.strategy ?? 'fallback',
      decisionTimeoutMs: cfg.decisionTimeoutMs,
      humanTimeoutMs: effectiveHumanTimeout(),
      council: {
        enabled: councilLabels.length > 0,
        configured: councilCfg?.enabled,
        minRisk: councilCfg?.minRisk ?? 'high',
        voters,
        quorum: councilCfg?.quorum,
        approval: councilCfg?.approval,
        judge: councilCfg?.judge ? normalizeEntry(councilCfg.judge) : undefined,
        perCallTimeoutMs: councilCfg?.perCallTimeoutMs,
        maxConcurrency: councilCfg?.maxConcurrency,
        distinctness: councilCfg?.distinctness ?? 'none',
        voterMaxTokens: councilCfg?.voterMaxTokens,
        judgeMaxTokens: councilCfg?.judgeMaxTokens,
        deliberationRounds: councilCfg?.deliberationRounds,
        seats: (councilCfg?.seats ?? []).map((seat) => ({ ...seat })),
      },
      ledger: {
        enabled: opts.ledger?.isEnabled() ?? false,
        autoDenyAfterFailures: cfg.ledger?.autoDenyAfterFailures,
        path: opts.ledger?.getPath(),
        maxMemoryEntries: cfg.ledger?.maxMemoryEntries,
        interventionRetryWindowMs: cfg.ledger?.interventionRetryWindowMs,
      },
      rules: (cfg.rules ?? []).map((rule) => ({ ...rule })),
      llm: {
        maxTokens: cfg.llm?.maxTokens,
        rejectUncertain: cfg.llm?.rejectUncertain ?? true,
        minConfidence: cfg.llm?.minConfidence ?? 0,
        denyIsTerminal: cfg.llm?.denyIsTerminal ?? 'when-decided',
      },
      trace: {
        enabled: cfg.trace?.enabled === true,
        content: cfg.trace?.content ?? 'full',
        path: cfg.trace?.path,
      },
      monitor: { ...(cfg.monitor ?? {}) },
      terminalPolicy: cfg.terminalPolicy ?? 'conservative',
      decisionLogMaxEntries: cfg.decisionLogMaxEntries ?? 20,
      circuit: circuit
        ? {
            state: circuit.state(),
            consecutiveFailures: circuit.snapshot().consecutiveFailures,
          }
        : undefined,
      cache: {
        enabled: cfg.cache?.enabled === true,
        ttlMs: cfg.cache?.ttlMs ?? 300_000,
        maxEntries: cfg.cache?.maxEntries ?? 200,
        hits: decisionCache?.snapshot().hits ?? 0,
        misses: decisionCache?.snapshot().misses ?? 0,
        size: decisionCache?.snapshot().size ?? 0,
      },
      heuristics: {
        lowRiskAutoAnswer: cfg.heuristics?.lowRiskAutoAnswer ?? true,
        blockedResolved: cfg.heuristics?.blockedResolved ?? true,
        deadlockSkip: cfg.heuristics?.deadlockSkip ?? true,
        retryExhausted: cfg.heuristics?.retryExhausted ?? true,
        continuePing: cfg.heuristics?.continuePing ?? true,
        blockedResolvedMarkers: cfg.heuristics?.blockedResolvedMarkers
          ? [...cfg.heuristics.blockedResolvedMarkers]
          : undefined,
      },
      ruleErrors: [...ruleErrors],
      poolLabels: [...poolLabels],
      councilLabels: [...councilLabels],
      judgeLabel,
      judgeIsVoter,
      usingSessionModel: poolLabels.length === 0,
      tierStats: tierCounter.snapshot(),
    };
  }

  function getConfig(): BrainConfig {
    return brainConfigForPersist(cfg, adaptiveRisk);
  }

  return {
    dispose() {
      if (disposed) return;
      disposed = true;
      offTierStats?.();
      decisionCache?.stop();
    },
    arbiter: {
      async decide(request) {
        if (disposed) return { type: 'deny', reason: 'Brain runtime disposed.' };
        const decision = await current.decide(request);
        return disposed ? { type: 'deny', reason: 'Brain runtime disposed.' } : decision;
      },
    },
    getMode: () => cfg.mode ?? 'interactive',
    getMaxAutoRisk: effectiveMaxAutoRisk,
    getHumanTimeoutMs: effectiveHumanTimeout,
    getSnapshot,
    getConfig,
    apply(patch, applyOpts) {
      if (disposed) throw new Error('Brain runtime disposed.');
      const { next, rebuildNeeded } = mergeBrainConfigPatch(cfg, patch);
      if (patch.maxAutoRisk !== undefined) adaptiveRisk = false;
      cfg = next;
      // Ledger enablement is host-owned state — toggle it BEFORE rebuilding
      // so the guard wrap sees the new value.
      if (
        patch.ledger !== undefined &&
        (patch.ledger === null || patch.ledger.enabled !== undefined)
      ) {
        opts.ledger?.setEnabled(patch.ledger?.enabled ?? true);
      }
      if (rebuildNeeded) rebuild();
      else decisionCache?.clear();
      const snapshot = getSnapshot();
      const persisted =
        applyOpts?.persist === false ? Promise.resolve({ ok: true }) : persistConfig(getConfig());
      opts.onApplied?.(snapshot);
      return { snapshot, persisted };
    },
    explain(request: BrainDecisionRequest): BrainDecisionExplanation {
      let systemOneEnabled = false;
      if ((request.options?.length ?? 0) > 1) {
        try {
          const judge = opts.getSystemOneJudge?.();
          systemOneEnabled = judge !== undefined && judge.unavailableReason === undefined;
        } catch {
          /* An unavailable account defers, as in real arbitration. */
        }
      }
      return explainBrainDecision(request, {
        ledger: opts.ledger,
        ledgerAutoDenyAfterFailures: cfg.ledger?.autoDenyAfterFailures,
        cache: decisionCache,
        rules: compiledRules,
        peekRule,
        systemOneEnabled,
        llmCircuitOpen: circuit ? !circuit.canAttempt() : false,
        llmDenyIsTerminal: cfg.llm?.denyIsTerminal ?? 'when-decided',
        heuristics: cfg.heuristics,
        maxAutoRisk: effectiveMaxAutoRisk(),
        council: {
          enabled: councilLabels.length > 0,
          minRisk: cfg.council?.minRisk ?? 'high',
        },
        mode: cfg.mode ?? 'interactive',
        terminalPolicy: cfg.terminalPolicy ?? 'conservative',
      });
    },
    getTierStats: () => tierCounter.snapshot(),
  };
}
export type {
  BrainApplyResult,
  BrainConfigPatch,
  BrainConfigSnapshot,
  BrainCouncilMinRisk,
  BrainCouncilPatch,
  BrainPoolStrategy,
  BrainRuntime,
  BrainRuntimeLedgerHost,
  BrainRuntimeOptions,
} from './brain-runtime-types.js';
