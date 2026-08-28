interface BrainModelEntryWire {
  provider?: string | undefined;
  model: string;
}

/** One Brain council voting seat on the wire. */
export interface BrainCouncilVoterWire extends BrainModelEntryWire {
  persona?: string | undefined;
  weight?: number | undefined;
  veto?: boolean | undefined;
}

/** Predicate half of a deterministic Brain rule on the wire (mirrors BrainRuleMatch). */
interface BrainRuleMatchWire {
  source?: string | string[] | undefined;
  risk?: string | string[] | undefined;
  minRisk?: string | undefined;
  maxRisk?: string | undefined;
  fallback?: string | string[] | undefined;
  hasOptions?: boolean | undefined;
  offersOption?: string | undefined;
  question?: string | undefined;
  context?: string | undefined;
  notQuestion?: string | undefined;
  notContext?: string | undefined;
}

/** Action half of a deterministic Brain rule on the wire (mirrors BrainRuleAction). */
type BrainRuleActionWire =
  | {
      action: 'answer';
      optionId?: string | undefined;
      text?: string | undefined;
      rationale?: string | undefined;
    }
  | { action: 'deny'; reason?: string | undefined }
  | { action: 'escalate'; prompt?: string | undefined }
  | { action: 'defer' };

/** One deterministic Brain rule on the wire (mirrors core's BrainRule). */
interface BrainRuleWire {
  id: string;
  enabled?: boolean | undefined;
  description?: string | undefined;
  when: BrainRuleMatchWire;
  then: BrainRuleActionWire;
}

/** Built-in pattern-heuristic toggles on the wire (mirrors BrainHeuristicsConfig). */
interface BrainHeuristicsWire {
  lowRiskAutoAnswer: boolean;
  blockedResolved: boolean;
  deadlockSkip: boolean;
  retryExhausted: boolean;
  continuePing: boolean;
  blockedResolvedMarkers?: string[] | undefined;
}

/** Writable form of the heuristic toggles (every field optional, `null` clears the block). */
interface BrainHeuristicsPatchWire {
  lowRiskAutoAnswer?: boolean | undefined;
  blockedResolved?: boolean | undefined;
  deadlockSkip?: boolean | undefined;
  retryExhausted?: boolean | undefined;
  continuePing?: boolean | undefined;
  blockedResolvedMarkers?: string[] | undefined;
}

/** Effective single-LLM tier quality gate. */
interface BrainLlmWire {
  maxTokens: number;
  rejectUncertain: boolean;
  minConfidence: number;
  denyIsTerminal: 'never' | 'when-decided' | 'always';
}

/** Writable single-LLM tier quality gate. */
interface BrainLlmPatchWire {
  maxTokens?: number | undefined;
  rejectUncertain?: boolean | undefined;
  minConfidence?: number | undefined;
  denyIsTerminal?: 'never' | 'when-decided' | 'always' | undefined;
  circuitBreaker?:
    | {
        failureThreshold?: number | undefined;
        cooldownMs?: number | undefined;
      }
    | undefined;
}

/** Effective replay-trace settings. */
interface BrainTraceWire {
  enabled: boolean;
  content: 'none' | 'redacted' | 'full';
  path?: string | undefined;
}

/** Writable replay-trace settings. */
interface BrainTracePatchWire {
  enabled?: boolean | undefined;
  content?: 'none' | 'redacted' | 'full' | undefined;
  path?: string | undefined;
  maxOpenRecords?: number | undefined;
}

/** BrainMonitor distress-signal settings (same shape read + written). */
interface BrainMonitorWire {
  enabled?: boolean | undefined;
  policy?: 'llm' | 'steer' | 'observe' | undefined;
  signals?:
    | {
        toolFailureStreak?: boolean | undefined;
        errorStorm?: boolean | undefined;
        agentStall?: boolean | undefined;
        fileChurn?: boolean | undefined;
      }
    | undefined;
  toolFailureStreak?: number | undefined;
  errorStormCount?: number | undefined;
  errorStormWindowMs?: number | undefined;
  stallMs?: number | undefined;
  stallCheckIntervalMs?: number | undefined;
  fileChurnThreshold?: number | undefined;
  fileChurnWindowMs?: number | undefined;
  fileEditTools?: string[] | undefined;
  cooldownMs?: number | undefined;
}

/** Effective decision-cache settings plus live counters (`hits`/`misses`/`size` are read-only). */
interface BrainCacheWire {
  enabled: boolean;
  ttlMs: number;
  maxEntries: number;
  hits: number;
  misses: number;
  size: number;
}

/** Writable decision-cache settings. */
interface BrainCachePatchWire {
  enabled?: boolean | undefined;
  ttlMs?: number | undefined;
  maxEntries?: number | undefined;
}

/** One council seat template on the wire. */
interface BrainCouncilSeatWire {
  persona: string;
  veto?: boolean | undefined;
}

/** One selectable Council decision lens, published from the server's registry. */
interface BrainCouncilPersonaWire {
  id: string;
  name: string;
  description: string;
  /** Seats using this lens get veto power unless the seat overrides it. */
  defaultVeto?: boolean | undefined;
}

/** Headless escalation variant. */
type BrainTerminalPolicyWire = 'conservative' | 'deny-all' | 'continue-on-recommended';

/** JSON-safe snapshot of the live Brain config (mirrors core's BrainConfigSnapshot). */
export interface BrainConfigWire {
  mode: 'headless' | 'interactive';
  maxAutoRisk: 'off' | 'low' | 'medium' | 'high' | 'all';
  models: BrainModelEntryWire[];
  strategy: 'fallback' | 'round-robin';
  decisionTimeoutMs?: number | undefined;
  humanTimeoutMs?: number | undefined;
  council: {
    /** EFFECTIVE enablement (voters>=2 default rule applied). */
    enabled: boolean;
    configured?: boolean | undefined;
    minRisk: 'medium' | 'high' | 'critical';
    voters: BrainCouncilVoterWire[];
    quorum?: number | undefined;
    approval?: number | undefined;
    judge?: BrainModelEntryWire | undefined;
    perCallTimeoutMs?: number | undefined;
    maxConcurrency?: number | undefined;
    distinctness: 'none' | 'model' | 'provider';
    voterMaxTokens?: number | undefined;
    judgeMaxTokens?: number | undefined;
    seats: BrainCouncilSeatWire[];
  };
  /**
   * Decision lenses the server's Council persona registry offers. Optional so
   * an older server still renders: the section then falls back to the three
   * lenses it used to hard-code, which is what hid `security`, `maintainer`
   * and `user-advocate` from every surface.
   */
  personaCatalog?: BrainCouncilPersonaWire[] | undefined;
  ledger: {
    enabled: boolean;
    autoDenyAfterFailures?: number | undefined;
    path?: string | undefined;
    /** Writable via the patch; core's snapshot does not echo these back yet. */
    maxMemoryEntries?: number | undefined;
    interventionRetryWindowMs?: number | undefined;
  };
  /** Configured deterministic rules, in evaluation order (read-only here). */
  rules: BrainRuleWire[];
  /** Compile diagnostics from the last assembly — one per dropped rule. */
  ruleErrors: string[];
  heuristics: BrainHeuristicsWire;
  llm: BrainLlmWire;
  trace: BrainTraceWire;
  monitor: BrainMonitorWire;
  terminalPolicy: BrainTerminalPolicyWire;
  decisionLogMaxEntries: number;
  /** Live LLM circuit-breaker state, when a breaker is wired (read-only). */
  circuit?: { state: string; consecutiveFailures: number } | undefined;
  cache: BrainCacheWire;
  poolLabels: string[];
  councilLabels: string[];
  /**
   * EFFECTIVE council judge, undefined when no council is wired. Distinct from
   * `council.judge` (the CONFIGURED one, usually absent): the derived judge is
   * the one that can silently also be a seated voter.
   */
  judgeLabel?: string | undefined;
  /**
   * True when the effective judge is also a seated voter. Resolved server-side
   * — do not re-derive it from the `councilLabels` display strings.
   */
  judgeIsVoter?: boolean | undefined;
  usingSessionModel: boolean;
}

/** Partial Brain config update: omitted = untouched, null = clear, arrays replace. */
export interface BrainConfigPatchWire {
  mode?: 'headless' | 'interactive' | undefined;
  maxAutoRisk?: 'off' | 'low' | 'medium' | 'high' | 'all' | undefined;
  models?: Array<string | BrainModelEntryWire> | null | undefined;
  strategy?: 'fallback' | 'round-robin' | null | undefined;
  decisionTimeoutMs?: number | null | undefined;
  humanTimeoutMs?: number | null | undefined;
  council?:
    | {
        enabled?: boolean | null | undefined;
        minRisk?: 'medium' | 'high' | 'critical' | null | undefined;
        voters?: Array<string | BrainCouncilVoterWire> | null | undefined;
        quorum?: number | null | undefined;
        approval?: number | null | undefined;
        judge?: string | BrainModelEntryWire | null | undefined;
        perCallTimeoutMs?: number | null | undefined;
        maxConcurrency?: number | null | undefined;
        distinctness?: 'none' | 'model' | 'provider' | null | undefined;
        voterMaxTokens?: number | null | undefined;
        judgeMaxTokens?: number | null | undefined;
        seats?: BrainCouncilSeatWire[] | null | undefined;
      }
    | null
    | undefined;
  ledger?:
    | {
        enabled?: boolean | undefined;
        autoDenyAfterFailures?: number | null | undefined;
        maxMemoryEntries?: number | null | undefined;
        interventionRetryWindowMs?: number | null | undefined;
      }
    | null
    | undefined;
  /** Replaces the whole rule table; `null` clears it. */
  rules?: BrainRuleWire[] | null | undefined;
  /** Merged field-by-field; `null` clears the block back to all-defaults. */
  heuristics?: BrainHeuristicsPatchWire | null | undefined;
  llm?: BrainLlmPatchWire | null | undefined;
  trace?: BrainTracePatchWire | null | undefined;
  monitor?: BrainMonitorWire | null | undefined;
  terminalPolicy?: BrainTerminalPolicyWire | null | undefined;
  decisionLogMaxEntries?: number | null | undefined;
  cache?: BrainCachePatchWire | null | undefined;
}
