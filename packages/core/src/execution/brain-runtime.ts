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

import {
  type BrainArbiter,
  type BrainDecisionRequest,
  type BrainEscalationMode,
  type BrainTerminalPolicy,
  DefaultBrainArbiter,
} from '../coordination/brain.js';
import { BrainDecisionCache, createCachingBrainArbiter } from '../coordination/brain-cache.js';
import type { BrainHeuristicsConfig } from '../coordination/brain-heuristics.js';
import { createLedgerGuardBrainArbiter } from '../coordination/brain-ledger.js';
import {
  type BrainRule,
  type CompiledBrainRule,
  compileBrainRules,
  createRuleBrainArbiter,
} from '../coordination/brain-rules.js';
import { parseModelRef } from '../core/fallback-model.js';
import type { EventBus } from '../kernel/events.js';
import type { BrainConfig, BrainCouncilVoterConfig, BrainModelEntry } from '../types/config.js';
import type { Provider } from '../types/provider.js';
import {
  type BrainAutoRisk,
  createTieredBrainArbiter,
  DEFAULT_BRAIN_MAX_TOKENS,
} from './autonomy-brain.js';
import { assembleBrainTiers } from './brain-chain.js';
import { BrainCircuitBreaker } from './brain-circuit.js';
import {
  AUTO_RISK_LEVELS,
  COUNCIL_DISTINCTNESS,
  COUNCIL_MIN_RISKS,
  DENY_TERMINAL_MODES,
  KNOWN_PATCH_KEYS,
  TERMINAL_POLICIES,
  TRACE_CONTENT_MODES,
} from './brain-runtime-constants.js';
import { MAX_COUNCIL_DELIBERATION_ROUNDS } from './council-profiles.js';

export type BrainCouncilMinRisk = 'medium' | 'high' | 'critical';
export type BrainPoolStrategy = 'fallback' | 'round-robin';

/** JSON-safe view of the live Brain configuration + derived facts. */
export interface BrainConfigSnapshot {
  mode: BrainEscalationMode;
  maxAutoRisk: BrainAutoRisk;
  /** Configured pool entries (normalized). Empty = session model. */
  models: BrainModelEntry[];
  strategy: BrainPoolStrategy;
  decisionTimeoutMs: number | undefined;
  humanTimeoutMs: number | undefined;
  council: {
    /** EFFECTIVE enablement (default rule `voters >= 2` applied). */
    enabled: boolean;
    /** Raw configured value (undefined = default rule decides). */
    configured: boolean | undefined;
    minRisk: BrainCouncilMinRisk;
    /** Explicitly configured voters; seats derived from the pool are visible via `councilLabels`. */
    voters: BrainCouncilVoterConfig[];
    quorum: number | undefined;
    approval: number | undefined;
    judge: BrainModelEntry | undefined;
    perCallTimeoutMs: number | undefined;
    maxConcurrency: number | undefined;
    distinctness: 'none' | 'model' | 'provider';
    voterMaxTokens: number | undefined;
    judgeMaxTokens: number | undefined;
    /** Voting rounds; undefined means the product default (2). */
    deliberationRounds: number | undefined;
    seats: Array<{ persona: string; veto?: boolean | undefined }>;
  };
  ledger: {
    enabled: boolean;
    autoDenyAfterFailures: number | undefined;
    path: string | undefined;
    maxMemoryEntries: number | undefined;
    interventionRetryWindowMs: number | undefined;
  };
  /** Configured deterministic rules, in evaluation order. */
  rules: BrainRule[];
  /** Effective single-LLM quality gate. */
  llm: {
    maxTokens: number;
    rejectUncertain: boolean;
    minConfidence: number;
    denyIsTerminal: 'never' | 'when-decided' | 'always';
  };
  /** Effective replay-trace settings. */
  trace: { enabled: boolean; content: 'none' | 'redacted' | 'full'; path: string | undefined };
  /** Configured monitor overrides (defaults are applied by BrainMonitor itself). */
  monitor: NonNullable<BrainConfig['monitor']>;
  /** Effective headless escalation variant. */
  terminalPolicy: BrainTerminalPolicy;
  /** Effective rolling decision-log size. */
  decisionLogMaxEntries: number;
  /** Live LLM circuit-breaker state, when a breaker is wired. */
  circuit: { state: string; consecutiveFailures: number } | undefined;
  /** Effective decision-cache settings plus live hit/miss counters. */
  cache: {
    enabled: boolean;
    ttlMs: number;
    maxEntries: number;
    hits: number;
    misses: number;
    size: number;
  };
  /** Effective heuristic toggles (defaults filled in). */
  // Spelled out rather than `Required<Omit<BrainHeuristicsConfig, …>>`:
  // `Required` strips the `?` but NOT the explicit `| undefined` these fields
  // carry, so consumers would still see `boolean | undefined` for values the
  // snapshot always resolves.
  heuristics: {
    lowRiskAutoAnswer: boolean;
    blockedResolved: boolean;
    deadlockSkip: boolean;
    retryExhausted: boolean;
    continuePing: boolean;
    blockedResolvedMarkers: string[] | undefined;
  };
  /**
   * Compile diagnostics from the LAST assembly, one per dropped rule. Empty
   * when every configured rule compiled. Surfaced by the settings UIs so a
   * typo'd pattern is visible instead of silently inert.
   */
  ruleErrors: string[];
  /** Resolved pool labels from the LAST assembly (may be fewer than `models` — unresolvable refs are skipped). */
  poolLabels: string[];
  /** Resolved council seat labels; empty = council effectively disabled. */
  councilLabels: string[];
  /**
   * EFFECTIVE council judge, undefined when no council is wired.
   *
   * Distinct from `council.judge`, which is the CONFIGURED one and is usually
   * absent — the judge is then derived from the pool. Since the judge only
   * runs to break a tie or synthesize a split panel, whether it is one of the
   * seats that produced that tie is the difference between an independent
   * tie-breaker and voter #1 winning twice. Surfacing it is what makes that
   * checkable instead of implicit.
   */
  judgeLabel: string | undefined;
  /**
   * True when the effective judge is also one of the seated voters. Surfaces
   * render this as a warning; they must NOT re-derive it by matching
   * `judgeLabel` against the `councilLabels` display strings.
   */
  judgeIsVoter: boolean;
  usingSessionModel: boolean;
}

/** Council sub-patch. Arrays REPLACE; `null` clears back to the default. */
export interface BrainCouncilPatch {
  enabled?: boolean | null | undefined;
  minRisk?: BrainCouncilMinRisk | null | undefined;
  voters?: Array<string | BrainCouncilVoterConfig> | null | undefined;
  quorum?: number | null | undefined;
  approval?: number | null | undefined;
  judge?: string | BrainModelEntry | null | undefined;
  perCallTimeoutMs?: number | null | undefined;
  maxConcurrency?: number | null | undefined;
  distinctness?: 'none' | 'model' | 'provider' | null | undefined;
  voterMaxTokens?: number | null | undefined;
  judgeMaxTokens?: number | null | undefined;
  deliberationRounds?: number | null | undefined;
  seats?: Array<{ persona: string; veto?: boolean | undefined }> | null | undefined;
}

/**
 * Partial update for the live Brain config. Omitted fields are untouched,
 * `null` clears a field back to its default, arrays replace wholesale.
 */
export interface BrainConfigPatch {
  mode?: BrainEscalationMode | undefined;
  maxAutoRisk?: BrainAutoRisk | undefined;
  models?: Array<string | BrainModelEntry> | null | undefined;
  strategy?: BrainPoolStrategy | null | undefined;
  decisionTimeoutMs?: number | null | undefined;
  humanTimeoutMs?: number | null | undefined;
  /** Replaces the whole table; `null` clears it. Rejected wholesale if any rule is invalid. */
  rules?: BrainRule[] | null | undefined;
  /** Merged field-by-field; `null` clears the whole block back to all-defaults. */
  heuristics?: BrainHeuristicsConfig | null | undefined;
  /** Single-LLM tier quality gate. Merged field-by-field; `null` clears it. */
  llm?: BrainConfig['llm'] | null | undefined;
  /** Replay trace. Merged field-by-field; `null` clears it. */
  trace?: BrainConfig['trace'] | null | undefined;
  /** Headless escalation variant. */
  terminalPolicy?: BrainTerminalPolicy | null | undefined;
  /** Rolling decision-log size for `/brain status`. */
  decisionLogMaxEntries?: number | null | undefined;
  /** Decision cache. Merged field-by-field; `null` clears it. */
  cache?: BrainConfig['cache'] | null | undefined;
  /**
   * Monitor thresholds. Merged field-by-field; `null` clears it.
   *
   * Live, like every other patch field — but the runtime does not own the
   * BrainMonitor, so the HOST must forward `snapshot.monitor` to
   * `BrainMonitor.reconfigure()` from `onApplied`. A host that skips that
   * wiring persists the setting and applies it on the next session.
   */
  monitor?: BrainConfig['monitor'] | null | undefined;
  council?: BrainCouncilPatch | null | undefined;
  ledger?:
    | {
        enabled?: boolean | undefined;
        autoDenyAfterFailures?: number | null | undefined;
        maxMemoryEntries?: number | null | undefined;
        interventionRetryWindowMs?: number | null | undefined;
      }
    | null
    | undefined;
}

/** Host-owned ledger controller — the runtime never touches ledger files. */
export interface BrainRuntimeLedgerHost {
  getPath: () => string | undefined;
  isEnabled: () => boolean;
  /** Host starts/stops its BrainDecisionLedger instance. */
  setEnabled: (enabled: boolean) => void;
  failureStreakFor?:
    | ((request: Pick<BrainDecisionRequest, 'source' | 'question' | 'id'>) => number)
    | undefined;
  getDecisionDigest?: ((request: BrainDecisionRequest) => string | undefined) | undefined;
}

export interface BrainRuntimeOptions {
  /** Boot-time `config.brain`. Invalid entries are dropped leniently here (apply() is strict). */
  initialConfig: BrainConfig | undefined;
  /** The session's provider id (`config.provider`). */
  defaultProviderId: string;
  /** Live session provider — read per decision so `/setmodel` switches apply. */
  sessionProvider: () => Provider;
  /** Live session model id — read per decision. */
  sessionModel: () => string;
  /** Resolve a NON-default provider id. May throw / return null → entry skipped. */
  resolveProvider: (providerId: string, model: string) => Provider | null;
  ledger?: BrainRuntimeLedgerHost | undefined;
  /**
   * Injected writer for the canonical `BrainConfig`. MUST target the global
   * config (`config.brain` is denied in project scope). Absent = live-only.
   */
  persist?: ((config: BrainConfig) => Promise<void>) | undefined;
  /** Fired after every successful apply, with the fresh snapshot. */
  onApplied?: ((snapshot: BrainConfigSnapshot) => void) | undefined;
  /** Bus for Brain trace events. Absent = no LLM/council tracing. */
  events?: EventBus | undefined;
}

export interface BrainApplyResult {
  snapshot: BrainConfigSnapshot;
  /** Resolves `{ok: true}` immediately when persistence was skipped or absent. */
  persisted: Promise<{ ok: boolean; error?: string | undefined }>;
}

export interface BrainRuntime {
  /** STABLE arbiter handle — the inner tier chain swaps on `apply`. */
  arbiter: BrainArbiter;
  getMode(): BrainEscalationMode;
  getMaxAutoRisk(): BrainAutoRisk;
  getHumanTimeoutMs(): number | undefined;
  getSnapshot(): BrainConfigSnapshot;
  /** Canonical shape written to `config.brain` (compact string refs where lossless). */
  getConfig(): BrainConfig;
  /** Live-apply synchronously; persistence (default on) is async best-effort. */
  apply(patch: BrainConfigPatch, opts?: { persist?: boolean | undefined }): BrainApplyResult;
}

function normalizeEntry(raw: string | BrainModelEntry): BrainModelEntry {
  const parsed =
    typeof raw === 'string'
      ? (parseModelRef(raw) as { provider?: string | undefined; model?: string | undefined })
      : raw;
  const model = parsed.model?.trim();
  if (!model) {
    throw new Error(
      `Invalid model ref: ${typeof raw === 'string' ? `"${raw}"` : JSON.stringify(raw)} (expected "model" or "provider/model")`,
    );
  }
  const provider = parsed.provider?.trim();
  return provider ? { provider, model } : { model };
}

function normalizeVoter(raw: string | BrainCouncilVoterConfig): BrainCouncilVoterConfig {
  if (typeof raw === 'string') return normalizeEntry(raw);
  const base = normalizeEntry(raw);
  const voter: BrainCouncilVoterConfig = { ...base };
  if (raw.persona !== undefined) voter.persona = raw.persona;
  if (raw.weight !== undefined) {
    if (!Number.isFinite(raw.weight) || raw.weight <= 0) {
      throw new Error(`Invalid voter weight: ${String(raw.weight)} (must be a positive number)`);
    }
    voter.weight = raw.weight;
  }
  if (raw.veto !== undefined) voter.veto = raw.veto;
  return voter;
}

function requireFraction(value: number, label: string): number {
  if (!Number.isFinite(value) || value <= 0 || value > 1) {
    throw new Error(`Invalid ${label}: ${String(value)} (must be in (0, 1])`);
  }
  return value;
}

function requirePositiveMs(value: number, label: string): number {
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(
      `Invalid ${label}: ${String(value)} (must be a positive number of milliseconds)`,
    );
  }
  return Math.round(value);
}

/** Compact a normalized entry to the friendliest lossless config form. */
function compactEntry(entry: BrainModelEntry): string {
  return entry.provider ? `${entry.provider}/${entry.model}` : entry.model;
}

function compactVoter(voter: BrainCouncilVoterConfig): string | BrainCouncilVoterConfig {
  if (voter.persona === undefined && voter.weight === undefined && voter.veto === undefined) {
    return compactEntry(voter);
  }
  return { ...voter };
}

export interface BrainDefaultsContext {
  /** The session's fallback chain (`config.fallbackModels`) — seeds the default pool. */
  fallbackModels?: readonly string[] | undefined;
}

/**
 * Product defaults for hosts that want a minimum-human Brain out of the box
 * (CLI/TUI wiring and the standalone WebUI server both apply this before
 * `createBrainRuntime`). Only FILLS GAPS — every explicitly configured field
 * wins, so existing `config.brain` blocks are untouched by updates.
 *
 *   - `models`  → the user's own `fallbackModels` chain (never hardcoded
 *     model ids; every install has different providers). With ≥2 entries the
 *     council auto-derives from the pool, so multi-model users get a council
 *     by default.
 *   - `mode`    → 'headless': decisions never block on a human; the terminal
 *     policy (safe default / deny) is the escalation of last resort.
 *   - `maxAutoRisk` → adaptive: 'all' when a council can convene (critical
 *     questions get a multi-model panel), otherwise 'high' (critical
 *     questions resolve via the conservative terminal policy instead of a
 *     single unchecked model).
 *   - `humanTimeoutMs` → 120s: if the user explicitly switches back to
 *     'interactive', an unanswered prompt still auto-resolves instead of
 *     hanging an unattended run forever. Set `humanTimeoutMs: 0` to restore
 *     the legacy wait-indefinitely behavior.
 *
 * NOTE deliberately NOT persisted anywhere — resolved at boot, so existing
 * users pick these up on update without any config migration/write.
 */
export function resolveBrainConfigDefaults(
  brain: BrainConfig | undefined,
  ctx: BrainDefaultsContext = {},
): BrainConfig {
  const cfg: BrainConfig = { ...(brain ?? {}) };
  if (cfg.models === undefined && ctx.fallbackModels && ctx.fallbackModels.length > 0) {
    cfg.models = [...ctx.fallbackModels];
  }
  const seatCount = cfg.council?.voters?.length ?? cfg.models?.length ?? 0;
  const councilLikely = cfg.council?.enabled ?? seatCount >= 2;
  if (cfg.mode === undefined) cfg.mode = 'headless';
  if (cfg.maxAutoRisk === undefined) cfg.maxAutoRisk = councilLikely ? 'all' : 'high';
  if (cfg.humanTimeoutMs === undefined) cfg.humanTimeoutMs = 120_000;
  return cfg;
}

/** Lenient boot-time normalization: bad entries are dropped, not fatal. */
function normalizeInitial(config: BrainConfig | undefined): BrainConfig {
  const cfg: BrainConfig = { ...(config ?? {}) };
  const safe = <T, R>(items: readonly T[] | undefined, map: (item: T) => R): R[] =>
    (items ?? []).flatMap((item) => {
      try {
        return [map(item)];
      } catch {
        return [];
      }
    });
  if (cfg.models) cfg.models = safe(cfg.models, normalizeEntry);
  // Rules are validated at COMPILE time (rebuild), where a bad rule disables
  // only itself and reports through `ruleErrors`. Nothing to drop here — but
  // a non-array from a hand-edited config would break compilation, so guard.
  if (cfg.rules !== undefined && !Array.isArray(cfg.rules)) cfg.rules = undefined;
  if (cfg.council) {
    const council = { ...cfg.council };
    if (council.voters) council.voters = safe(council.voters, normalizeVoter);
    if (council.judge) {
      try {
        council.judge = normalizeEntry(council.judge);
      } catch {
        council.judge = undefined;
      }
    }
    cfg.council = council;
  }
  return cfg;
}

export function createBrainRuntime(opts: BrainRuntimeOptions): BrainRuntime {
  let cfg: BrainConfig = normalizeInitial(opts.initialConfig);
  let poolLabels: string[] = [];
  let councilLabels: string[] = [];
  let judgeLabel: string | undefined;
  let judgeIsVoter = false;
  let circuit: BrainCircuitBreaker | undefined;
  let decisionCache: BrainDecisionCache | undefined;
  let compiledRules: CompiledBrainRule[] = [];
  let ruleErrors: string[] = [];
  let current: BrainArbiter;

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
      getMaxAutoRisk: () => cfg.maxAutoRisk ?? 'medium',
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
    });

    // Deterministic rules sit in FRONT of the tiered chain so a configured
    // rule settles the question before the policy/council/LLM ladder runs.
    // Compiled once per rebuild; the arbiter reads the array by reference so
    // there is no per-decision compilation cost.
    const compileResult = compileBrainRules(cfg.rules);
    compiledRules = compileResult.rules;
    ruleErrors = compileResult.errors;
    const ruled: BrainArbiter =
      compiledRules.length > 0
        ? createRuleBrainArbiter({
            inner: tiered,
            getRules: () => compiledRules,
            events: opts.events,
          })
        : tiered;

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

  /** Merge + validate a patch into a NEW config. Throws before any state changes. */
  function mergePatch(patch: BrainConfigPatch): { next: BrainConfig; rebuildNeeded: boolean } {
    const next: BrainConfig = { ...cfg, council: cfg.council ? { ...cfg.council } : undefined };
    let rebuildNeeded = false;
    const structural = (): void => {
      rebuildNeeded = true;
    };

    if (patch.mode !== undefined) {
      if (patch.mode !== 'headless' && patch.mode !== 'interactive') {
        throw new Error(`Invalid mode: ${String(patch.mode)}`);
      }
      next.mode = patch.mode;
    }
    if (patch.maxAutoRisk !== undefined) {
      if (!AUTO_RISK_LEVELS.has(patch.maxAutoRisk)) {
        throw new Error(`Invalid maxAutoRisk: ${String(patch.maxAutoRisk)}`);
      }
      next.maxAutoRisk = patch.maxAutoRisk;
    }
    if (patch.humanTimeoutMs !== undefined) {
      next.humanTimeoutMs =
        patch.humanTimeoutMs === null
          ? undefined
          : requirePositiveMs(patch.humanTimeoutMs, 'humanTimeoutMs');
    }
    if (patch.models !== undefined) {
      next.models = patch.models === null ? undefined : patch.models.map(normalizeEntry);
      structural();
    }
    if (patch.strategy !== undefined) {
      if (
        patch.strategy !== null &&
        patch.strategy !== 'fallback' &&
        patch.strategy !== 'round-robin'
      ) {
        throw new Error(`Invalid strategy: ${String(patch.strategy)}`);
      }
      next.strategy = patch.strategy ?? undefined;
      structural();
    }
    if (patch.decisionTimeoutMs !== undefined) {
      next.decisionTimeoutMs =
        patch.decisionTimeoutMs === null
          ? undefined
          : requirePositiveMs(patch.decisionTimeoutMs, 'decisionTimeoutMs');
      structural();
    }
    if (patch.heuristics !== undefined) {
      if (patch.heuristics === null) {
        next.heuristics = undefined;
      } else {
        const h: BrainHeuristicsConfig = { ...(next.heuristics ?? {}) };
        for (const key of [
          'lowRiskAutoAnswer',
          'blockedResolved',
          'deadlockSkip',
          'retryExhausted',
          'continuePing',
        ] as const) {
          const value = patch.heuristics[key];
          if (value === undefined) continue;
          if (typeof value !== 'boolean') {
            throw new Error(`Invalid heuristics.${key}: expected a boolean`);
          }
          h[key] = value;
        }
        if (patch.heuristics.blockedResolvedMarkers !== undefined) {
          const markers = patch.heuristics.blockedResolvedMarkers;
          if (markers !== null && !Array.isArray(markers)) {
            throw new Error('Invalid heuristics.blockedResolvedMarkers: expected an array');
          }
          h.blockedResolvedMarkers = markers ?? undefined;
        }
        next.heuristics = h;
      }
      structural();
    }
    if (patch.rules !== undefined) {
      if (patch.rules === null) {
        next.rules = undefined;
      } else {
        if (!Array.isArray(patch.rules)) throw new Error('Invalid rules: expected an array');
        // apply() is STRICT where boot is lenient: an interactive edit that
        // silently dropped half its rules would be worse than a clear error.
        const { errors } = compileBrainRules(patch.rules);
        if (errors.length > 0) {
          throw new Error(`Invalid Brain rule(s): ${errors.join('; ')}`);
        }
        next.rules = [...patch.rules];
      }
      structural();
    }
    if (patch.council !== undefined) {
      if (patch.council === null) {
        next.council = undefined;
      } else {
        const c = { ...(next.council ?? {}) };
        const p = patch.council;
        if (p.enabled !== undefined) c.enabled = p.enabled === null ? undefined : p.enabled;
        if (p.minRisk !== undefined) {
          if (p.minRisk !== null && !COUNCIL_MIN_RISKS.has(p.minRisk)) {
            throw new Error(`Invalid council minRisk: ${String(p.minRisk)}`);
          }
          c.minRisk = p.minRisk ?? undefined;
        }
        if (p.voters !== undefined) {
          c.voters = p.voters === null ? undefined : p.voters.map(normalizeVoter);
        }
        if (p.quorum !== undefined) {
          c.quorum = p.quorum === null ? undefined : requireFraction(p.quorum, 'council quorum');
        }
        if (p.approval !== undefined) {
          c.approval =
            p.approval === null ? undefined : requireFraction(p.approval, 'council approval');
        }
        if (p.judge !== undefined) {
          c.judge = p.judge === null ? undefined : normalizeEntry(p.judge);
        }
        for (const key of [
          'perCallTimeoutMs',
          'maxConcurrency',
          'voterMaxTokens',
          'judgeMaxTokens',
          'deliberationRounds',
        ] as const) {
          const v = p[key];
          if (v === undefined) continue;
          if (v !== null && (!Number.isInteger(v) || v <= 0)) {
            throw new Error(`Invalid council.${key}: ${String(v)} (must be a positive integer)`);
          }
          // Every round costs one provider call PER SEAT and blocks the
          // decision for its whole duration; an unbounded value from config
          // would turn one decision into an open-ended debate.
          if (key === 'deliberationRounds' && v !== null && v > MAX_COUNCIL_DELIBERATION_ROUNDS) {
            throw new Error(
              `Invalid council.deliberationRounds: ${String(v)} (max ${MAX_COUNCIL_DELIBERATION_ROUNDS})`,
            );
          }
          c[key] = v ?? undefined;
        }
        if (p.distinctness !== undefined) {
          if (p.distinctness !== null && !COUNCIL_DISTINCTNESS.has(p.distinctness)) {
            throw new Error(`Invalid council.distinctness: ${String(p.distinctness)}`);
          }
          c.distinctness = p.distinctness ?? undefined;
        }
        if (p.seats !== undefined) {
          if (p.seats === null) {
            c.seats = undefined;
          } else {
            if (!Array.isArray(p.seats))
              throw new Error('Invalid council.seats: expected an array');
            for (const seat of p.seats) {
              if (!seat?.persona?.trim()) {
                throw new Error('Invalid council.seats: every seat needs a persona');
              }
            }
            c.seats = p.seats.map((seat) => ({ ...seat }));
          }
        }
        next.council = c;
      }
      structural();
    }
    if (patch.terminalPolicy !== undefined) {
      if (patch.terminalPolicy !== null && !TERMINAL_POLICIES.has(patch.terminalPolicy)) {
        throw new Error(`Invalid terminalPolicy: ${String(patch.terminalPolicy)}`);
      }
      next.terminalPolicy = patch.terminalPolicy ?? undefined;
    }
    if (patch.decisionLogMaxEntries !== undefined) {
      const n = patch.decisionLogMaxEntries;
      if (n !== null && (!Number.isInteger(n) || n <= 0)) {
        throw new Error(`Invalid decisionLogMaxEntries: ${String(n)} (must be a positive integer)`);
      }
      next.decisionLogMaxEntries = n ?? undefined;
    }
    if (patch.cache !== undefined) {
      if (patch.cache === null) {
        next.cache = undefined;
      } else {
        const c = { ...(next.cache ?? {}) };
        if (patch.cache.enabled !== undefined) {
          if (typeof patch.cache.enabled !== 'boolean') {
            throw new Error('Invalid cache.enabled: expected a boolean');
          }
          c.enabled = patch.cache.enabled;
        }
        for (const key of ['ttlMs', 'maxEntries'] as const) {
          const v = patch.cache[key];
          if (v === undefined) continue;
          if (!Number.isInteger(v) || v <= 0) {
            throw new Error(`Invalid cache.${key}: ${String(v)} (must be a positive integer)`);
          }
          c[key] = v;
        }
        next.cache = c;
      }
      structural();
    }
    if (patch.llm !== undefined) {
      if (patch.llm === null) {
        next.llm = undefined;
      } else {
        const l = { ...(next.llm ?? {}) };
        if (patch.llm.maxTokens !== undefined) {
          const n = patch.llm.maxTokens;
          if (!Number.isInteger(n) || n <= 0) {
            throw new Error(`Invalid llm.maxTokens: ${String(n)} (must be a positive integer)`);
          }
          l.maxTokens = n;
        }
        if (patch.llm.rejectUncertain !== undefined) {
          if (typeof patch.llm.rejectUncertain !== 'boolean') {
            throw new Error('Invalid llm.rejectUncertain: expected a boolean');
          }
          l.rejectUncertain = patch.llm.rejectUncertain;
        }
        if (patch.llm.denyIsTerminal !== undefined) {
          if (!DENY_TERMINAL_MODES.has(patch.llm.denyIsTerminal)) {
            throw new Error(`Invalid llm.denyIsTerminal: ${String(patch.llm.denyIsTerminal)}`);
          }
          l.denyIsTerminal = patch.llm.denyIsTerminal;
        }
        if (patch.llm.minConfidence !== undefined) {
          const n = patch.llm.minConfidence;
          if (!Number.isFinite(n) || n < 0 || n > 1) {
            throw new Error(`Invalid llm.minConfidence: ${String(n)} (must be in [0, 1])`);
          }
          l.minConfidence = n;
        }
        next.llm = l;
      }
      structural();
    }
    if (patch.trace !== undefined) {
      if (patch.trace === null) {
        next.trace = undefined;
      } else {
        const t = { ...(next.trace ?? {}) };
        if (patch.trace.enabled !== undefined) {
          if (typeof patch.trace.enabled !== 'boolean') {
            throw new Error('Invalid trace.enabled: expected a boolean');
          }
          t.enabled = patch.trace.enabled;
        }
        if (patch.trace.content !== undefined) {
          if (!TRACE_CONTENT_MODES.has(patch.trace.content)) {
            throw new Error(`Invalid trace.content: ${String(patch.trace.content)}`);
          }
          t.content = patch.trace.content;
        }
        if (patch.trace.path !== undefined) t.path = patch.trace.path || undefined;
        if (patch.trace.maxOpenRecords !== undefined) {
          const n = patch.trace.maxOpenRecords;
          if (!Number.isInteger(n) || n <= 0) {
            throw new Error(
              `Invalid trace.maxOpenRecords: ${String(n)} (must be a positive integer)`,
            );
          }
          t.maxOpenRecords = n;
        }
        next.trace = t;
      }
      structural();
    }
    if (patch.monitor !== undefined) {
      next.monitor =
        patch.monitor === null ? undefined : { ...(next.monitor ?? {}), ...patch.monitor };
      structural();
    }
    if (patch.ledger !== undefined) {
      if (patch.ledger === null) {
        next.ledger = undefined;
      } else {
        const l = { ...(next.ledger ?? {}) };
        if (patch.ledger.enabled !== undefined) l.enabled = patch.ledger.enabled;
        if (patch.ledger.autoDenyAfterFailures !== undefined) {
          const n = patch.ledger.autoDenyAfterFailures;
          if (n !== null && (!Number.isInteger(n) || n < 0)) {
            throw new Error(
              `Invalid autoDenyAfterFailures: ${String(n)} (must be an integer >= 0)`,
            );
          }
          l.autoDenyAfterFailures = n ?? undefined;
        }
        for (const key of ['maxMemoryEntries', 'interventionRetryWindowMs'] as const) {
          const v = patch.ledger[key];
          if (v === undefined) continue;
          if (v !== null && (!Number.isInteger(v) || v <= 0)) {
            throw new Error(`Invalid ledger.${key}: ${String(v)} (must be a positive integer)`);
          }
          l[key] = v ?? undefined;
        }
        next.ledger = l;
      }
      structural();
    }

    // Structural keys already flagged themselves above; anything not covered
    // by either key set is a typo or a field that was added to the patch type
    // without being registered here, and must fail loudly.
    for (const key of Object.keys(patch)) {
      if ((patch as Record<string, unknown>)[key] === undefined) continue;
      if (!KNOWN_PATCH_KEYS.has(key)) {
        throw new Error(`Unknown brain config field: ${key}`);
      }
    }
    return { next, rebuildNeeded };
  }

  function getSnapshot(): BrainConfigSnapshot {
    const councilCfg = cfg.council;
    const voters = (councilCfg?.voters ?? []).map((v) => normalizeVoter(v));
    return {
      mode: cfg.mode ?? 'interactive',
      maxAutoRisk: cfg.maxAutoRisk ?? 'medium',
      models: (cfg.models ?? []).map((m) => normalizeEntry(m)),
      strategy: cfg.strategy ?? 'fallback',
      decisionTimeoutMs: cfg.decisionTimeoutMs,
      humanTimeoutMs: cfg.humanTimeoutMs,
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
        maxTokens: cfg.llm?.maxTokens ?? DEFAULT_BRAIN_MAX_TOKENS,
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
      usingSessionModel: (cfg.models ?? []).length === 0,
    };
  }

  function getConfig(): BrainConfig {
    const out: BrainConfig = {};
    if (cfg.mode !== undefined) out.mode = cfg.mode;
    if (cfg.maxAutoRisk !== undefined) out.maxAutoRisk = cfg.maxAutoRisk;
    if (cfg.models?.length) out.models = cfg.models.map((m) => compactEntry(normalizeEntry(m)));
    if (cfg.strategy !== undefined) out.strategy = cfg.strategy;
    if (cfg.decisionTimeoutMs !== undefined) out.decisionTimeoutMs = cfg.decisionTimeoutMs;
    if (cfg.humanTimeoutMs !== undefined) out.humanTimeoutMs = cfg.humanTimeoutMs;
    if (cfg.council !== undefined) {
      const c = cfg.council;
      const outCouncil: NonNullable<BrainConfig['council']> = {};
      if (c.enabled !== undefined) outCouncil.enabled = c.enabled;
      if (c.minRisk !== undefined) outCouncil.minRisk = c.minRisk;
      if (c.voters?.length)
        outCouncil.voters = c.voters.map((v) => compactVoter(normalizeVoter(v)));
      if (c.quorum !== undefined) outCouncil.quorum = c.quorum;
      if (c.approval !== undefined) outCouncil.approval = c.approval;
      if (c.judge !== undefined) outCouncil.judge = compactEntry(normalizeEntry(c.judge));
      // Same rule as the top level: a field missing here is DELETED from the
      // user's config on the next apply(). Guarded by brain-config-roundtrip.
      if (c.perCallTimeoutMs !== undefined) outCouncil.perCallTimeoutMs = c.perCallTimeoutMs;
      if (c.maxConcurrency !== undefined) outCouncil.maxConcurrency = c.maxConcurrency;
      if (c.distinctness !== undefined) outCouncil.distinctness = c.distinctness;
      if (c.voterMaxTokens !== undefined) outCouncil.voterMaxTokens = c.voterMaxTokens;
      if (c.judgeMaxTokens !== undefined) outCouncil.judgeMaxTokens = c.judgeMaxTokens;
      if (c.deliberationRounds !== undefined) outCouncil.deliberationRounds = c.deliberationRounds;
      if (c.seats?.length) outCouncil.seats = c.seats.map((seat) => ({ ...seat }));
      out.council = outCouncil;
    }
    if (cfg.rules?.length) out.rules = cfg.rules.map((rule) => ({ ...rule }));
    if (cfg.heuristics !== undefined) out.heuristics = { ...cfg.heuristics };
    if (cfg.ledger !== undefined) out.ledger = { ...cfg.ledger };
    if (cfg.monitor !== undefined) out.monitor = { ...cfg.monitor };
    // Blocks that are boot-only (no patch surface yet) must STILL be copied:
    // `apply()` persists this object wholesale, so a field missing here is
    // silently deleted from the user's config the next time any Brain
    // setting changes. `brain-config-roundtrip` guards this.
    if (cfg.trace !== undefined) out.trace = { ...cfg.trace };
    if (cfg.llm !== undefined) out.llm = { ...cfg.llm };
    if (cfg.cache !== undefined) out.cache = { ...cfg.cache };
    if (cfg.terminalPolicy !== undefined) out.terminalPolicy = cfg.terminalPolicy;
    if (cfg.decisionLogMaxEntries !== undefined) {
      out.decisionLogMaxEntries = cfg.decisionLogMaxEntries;
    }
    return out;
  }

  return {
    arbiter: {
      decide: (request) => current.decide(request),
    },
    getMode: () => cfg.mode ?? 'interactive',
    getMaxAutoRisk: () => cfg.maxAutoRisk ?? 'medium',
    getHumanTimeoutMs: () => cfg.humanTimeoutMs,
    getSnapshot,
    getConfig,
    apply(patch, applyOpts) {
      const { next, rebuildNeeded } = mergePatch(patch);
      cfg = next;
      // Ledger enablement is host-owned state — toggle it BEFORE rebuilding
      // so the guard wrap sees the new value.
      if (patch.ledger && patch.ledger.enabled !== undefined) {
        opts.ledger?.setEnabled(patch.ledger.enabled);
      }
      if (rebuildNeeded) rebuild();
      const snapshot = getSnapshot();
      const shouldPersist = applyOpts?.persist !== false && opts.persist !== undefined;
      const persisted: Promise<{ ok: boolean; error?: string | undefined }> = shouldPersist
        ? (opts.persist as (config: BrainConfig) => Promise<void>)(getConfig()).then(
            () => ({ ok: true }),
            (err: unknown) => ({
              ok: false,
              error: err instanceof Error ? err.message : String(err),
            }),
          )
        : Promise.resolve({ ok: true });
      opts.onApplied?.(snapshot);
      return { snapshot, persisted };
    },
  };
}
