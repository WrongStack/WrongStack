/**
 * Brain panel data model — pure types + row derivation shared by the
 * reducer (cursor clamping), the key hook (action dispatch), and the
 * component (render). Mirrors the auth-panel pattern: the TUI never
 * touches config files — every mutation goes through the host bridge,
 * which the CLI implements on top of its BrainRuntime (live apply +
 * persist to the global config).
 */

import type { BrainRiskLevel } from './brain-contracts.js';

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
  /** Explicitly configured voters (empty = seats derive from the pool). */
  voters: BrainPanelVoter[];
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
export const BRAIN_HEURISTIC_KEYS: readonly BrainHeuristicKey[] = [
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
  60_000,
  300_000,
  900_000,
  1_800_000,
  3_600_000,
];
export const CACHE_MAX_ENTRIES_PRESETS: readonly number[] = [50, 100, 200, 500, 1_000];
export const PERSONA_CYCLE = ['executor', 'skeptic', 'auditor'] as const;

/** Cycle helper: step through a preset ladder from the current value. */
export function cyclePreset<T>(presets: ReadonlyArray<T>, current: T, delta: number): T {
  const idx = presets.indexOf(current);
  const from = idx >= 0 ? idx : 0;
  const next = (from + delta + presets.length) % presets.length;
  return presets[next] as T;
}

