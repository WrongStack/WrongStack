/**
 * Brain panel data model — pure types + row derivation shared by the
 * reducer (cursor clamping), the key hook (action dispatch), and the
 * component (render). Mirrors the auth-panel pattern: the TUI never
 * touches config files — every mutation goes through the host bridge,
 * which the CLI implements on top of its BrainRuntime (live apply +
 * persist to the global config).
 */

import type { BrainRiskLevel } from './brain-contracts.js';

/** One selectable Council decision lens, as published by the host. */
export interface BrainPanelPersona {
  id: string;
  name: string;
  description: string;
  /** Seats using this lens get veto power unless the seat overrides it. */
  defaultVeto?: boolean | undefined;
}

/** One configured pool entry / council voter, display-mapped. */
export interface BrainPanelVoter {
  label: string;
  persona?: string | undefined;
  veto?: boolean | undefined;
  weight?: number | undefined;
}

/** Editable heuristic toggles, mirroring `BrainConfigSnapshot.heuristics`. */
export interface BrainPanelHeuristics {
  lowRiskAutoAnswer: boolean;
  blockedResolved: boolean;
  deadlockSkip: boolean;
  retryExhausted: boolean;
  continuePing: boolean;
  /** Custom resolution-marker word list (undefined = built-in list). Read-only here. */
  blockedResolvedMarkers?: string[] | undefined;
}

/** Keys of the boolean heuristic toggles — the setter's `key` argument. */
export type BrainHeuristicKey = keyof Omit<BrainPanelHeuristics, 'blockedResolvedMarkers'>;

export type BrainDenyIsTerminal = 'never' | 'when-decided' | 'always';
export type BrainTraceContent = 'none' | 'redacted' | 'full';
export type BrainTerminalPolicyValue = 'conservative' | 'deny-all' | 'continue-on-recommended';

/** Display-mapped snapshot of the live Brain settings. */
export interface BrainPanelSettings {
  mode: 'headless' | 'interactive';
  riskLevel: BrainRiskLevel;
  strategy: 'fallback' | 'round-robin';
  decisionTimeoutMs?: number | undefined;
  humanTimeoutMs?: number | undefined;
  /** Configured pool entries as compact "provider/model" labels. */
  pool: string[];
  /** Resolved pool labels from the last assembly (≤ pool.length). */
  poolResolved: string[];
  usingSessionModel: boolean;
  councilEnabled: boolean;
  councilMinRisk: 'medium' | 'high' | 'critical';
  /** Fraction of seats that must return a valid vote (undefined = default 0.5). */
  councilQuorum?: number | undefined;
  /** Fraction of cast weight the winner must exceed (undefined = default 0.5). */
  councilApproval?: number | undefined;
  /** Panel-diversity warning policy. A same-model panel agrees with itself. */
  councilDistinctness: 'none' | 'model' | 'provider';
  /** Per-seat completion timeout (undefined = inherit the decision timeout). */
  councilPerCallTimeoutMs?: number | undefined;
  /** Seats polled concurrently, 1..8 (undefined = default 3). */
  councilMaxConcurrency?: number | undefined;
  /** Output budget per voter seat call (undefined = default 2000). */
  councilVoterMaxTokens?: number | undefined;
  /** Voting rounds; undefined = product default (2). 1 disables deliberation. */
  councilDeliberationRounds?: number | undefined;
  /** Output budget for the judge call (undefined = follows the seat budget). */
  councilJudgeMaxTokens?: number | undefined;
  /** Explicitly configured voters (empty = seats derive from the pool). */
  voters: BrainPanelVoter[];
  /**
   * Selectable decision lenses, published by the host from the Council persona
   * registry. Absent on hosts that predate the catalog — `personaCycle()` then
   * falls back to the three lenses the panel used to hard-code.
   */
  personaCatalog?: BrainPanelPersona[] | undefined;
  /** Effective council seat labels (empty = council disabled). */
  councilSeats: string[];
  /**
   * EFFECTIVE council judge (resolved, not merely configured). Undefined when
   * no council is wired.
   */
  judgeLabel?: string | undefined;
  /** False when `judgeLabel` was derived from the pool rather than configured. */
  judgeConfigured?: boolean | undefined;
  /** True when the effective judge is also a seated voter (correlated tie-break). */
  judgeIsVoter?: boolean | undefined;
  ledgerEnabled: boolean;
  autoDenyAfterFailures?: number | undefined;
  /** Headless escalation variant. */
  terminalPolicy: BrainTerminalPolicyValue;
  /** Effective heuristic toggles (defaults already filled in by the host). */
  heuristics: BrainPanelHeuristics;
  /** Single-LLM tier quality gate. */
  llmMaxTokens: number;
  llmRejectUncertain: boolean;
  llmMinConfidence: number;
  llmDenyIsTerminal: BrainDenyIsTerminal;
  /** Decision cache: effective settings + LIVE counters (counters read-only). */
  cacheEnabled: boolean;
  cacheTtlMs: number;
  cacheMaxEntries: number;
  cacheHits: number;
  cacheMisses: number;
  cacheSize: number;
  /** Replay trace. `tracePath` is read-only (edited via config). */
  traceEnabled: boolean;
  traceContent: BrainTraceContent;
  tracePath?: string | undefined;
  /** Live LLM circuit-breaker state; undefined = no breaker wired. READ-ONLY. */
  circuitState?: string | undefined;
  circuitFailures?: number | undefined;
  /** Deterministic rule table summary. READ-ONLY. */
  ruleCount: number;
  /** Compile diagnostics from the last assembly, one per dropped rule. READ-ONLY. */
  ruleErrors: string[];
}

/**
 * Host bridge implemented by the CLI. Every setter returns an error string
 * (shown as the panel hint) or null on success; all setters apply LIVE and
 * persist to the active profile config. Model SELECTION is not part of this
 * bridge — the panel uses the shared /model picker via requestModelPick.
 */
export interface BrainPanelHost {
  getSettings(): BrainPanelSettings;
  setMode(mode: 'headless' | 'interactive'): Promise<string | null>;
  setRisk(level: BrainRiskLevel): Promise<string | null>;
  setStrategy(strategy: 'fallback' | 'round-robin'): Promise<string | null>;
  setDecisionTimeout(ms: number | undefined): Promise<string | null>;
  setHumanTimeout(ms: number | undefined): Promise<string | null>;
  addPoolModel(providerId: string, model: string): Promise<string | null>;
  removePoolModel(index: number): Promise<string | null>;
  clearPool(): Promise<string | null>;
  setCouncilEnabled(on: boolean): Promise<string | null>;
  setCouncilMinRisk(risk: 'medium' | 'high' | 'critical'): Promise<string | null>;
  addVoter(providerId: string, model: string): Promise<string | null>;
  removeVoter(index: number): Promise<string | null>;
  cycleVoterPersona(index: number): Promise<string | null>;
  toggleVoterVeto(index: number): Promise<string | null>;
  setJudge(providerId: string, model: string): Promise<string | null>;
  clearJudge(): Promise<string | null>;
  setCouncilQuorum(fraction: number): Promise<string | null>;
  setCouncilApproval(fraction: number): Promise<string | null>;
  setCouncilDistinctness(mode: 'none' | 'model' | 'provider'): Promise<string | null>;
  /**
   * The positive-integer council knobs. `undefined` clears back to the
   * default — unlike the LLM/cache ladders, `BrainCouncilPatch` accepts `null`
   * for these, so a "default" rung is reachable here.
   */
  setCouncilPerCallTimeout(ms: number | undefined): Promise<string | null>;
  setCouncilMaxConcurrency(count: number | undefined): Promise<string | null>;
  setCouncilVoterMaxTokens(tokens: number | undefined): Promise<string | null>;
  setCouncilDeliberationRounds(rounds: number | undefined): Promise<string | null>;
  setCouncilJudgeMaxTokens(tokens: number | undefined): Promise<string | null>;
  setLedgerEnabled(on: boolean): Promise<string | null>;
  setAutoDeny(count: number | undefined): Promise<string | null>;
  setTerminalPolicy(policy: BrainTerminalPolicyValue): Promise<string | null>;
  setHeuristic(key: BrainHeuristicKey, on: boolean): Promise<string | null>;
  /**
   * NOTE the numeric LLM/cache knobs take a plain number: the underlying
   * `BrainConfigPatch` validators reject `null` for these fields ("must be a
   * positive integer"), so there is no "clear back to default" step here —
   * the preset ladders are number-only.
   */
  setLlmMaxTokens(tokens: number): Promise<string | null>;
  setLlmRejectUncertain(on: boolean): Promise<string | null>;
  setLlmMinConfidence(value: number): Promise<string | null>;
  setLlmDenyIsTerminal(mode: BrainDenyIsTerminal): Promise<string | null>;
  setCacheEnabled(on: boolean): Promise<string | null>;
  setCacheTtl(ms: number): Promise<string | null>;
  setCacheMaxEntries(count: number): Promise<string | null>;
  setTraceEnabled(on: boolean): Promise<string | null>;
  setTraceContent(content: BrainTraceContent): Promise<string | null>;
}

/** One selectable row of the settings view. */
export type BrainPanelRow =
  | { kind: 'mode' }
  | { kind: 'risk' }
  | { kind: 'strategy' }
  | { kind: 'timeout' }
  | { kind: 'humanTimeout' }
  | { kind: 'poolModel'; index: number }
  | { kind: 'poolAdd' }
  | { kind: 'councilToggle' }
  | { kind: 'councilMinRisk' }
  | { kind: 'voter'; index: number }
  | { kind: 'voterAdd' }
  | { kind: 'judge' }
  | { kind: 'councilQuorum' }
  | { kind: 'councilApproval' }
  | { kind: 'councilDistinctness' }
  | { kind: 'councilTimeout' }
  | { kind: 'councilConcurrency' }
  | { kind: 'councilVoterMaxTokens' }
  | { kind: 'councilDeliberationRounds' }
  | { kind: 'councilJudgeMaxTokens' }
  | { kind: 'ledgerToggle' }
  | { kind: 'autoDeny' }
  | { kind: 'terminalPolicy' }
  | { kind: 'heuristic'; key: BrainHeuristicKey }
  | { kind: 'llmMaxTokens' }
  | { kind: 'llmRejectUncertain' }
  | { kind: 'llmMinConfidence' }
  | { kind: 'llmDenyIsTerminal' }
  | { kind: 'cacheToggle' }
  | { kind: 'cacheTtl' }
  | { kind: 'cacheMaxEntries' }
  | { kind: 'traceToggle' }
  | { kind: 'traceContent' }
  // ── read-only rows: rendered dim, never adjustable ──
  | { kind: 'cacheStats' }
  | { kind: 'tracePath' }
  | { kind: 'circuit' }
  | { kind: 'rulesSummary' }
  | { kind: 'ruleErrors' };

/**
 * Rows that only REPORT live/derived state. They are rendered dim and are
 * skipped by the adjust/enter handlers — there is nothing to write back.
 */
export const BRAIN_READONLY_ROW_KINDS: ReadonlySet<BrainPanelRow['kind']> = new Set([
  'cacheStats',
  'tracePath',
  'circuit',
  'rulesSummary',
  'ruleErrors',
] satisfies Array<BrainPanelRow['kind']>);

/** Heuristic rows, in display order. */
const BRAIN_HEURISTIC_KEYS: readonly BrainHeuristicKey[] = [
  'lowRiskAutoAnswer',
  'blockedResolved',
  'deadlockSkip',
  'retryExhausted',
  'continuePing',
];

/**
 * Derive the selectable rows for a settings snapshot.
 *
 * Array/optional reads are defensive: this is a pure display function driven
 * by whatever the host last pushed over `brainSettingsLoaded`, and a host that
 * predates a field (or an older persisted payload) must render fewer rows, not
 * crash the whole TUI.
 */
export function brainPanelRows(settings: BrainPanelSettings): BrainPanelRow[] {
  const rows: BrainPanelRow[] = [{ kind: 'mode' }, { kind: 'risk' }];
  const pool = settings.pool ?? [];
  const voters = settings.voters ?? [];
  for (let i = 0; i < pool.length; i += 1) rows.push({ kind: 'poolModel', index: i });
  rows.push({ kind: 'poolAdd' });
  if (pool.length > 1) rows.push({ kind: 'strategy' });
  rows.push({ kind: 'timeout' }, { kind: 'humanTimeout' });
  rows.push({ kind: 'terminalPolicy' });
  rows.push({ kind: 'councilToggle' });
  if (settings.councilEnabled || voters.length > 0) {
    rows.push({ kind: 'councilMinRisk' });
    for (let i = 0; i < voters.length; i += 1) rows.push({ kind: 'voter', index: i });
    rows.push({ kind: 'voterAdd' }, { kind: 'judge' });
    // Resolution + budget knobs. These were WebUI-only, so the panel could
    // seat a council but not say how it resolves or what it may spend.
    rows.push(
      { kind: 'councilQuorum' },
      { kind: 'councilApproval' },
      { kind: 'councilDistinctness' },
      { kind: 'councilTimeout' },
      { kind: 'councilConcurrency' },
      { kind: 'councilVoterMaxTokens' },
      { kind: 'councilJudgeMaxTokens' },
      { kind: 'councilDeliberationRounds' },
    );
  }
  rows.push({ kind: 'ledgerToggle' });
  if (settings.ledgerEnabled) rows.push({ kind: 'autoDeny' });
  for (const key of BRAIN_HEURISTIC_KEYS) rows.push({ kind: 'heuristic', key });
  rows.push(
    { kind: 'llmMaxTokens' },
    { kind: 'llmRejectUncertain' },
    { kind: 'llmMinConfidence' },
    { kind: 'llmDenyIsTerminal' },
  );
  if (settings.circuitState !== undefined) rows.push({ kind: 'circuit' });
  rows.push({ kind: 'cacheToggle' });
  if (settings.cacheEnabled) {
    rows.push({ kind: 'cacheTtl' }, { kind: 'cacheMaxEntries' }, { kind: 'cacheStats' });
  }
  rows.push({ kind: 'traceToggle' });
  if (settings.traceEnabled) {
    rows.push({ kind: 'traceContent' }, { kind: 'tracePath' });
  }
  rows.push({ kind: 'rulesSummary' });
  if ((settings.ruleErrors ?? []).length > 0) rows.push({ kind: 'ruleErrors' });
  return rows;
}

/** Preset ladders for ←/→ cycling on numeric rows. */
export const DECISION_TIMEOUT_PRESETS: ReadonlyArray<number | undefined> = [
  undefined,
  5_000,
  10_000,
  20_000,
  30_000,
  60_000,
];
export const HUMAN_TIMEOUT_PRESETS: ReadonlyArray<number | undefined> = [
  undefined,
  30_000,
  60_000,
  120_000,
  300_000,
];
export const AUTO_DENY_PRESETS: ReadonlyArray<number | undefined> = [undefined, 0, 2, 3, 5];
/**
 * Number-only ladders. The Brain patch validators reject `null` for these
 * fields, so there is no `undefined` ("back to default") rung — the default
 * value itself is the first rung.
 */
export const LLM_MAX_TOKENS_PRESETS: readonly number[] = [200, 400, 800, 1_600, 3_200];
export const LLM_MIN_CONFIDENCE_PRESETS: readonly number[] = [0, 0.3, 0.5, 0.7, 0.9];
export const CACHE_TTL_PRESETS: readonly number[] = [
  60_000, 300_000, 900_000, 1_800_000, 3_600_000,
];
export const CACHE_MAX_ENTRIES_PRESETS: readonly number[] = [50, 100, 200, 500, 1_000];
/**
 * Council ladders. `undefined` is the "default" rung — `BrainCouncilPatch`
 * accepts `null` for these three, unlike the LLM/cache knobs.
 */
export const COUNCIL_FRACTION_PRESETS: readonly number[] = [0.25, 0.5, 0.6, 0.67, 0.75, 1];
export const COUNCIL_DISTINCTNESS_PRESETS: ReadonlyArray<'none' | 'model' | 'provider'> = [
  'none',
  'model',
  'provider',
];
export const COUNCIL_TIMEOUT_PRESETS: ReadonlyArray<number | undefined> = [
  undefined,
  10_000,
  15_000,
  30_000,
  60_000,
];
export const COUNCIL_CONCURRENCY_PRESETS: ReadonlyArray<number | undefined> = [
  undefined,
  1,
  2,
  3,
  4,
  6,
  8,
];
export const COUNCIL_JUDGE_MAX_TOKENS_PRESETS: ReadonlyArray<number | undefined> = [
  undefined,
  300,
  500,
  700,
  1_200,
];
/**
 * Per-seat output budget rungs. The default is 2000 (see
 * `BRAIN_COUNCIL_DEFAULT_VOTER_MAX_TOKENS` in core) — reasoning models spend
 * their thinking tokens from this budget, so the rungs skew higher than the
 * judge ladder.
 */
/**
 * Deliberation round presets. Deliberately short: every step is another
 * provider call PER SEAT on every council decision, so this is the panel's
 * steepest cost lever and the list should not invite exploration.
 */
export const COUNCIL_DELIBERATION_ROUNDS_PRESETS: ReadonlyArray<number | undefined> = [
  undefined,
  1,
  2,
  3,
];

export const COUNCIL_VOTER_MAX_TOKENS_PRESETS: ReadonlyArray<number | undefined> = [
  undefined,
  500,
  1_000,
  2_000,
  4_000,
  8_000,
];
/**
 * Fallback lens cycle for hosts that publish no `personaCatalog`. Prefer
 * {@link personaCycle}, which uses the host's catalog when it is available —
 * the registry ships six lenses, not these three.
 */
export const PERSONA_CYCLE = ['executor', 'skeptic', 'auditor'] as const;

/** Lens ids the panel may cycle through for the given settings snapshot. */
export function personaCycle(settings: BrainPanelSettings): readonly string[] {
  const catalog = settings.personaCatalog ?? [];
  return catalog.length > 0 ? catalog.map((persona) => persona.id) : PERSONA_CYCLE;
}

/** Human-readable lens name for a persona id, falling back to the id itself. */
export function personaLabel(settings: BrainPanelSettings, id: string | undefined): string {
  if (!id) return 'voter';
  return settings.personaCatalog?.find((persona) => persona.id === id)?.name ?? id;
}

/** Cycle helper: step through a preset ladder from the current value. */
export function cyclePreset<T>(presets: ReadonlyArray<T>, current: T, delta: number): T {
  const idx = presets.indexOf(current);
  const from = idx >= 0 ? idx : 0;
  const next = (from + delta + presets.length) % presets.length;
  return presets[next] as T;
}
