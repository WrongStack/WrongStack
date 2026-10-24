import type { EventBus } from '@wrongstack/contracts/kernel/events';
import type {
  BrainConfig,
  BrainCouncilVoterConfig,
  BrainModelEntry,
} from '@wrongstack/contracts/types/config';
import type { Provider } from '@wrongstack/contracts/types/provider';
import type {
  BrainArbiter,
  BrainDecisionRequest,
  BrainEscalationMode,
  BrainTerminalPolicy,
} from '../brain/brain.js';
import type { BrainDecisionExplanation } from '../brain/brain-explain.js';
import type { BrainHeuristicsConfig } from '../brain/brain-heuristics.js';
import type { BrainRule } from '../brain/brain-rules.js';
import type { BrainTierStats } from '../brain/brain-telemetry.js';
import type { TypeSafeJudge } from '../typesafe/judgments.js';
import type { BrainAutoRisk } from './autonomy-brain.js';

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
    /** undefined = the model's own output ceiling. */
    maxTokens: number | undefined;
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
  /** Live breakdown of decisions resolved across the ladder tiers. */
  tierStats?: BrainTierStats | undefined;
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
  /** `maxTokens: null` clears the cap back to the model's own ceiling. */
  llm?:
    | (Omit<NonNullable<BrainConfig['llm']>, 'maxTokens'> & {
        maxTokens?: number | null | undefined;
      })
    | null
    | undefined;
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
  /**
   * TypeSafe judge for the System One tier, read per decision so an account
   * that appears, rests or is revoked mid-session is honoured. Absent or
   * returning `undefined` = the tier is skipped.
   */
  getSystemOneJudge?: (() => TypeSafeJudge | undefined) | undefined;
}

export interface BrainApplyResult {
  snapshot: BrainConfigSnapshot;
  /** Resolves `{ok: true}` immediately when persistence was skipped or absent. */
  persisted: Promise<{ ok: boolean; error?: string | undefined }>;
}

export interface BrainRuntime {
  /** Release runtime-owned cache watchers and telemetry subscriptions. */
  dispose(): void;
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
  /**
   * Pure, side-effect-free dry-run simulation of the deterministic decision ladder.
   * Explains which tier resolved (or would resolve) the request and why.
   */
  explain(request: BrainDecisionRequest): BrainDecisionExplanation;
  /** Live tier breakdown metrics. */
  getTierStats(): BrainTierStats;
}
