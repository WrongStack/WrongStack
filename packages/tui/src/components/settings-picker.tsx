import { Box, Text, useStdout } from '../ink.js';
import type React from 'react';
import { MAX_TUI_THINKING_WORD_LENGTH } from '../thinking-word.js';
import {
  ANIMATION_STYLES,
  ANIMATION_STYLE_DESCS,
} from './animation-style.js';

/** Selectable presets for the auto-proceed delay, so the field is fully
 *  keyboard-cyclable (←/→) instead of needing typed numeric input. */
export const DELAY_PRESETS_MS = [0, 15_000, 30_000, 45_000, 60_000, 120_000];
export const SETTINGS_MODES = ['off', 'suggest', 'auto'] as const;
export type SettingsMode = (typeof SETTINGS_MODES)[number];

export const LOG_LEVELS = ['error', 'warn', 'info', 'debug', 'trace'] as const;
export type LogLevel = (typeof LOG_LEVELS)[number];

export const AUDIT_LEVELS = ['minimal', 'standard', 'full'] as const;
export type AuditLevel = (typeof AUDIT_LEVELS)[number];

export const COMPACTOR_STRATEGIES = ['hybrid', 'intelligent', 'selective'] as const;
export type CompactorStrategy = (typeof COMPACTOR_STRATEGIES)[number];

/** Context window mode options — cyclable via ←/→. */
export const CONTEXT_MODES = ['balanced', 'frugal', 'deep', 'archival'] as const;
export type ContextMode = (typeof CONTEXT_MODES)[number];

export const CONTEXT_MODE_DESCS: Record<ContextMode, string> = {
  balanced: 'Normal context usage (default)',
  frugal: 'Conservative token use',
  deep: 'Larger context for complex tasks',
  archival: 'Maximize context retention',
};

export const STATUSLINE_MODES = ['minimum', 'detailed', 'no-color'] as const;
export type StatuslineMode = (typeof STATUSLINE_MODES)[number];

export const REASONING_MODES = ['auto', 'on', 'off'] as const;
export type ReasoningMode = (typeof REASONING_MODES)[number];

export const REASONING_EFFORTS = ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'] as const;
export type ReasoningEffort = (typeof REASONING_EFFORTS)[number];

export const CACHE_TTLS = ['default', '5m', '1h'] as const;
export type CacheTtl = (typeof CACHE_TTLS)[number];

export const STATUSLINE_MODE_DESCS: Record<StatuslineMode, string> = {
  minimum: 'Single line with essential chips only',
  detailed: 'Full multi-line statusline (default)',
  'no-color': 'Multiline statusline without colors or icons',
};

/** Presets for max iterations — cyclable via ←/→. 0 = unlimited. */
export const MAX_ITERATIONS_PRESETS = [100, 200, 500, 1000, 0];

/** Presets for max concurrent subagents. 0 = runtime default. */
export const MAX_CONCURRENT_PRESETS = [1, 3, 4, 5, 10, 25, 50, 0];

/** Presets for auto-proceed max iterations. 0 = unlimited, 50 default. */
export const AUTO_PROCEED_MAX_PRESETS = [10, 25, 50, 100, 250, 0];

/** Presets for prompt refinement preview countdown. */
export const ENHANCE_DELAY_PRESETS = [15_000, 30_000, 45_000, 60_000, 90_000, 120_000];

/** Presets for the circuit-breaker auto kill/reset delay. 0 = manual recovery. */
export const BREAKER_TIMEOUT_PRESETS = [0, 30_000, 60_000, 120_000, 300_000];

export function formatBreakerTimeout(ms: number): string {
  if (ms === 0) return 'manual';
  return formatSettingsDelay(ms);
}

/**
 * Presets for the multi-file diff summary footer cutoff. Each value is the
 * minimum number of files before the aggregate `N files · +X -Y · …`
 * line is rendered above the per-file blocks. `0` suppresses the footer
 * entirely; `5` is the package default; values up to 15 are useful for
 * very wide terminals where per-file footers are cheap.
 */
export const MULTI_DIFF_SUMMARY_THRESHOLD_PRESETS = [3, 5, 8, 10, 15, 0];

/** Language options for prompt refinement. */
export const ENHANCE_LANGUAGES = ['original', 'english'] as const;
export type EnhanceLanguage = (typeof ENHANCE_LANGUAGES)[number];

/** Token-saving tier options — cyclable via ←/→ in the settings picker. */
export const TOKEN_SAVING_TIERS = ['off', 'minimal', 'light', 'medium', 'aggressive'] as const;
export type TokenSavingTierTui = (typeof TOKEN_SAVING_TIERS)[number];

export const TOKEN_SAVING_TIER_DESCS: Record<TokenSavingTierTui, string> = {
  off: 'All tools enabled (full prompt)',
  minimal: '~2.5–2.7k tokens — core tools only',
  light: '~2.3–2.4k tokens — core + patterns',
  medium: '~1.4–1.5k tokens — most tools enabled',
  aggressive: '~1k tokens — many tools, trimmed prompt',
};

/**
 * Fleet-chat verbosity options — cyclable via ←/→ in the settings picker.
 * Values MUST match core's `FleetChatVerbosity` union (config schema).
 */
export const FLEET_CHAT_MODES = ['off', 'compact', 'full'] as const;
export type FleetChatVerbosityTui = (typeof FLEET_CHAT_MODES)[number];

export const FLEET_CHAT_MODE_DESCS: Record<FleetChatVerbosityTui, string> = {
  off: 'No subagent lines in chat (F2/F3 monitors stay live)',
  compact: 'Spawn, one summary per agent turn, completion',
  full: 'Every subagent tool call and message',
};

export function formatSettingsDelay(ms: number): string {
  if (ms === 0) return 'disabled';
  if (ms >= 60_000) return `${Math.round(ms / 60_000)}m`;
  return `${Math.round(ms / 1000)}s`;
}

export function formatMaxIterations(n: number): string {
  if (n === 0) return 'unlimited';
  return String(n);
}

export function formatMultiDiffSummaryThreshold(n: number): string {
  if (n === 0) return 'off';
  return String(n);
}

export function formatEnhanceDelay(ms: number): string {
  return `${Math.round(ms / 1000)}s`;
}

/** Animation style choices for the settings picker — all AnimationStyles plus 'cycle'. */
export const ANIMATION_STYLE_CHOICES = [...ANIMATION_STYLES, 'cycle'] as const;
export type AnimationStyleChoice = (typeof ANIMATION_STYLE_CHOICES)[number];

/** Human-readable label for an animation style choice (including cycle). */
export function formatAnimationStyle(style: AnimationStyleChoice): string {
  if (style === 'cycle') return 'cycle (shuffle all)';
  return ANIMATION_STYLE_DESCS[style];
}

const MODE_DESC: Record<SettingsMode, string> = {
  off: 'Agent stops after each turn (normal)',
  suggest: 'Shows next-step suggestions after each turn',
  auto: 'Self-driving — agent continues automatically',
};

export interface SettingsPickerProps {
  /** Focused row index. */
  field: number;
  // ── Autonomy ──
  mode: SettingsMode;
  delayMs: number;
  // ── UX ──
  titleAnimation: boolean;
  yolo: boolean;
  fleetChat: FleetChatVerbosityTui;
  chime: boolean;
  confirmExit: boolean;
  nextPrediction: boolean;
  // ── Features ──
  featureMcp: boolean;
  featurePlugins: boolean;
  featureMemory: boolean;
  featureSkills: boolean;
  featureModelsRegistry: boolean;
  /** Token-saving tier: off | minimal | light | medium | aggressive. */
  tokenSavingTier: TokenSavingTierTui;
  /** Allow tools to read/write paths outside the project root directory. Default: true. */
  allowOutsideProjectRoot: boolean;
  // ── Tools ──
  maxIterations: number;
  /** Maximum auto-proceed iterations before stopping (0 = unlimited). */
  autoProceedMaxIterations: number;
  /** Prompt refinement preview countdown (ms). Cycled via ENHANCE_DELAY_PRESETS. */
  enhanceDelayMs: number;
  /** Enable/disable prompt refinement. */
  enhanceEnabled: boolean;
  /** Default language for refinement: original (keep user's language) or english. */
  enhanceLanguage: EnhanceLanguage;
  /** Run incremental index at session start. */
  indexOnStart: boolean;
  /** User-tunable cutoff for the multi-file diff summary footer. 0 = off. */
  multiDiffSummaryThreshold: number;
  // ── Reasoning ──
  /** Thinking word displayed in status bar while agent is working. */
  thinkingWord: string;
  /** True while the user is free-text editing the thinking word (Enter on the row). */
  thinkingWordEditing?: boolean | undefined;
  /** In-progress text buffer shown while `thinkingWordEditing`. */
  thinkingWordDraft?: string | undefined;
  /** Reasoning mode: auto (provider default) | on | off. */
  reasoningMode: ReasoningMode;
  /** Reasoning effort level. */
  reasoningEffort: ReasoningEffort;
  /** Preserve thinking across turns. */
  reasoningPreserve: boolean;
  /** Prompt cache TTL. */
  cacheTtl: CacheTtl;
  // ── Context ──
  contextAutoCompact: boolean;
  contextStrategy: CompactorStrategy;
  contextMode: ContextMode;
  // ── Fleet ──
  maxConcurrent: number;
  // ── Logging ──
  logLevel: LogLevel;
  auditLevel: AuditLevel;
  // ── Safety ──
  /** Whether the process circuit breaker gates bash/exec. */
  breakerEnabled: boolean;
  /** Auto kill/reset delay (ms) when the breaker trips. 0 = manual recovery. */
  breakerAutoKillResetMs: number;
  // ── Display ──
  /** Show the "Model Reasoning" blocks in chat history. Default: true. */
  showModelReasoning: boolean;
  // ── Debug ──
  /** Raw SSE stream debugging toggle — hex-dump every byte received from providers. */
  debugStream: boolean;
  /** Statusline density: minimum single-line or detailed multi-line. */
  statuslineMode: StatuslineMode;
  /** Where settings are persisted. */
  configScope: ConfigScope;
  /**
   * Animation style for the status bar's working/thinking chip.
   * One of the AnimationStyle values, or 'cycle' to rotate through variants.
   */
  animationStyle: AnimationStyleChoice;
  /**
   * Live filter for the row-search modal (entered via `/`). When non-empty,
   * the picker renders only matching rows. The leading `/` is part of the
   * value (matches fzf/vim convention) — the matcher strips it before
   * matching against row labels.
   */
  filter?: string | undefined;
  hint?: string | undefined;
}

/** Total number of settings rows (used for wrap-around navigation). */
export const SETTINGS_FIELD_COUNT = 40;

/**
 * Field index of the "Thinking word" row. The reducer's per-field switch and
 * the app.tsx key handler both branch on this, so it lives next to the row
 * definitions to keep the three in sync. If the row order changes, update this.
 */
export const THINKING_WORD_FIELD = 22;

/**
 * Field index of the "Multi-diff summary" row. Same rationale as
 * {@link THINKING_WORD_FIELD}: the keyboard handler in app.tsx dispatches
 * `settingsFieldSet` to this index when the user presses Ctrl+M inside the
 * picker, so any reorder of the Tools section must update this constant.
 */
export const MULTI_DIFF_SUMMARY_THRESHOLD_FIELD = 21;

/**
 * Map of modifier+<letter> chords to settings-picker rows. While the picker
 * is open, pressing a chord jumps the cursor straight to the target row so
 * the user can immediately cycle its value with ←/→ (or, for the thinking
 * word, Enter to open the free-text editor).
 *
 * Ctrl chords must NOT collide with global bindings:
 *   Ctrl+S = close picker · Ctrl+G = F3 agents monitor · Ctrl+F = F2 fleet
 *   monitor · Ctrl+P = PhaseMonitor · Ctrl+T = F4 worktree · Ctrl+A = F5 plan
 *   panel · Ctrl+K = F9 goal panel.
 *
 * Alt chords must NOT collide with:
 *   Alt+V = paste image from clipboard (chat input).
 *
 * Alt+Shift chords (mod+Alt in the user's framing) reuse the same letter as
 * plain Alt or Ctrl when the plain variants are already taken — the
 * composition distinguishes them at the keyboard level. For example, the
 * Ctrl and Alt+Shift sets both use 'L' for the Logging rows, but Alt+L and
 * Alt+Shift+L land on different fields.
 *
 * Each entry's `field` must match the actual row index at render time — the
 * `settingsFieldSet` action clamps out-of-range values to 0, so a drift
 * between this map and the picker row order would silently land the user on
 * row 0 instead of jumping them to the intended target.
 */
export type SettingsPickerJumpMod = 'ctrl' | 'alt' | 'alt-shift';

export interface SettingsPickerJumpChord {
  /** The modifier that, combined with the letter, triggers the jump. */
  mod: SettingsPickerJumpMod;
  /** The lowercase letter that triggers the jump. */
  letter: string;
  /** Target row index. Must match the picker's actual field order. */
  field: number;
  /** Short label for the help overlay and any debug surfaces. */
  label: string;
}

export const SETTINGS_PICKER_JUMP_CHORDS: ReadonlyArray<SettingsPickerJumpChord> = Object.freeze([
  // ── Ctrl chords (Tools / Reasoning / Fleet / Debug sections) ──
  // Most-tweaked rows first — these are the knobs users reach for daily.
  { mod: 'ctrl', letter: 'i', field: 20, label: 'Index on session start' },
  { mod: 'ctrl', letter: 'm', field: 21, label: 'Multi-diff summary' },
  { mod: 'ctrl', letter: 'w', field: 22, label: 'Thinking word' },
  { mod: 'ctrl', letter: 'r', field: 17, label: 'Refine preview countdown' },
  { mod: 'ctrl', letter: 'e', field: 18, label: 'Refine' },
  { mod: 'ctrl', letter: 'n', field: 23, label: 'Reasoning mode' },
  { mod: 'ctrl', letter: 'l', field: 30, label: 'Max concurrent' },
  { mod: 'ctrl', letter: 'd', field: 34, label: 'Statusline' },

  // ── Alt chords (Autonomy / UX / Features / Context sections) ──
  // The Ctrl set above is dominated by Tools + Reasoning rows; Alt picks up
  // the spread-out sections to give every region of the picker a fast path.
  { mod: 'alt', letter: 'a', field: 0, label: 'Default autonomy mode' },
  { mod: 'alt', letter: 'y', field: 3, label: 'YOLO mode' },
  { mod: 'alt', letter: 'c', field: 5, label: 'Completion chime' },
  { mod: 'alt', letter: 's', field: 6, label: 'Confirm before exit' },
  { mod: 'alt', letter: 't', field: 13, label: 'Token-saving mode' },
  { mod: 'alt', letter: 'x', field: 29, label: 'Context mode' },

  // ── Alt+Shift chords (Logging / Debug sections) ──
  // 'L' is taken by Ctrl+L (Max concurrent), so the Logging rows get the
  // composed Alt+Shift version. A standalone Alt+L would shadow the same
  // letter as Max concurrent's Ctrl chord, so the composition is the
  // disambiguator. 'A' and 'B' are both currently free as Alt+Shift
  // letters (B is unmapped at any mod), so the Debug row's "Stream debug
  // logging" takes B (de**B**ug, raw-**B**yte stream) rather than churn
  // the existing Ctrl+D → Statusline binding to make room. The Config
  // scope row uses G (**G**lobal / project) — G is free as Alt+Shift even
  // though Ctrl+G is the agents-monitor chord, because the mod+letter
  // composition makes them distinct at the keyboard-handler level.
  { mod: 'alt-shift', letter: 'l', field: 31, label: 'Log level' },
  { mod: 'alt-shift', letter: 'a', field: 32, label: 'Audit level' },
  { mod: 'alt-shift', letter: 'b', field: 33, label: 'Stream debug logging' },
  { mod: 'alt-shift', letter: 'g', field: 35, label: 'Config scope' },
  // ── Unmapped / Chord for Animation ──
  // 'N' for a**N**imation — Alt+N is unlisted (only Alt+B,C,D,E,F are taken).
  // Animation sits in the UX section alongside the rest of the visible-only
  // toggle rows and is newly added after the Debug section at field 36.
  { mod: 'alt', letter: 'n', field: 36, label: 'Animation' },
]);

/**
 * Lookup helper for the modifier+<letter> jump handler. Returns the
 * target field index for the given combination, or undefined if no chord
 * is bound. Centralised here so the help overlay and the keyboard
 * handler share a single source of truth — adding a new chord only
 * requires touching this array (and re-running the tests, which read it
 * back to verify the help overlay stays in sync).
 */
export function settingsPickerJumpField(
  mod: SettingsPickerJumpMod,
  letter: string,
): number | undefined {
  const lower = letter.toLowerCase();
  const chord = SETTINGS_PICKER_JUMP_CHORDS.find((c) => c.mod === mod && c.letter === lower);
  return chord?.field;
}

/**
 * Normalise a free-text query (from a slash command, search box, etc.)
 * into a "slug" suitable for matching against a settings row label.
 *
 *   "Multi-diff summary"   → "multi-diff-summary"
 *   "Context mode"         → "context-mode"
 *   "Refine preview countdown" → "refine-preview-countdown"
 *
 * We intentionally don't strip "mode" / "level" / "summary" suffixes —
 * the resolver tries multiple match strategies (exact, prefix, word-boundary)
 * to handle short queries like "context" or "audit" without making the
 * function itself responsible for fuzzy matching.
 */
function settingsPickerSlug(label: string): string {
  return label.toLowerCase().replace(/\s+/g, '-');
}

/**
 * Look up a settings-picker row by free-text name. Used by the
 * `/settings <chord>` slash command so users can jump by label
 * ("/settings multi-diff") in addition to the in-picker Ctrl+<letter>
 * chords.
 *
 * Match strategies, in priority order:
 *   1. Exact slug match — `/settings multi-diff-summary` → 21
 *   2. Token-prefix match — `/settings multi-diff` → 21 (matches the
 *      leading two tokens of "Multi-diff summary")
 *   3. Any-token match — `/settings chime` → 5 (matches the second
 *      token of "Completion chime"); `/settings context` → 29 (matches
 *      the first token of "Context mode")
 *
 * Ties (multiple rows match) resolve to the first chord in the array,
 * which is the most-tweaked-row-first ordering used throughout the
 * help overlay and the keyboard handler. Returns undefined if no row
 * matches. The caller is expected to surface a helpful error listing
 * the available names when this returns undefined.
 */
export function settingsPickerJumpByName(name: string): number | undefined {
  const query = settingsPickerSlug(name);
  if (!query) return undefined;

  // 1. Exact slug match.
  const exact = SETTINGS_PICKER_JUMP_CHORDS.find(
    (c) => settingsPickerSlug(c.label) === query,
  );
  if (exact) return exact.field;

  // 2. Token-prefix match: query tokens align with the leading tokens
  //    of the label slug. Allows `/settings multi-diff` to match
  //    "Multi-diff summary" (three tokens), or `/settings default-autonomy`
  //    to match "Default autonomy mode" (three tokens).
  const queryTokens = query.split('-');
  for (const c of SETTINGS_PICKER_JUMP_CHORDS) {
    const labelTokens = settingsPickerSlug(c.label).split('-');
    if (queryTokens.every((t, i) => labelTokens[i] === t)) {
      return c.field;
    }
  }

  // 3. Any-token match: the query is one of the label's tokens (or a
  //    prefix of one). Allows `/settings chime` → 5 ("Completion chime"),
  //    `/settings word` → 22 ("Thinking word"), `/settings scope` → 35
  //    ("Config scope"). Short queries like "log" or "audit" resolve
  //    unambiguously to a single row; longer queries that match
  //    multiple rows resolve to the first one in the array ordering.
  for (const c of SETTINGS_PICKER_JUMP_CHORDS) {
    const labelTokens = settingsPickerSlug(c.label).split('-');
    if (labelTokens.some((t) => t === query || t.startsWith(`${query}-`))) {
      return c.field;
    }
  }

  return undefined;
}

/**
 * All unique row names in the order they appear in the picker, formatted
 * as slash-separated slugs. Used by the help text of `/settings` so
 * the user can see the full vocabulary without leaving the prompt.
 */
export function settingsPickerJumpNames(): string[] {
  return SETTINGS_PICKER_JUMP_CHORDS.map((c) => settingsPickerSlug(c.label));
}

/**
 * Curated words the "Thinking word" field cycles through with ←/→. The user's
 * own custom word (set via Enter free-text edit or config) is folded into this
 * list at runtime so cycling never drops it. All entries must satisfy
 * `normalizeTuiThinkingWord` (single short word, ≤16 chars).
 *
 * `'thinking'` (the default) and `'random'` both surface a fresh fun word from
 * the pool on each working spell — see `isRandomTuiThinkingWord`.
 */
export const THINKING_WORD_PRESETS = [
  'thinking',
  'random',
  'working',
  'cooking',
  'vibing',
  'pondering',
  'brewing',
  'crunching',
  'computing',
  'grinding',
  'noodling',
  'churning',
  'hacking',
] as const;

export const CONFIG_SCOPES = ['global', 'project'] as const;
export type ConfigScope = (typeof CONFIG_SCOPES)[number];

// ─── Inline value-setting for `/settings <chord> <value>` ────────────
//
// These types and the resolver function allow the `/settings` slash
// command to set a value directly from the prompt without opening the
// picker overlay. The command handler calls `resolveSettingsFieldValue`
// to validate the user's input; on success it dispatches
// `settingsValueSet` with the returned patch and shows a confirmation.

/**
 * Partial patch for the configurable keys of the settings-picker state.
 * Excludes non-configurable keys (open, field, lastSettingsField, filter,
 * hint, thinkingWordEditing, thinkingWordDraft).
 */
export type SettingsPickerPatch = Partial<{
  mode: SettingsMode;
  delayMs: number;
  titleAnimation: boolean;
  yolo: boolean;
  fleetChat: FleetChatVerbosityTui;
  chime: boolean;
  confirmExit: boolean;
  nextPrediction: boolean;
  featureMcp: boolean;
  featurePlugins: boolean;
  featureMemory: boolean;
  featureSkills: boolean;
  featureModelsRegistry: boolean;
  tokenSavingTier: TokenSavingTierTui;
  allowOutsideProjectRoot: boolean;
  contextAutoCompact: boolean;
  contextStrategy: CompactorStrategy;
  contextMode: ContextMode;
  maxConcurrent: number;
  logLevel: LogLevel;
  auditLevel: AuditLevel;
  indexOnStart: boolean;
  multiDiffSummaryThreshold: number;
  maxIterations: number;
  autoProceedMaxIterations: number;
  enhanceDelayMs: number;
  enhanceEnabled: boolean;
  enhanceLanguage: EnhanceLanguage;
  debugStream: boolean;
  statuslineMode: StatuslineMode;
  reasoningMode: ReasoningMode;
  reasoningEffort: ReasoningEffort;
  reasoningPreserve: boolean;
  thinkingWord: string;
  cacheTtl: CacheTtl;
  configScope: ConfigScope;
  animationStyle: AnimationStyleChoice;
  breakerEnabled: boolean;
  breakerAutoKillResetMs: number;
  showModelReasoning: boolean;
}>;

/**
 * Human-readable labels for all settings fields (0–SETTINGS_FIELD_COUNT-1),
 * in picker row order. Used by `resolveSettingsFieldValue` for confirmation
 * and error messages, and by the `/settings` help text.
 */
export const SETTINGS_FIELD_LABELS: readonly string[] = [
  'Default autonomy mode', // 0
  'Auto-proceed delay', // 1
  'Terminal title animation', // 2
  'YOLO mode', // 3
  'Fleet chat', // 4
  'Completion chime', // 5
  'Confirm before exit', // 6
  'Next prediction', // 7
  'MCP features', // 8
  'Plugin features', // 9
  'Memory features', // 10
  'Skills features', // 11
  'Models registry', // 12
  'Token-saving mode', // 13
  'Allow outside project root', // 14
  'Max iterations', // 15
  'Auto-proceed max iterations', // 16
  'Refine preview countdown', // 17
  'Refine', // 18
  'Refine language', // 19
  'Index on session start', // 20
  'Multi-diff summary', // 21
  'Thinking word', // 22
  'Reasoning mode', // 23
  'Reasoning effort', // 24
  'Reasoning preserve', // 25
  'Cache TTL', // 26
  'Context auto-compact', // 27
  'Compactor strategy', // 28
  'Context mode', // 29
  'Max concurrent', // 30
  'Log level', // 31
  'Audit level', // 32
  'Stream debug logging', // 33
  'Statusline', // 34
  'Config scope', // 35
  'Animation', // 36
  'Circuit breaker', // 37
  'Breaker timeout', // 38
  'Show model reasoning', // 39
];

/**
 * Resolve a free-text value for a given settings field into a typed
 * state patch. Used by the `/settings <chord> <value>` slash command.
 *
 * Value parsing rules:
 *  - **Boolean fields**: "on"/"off", "true"/"false", "yes"/"no",
 *    "1"/"0" (case-insensitive).
 *  - **Enum fields**: case-insensitive match against the allowed values.
 *  - **Preset fields**: either the raw number (e.g. "500") or the
 *    display name (e.g. "unlimited" for 0, "off" for 0, "1m" for 60000).
 *  - **Text fields** (thinking word): accepted as-is, validated by
 *    `normalizeTuiThinkingWord`.
 *
 * Returns `{ ok: true, patch, label, displayValue }` on success, or
 * `{ ok: false, error }` with a helpful message listing valid options.
 */
export function resolveSettingsFieldValue(
  field: number,
  input: string,
): { ok: true; patch: SettingsPickerPatch; label: string; displayValue: string } | { ok: false; error: string } {
  const raw = input.trim().toLowerCase();
  const label = SETTINGS_FIELD_LABELS[field] ?? `Field ${field}`;

  // ── Boolean fields ──
  const BOOL_FIELDS = new Map<number, keyof SettingsPickerPatch>([
    [2, 'titleAnimation'], [3, 'yolo'], [5, 'chime'],
    [6, 'confirmExit'], [7, 'nextPrediction'], [8, 'featureMcp'],
    [9, 'featurePlugins'], [10, 'featureMemory'], [11, 'featureSkills'],
    [12, 'featureModelsRegistry'], [14, 'allowOutsideProjectRoot'],
    [18, 'enhanceEnabled'], [20, 'indexOnStart'], [25, 'reasoningPreserve'],
    [27, 'contextAutoCompact'], [33, 'debugStream'], [37, 'breakerEnabled'],
    [39, 'showModelReasoning'],
  ]);
  const boolKey = BOOL_FIELDS.get(field);
  if (boolKey) {
    if (['on', 'true', 'yes', '1'].includes(raw)) {
      return { ok: true, patch: { [boolKey]: true } as SettingsPickerPatch, label, displayValue: 'on' };
    }
    if (['off', 'false', 'no', '0'].includes(raw)) {
      return { ok: true, patch: { [boolKey]: false } as SettingsPickerPatch, label, displayValue: 'off' };
    }
    return { ok: false, error: `Invalid value "${input}" for ${label}. Use on or off.` };
  }

  // ── Enum fields ──
  // Each entry: [field, stateKey, allowedValues]
  // Field 4 (fleet chat) accepts the legacy boolean tokens too:
  // "on"/"true" → 'full', "false"/"no" → 'off' — so old `/settings
  // stream-fleet on|off` muscle memory keeps working.
  if (field === 4) {
    const legacy =
      ['on', 'true', 'yes', '1'].includes(raw) ? 'full'
      : ['false', 'no', '0'].includes(raw) ? 'off'
      : undefined;
    const match = (FLEET_CHAT_MODES as readonly string[]).includes(raw)
      ? (raw as FleetChatVerbosityTui)
      : legacy;
    if (match) {
      return { ok: true, patch: { fleetChat: match as FleetChatVerbosityTui }, label, displayValue: match };
    }
    return {
      ok: false,
      error: `Invalid value "${input}" for ${label}. Valid: ${FLEET_CHAT_MODES.join(', ')}.`,
    };
  }

  const ENUM_FIELDS: ReadonlyArray<readonly [number, keyof SettingsPickerPatch, readonly string[]]> = [
    [0, 'mode', SETTINGS_MODES],
    [13, 'tokenSavingTier', TOKEN_SAVING_TIERS],
    [19, 'enhanceLanguage', ENHANCE_LANGUAGES],
    [23, 'reasoningMode', REASONING_MODES],
    [24, 'reasoningEffort', REASONING_EFFORTS],
    [26, 'cacheTtl', CACHE_TTLS],
    [28, 'contextStrategy', COMPACTOR_STRATEGIES],
    [29, 'contextMode', CONTEXT_MODES],
    [31, 'logLevel', LOG_LEVELS],
    [32, 'auditLevel', AUDIT_LEVELS],
    [34, 'statuslineMode', STATUSLINE_MODES],
    [35, 'configScope', CONFIG_SCOPES],
    [36, 'animationStyle', ANIMATION_STYLE_CHOICES],
  ];
  for (const [f, key, values] of ENUM_FIELDS) {
    if (field !== f) continue;
    const match = values.find((v) => v.toLowerCase() === raw);
    if (match) {
      return { ok: true, patch: { [key]: match } as SettingsPickerPatch, label, displayValue: match };
    }
    return {
      ok: false,
      error: `Invalid value "${input}" for ${label}. Valid: ${values.join(', ')}.`,
    };
  }

  // ── Preset (numeric) fields ──
  // Each entry: [field, stateKey, presets, formatFn]
  // formatFn maps a preset number → its display name (for "unlimited", "off", etc.)
  const presetLabel = (n: number, zeroLabel: string): string => (n === 0 ? zeroLabel : String(n));
  const PRESET_FIELDS: ReadonlyArray<readonly [number, keyof SettingsPickerPatch, readonly number[], (n: number) => string]> = [
    [1, 'delayMs', DELAY_PRESETS_MS, (n) => formatSettingsDelay(n)],
    [15, 'maxIterations', MAX_ITERATIONS_PRESETS, (n) => formatMaxIterations(n)],
    [16, 'autoProceedMaxIterations', AUTO_PROCEED_MAX_PRESETS, (n) => formatMaxIterations(n)],
    [17, 'enhanceDelayMs', ENHANCE_DELAY_PRESETS, (n) => formatEnhanceDelay(n)],
    [21, 'multiDiffSummaryThreshold', MULTI_DIFF_SUMMARY_THRESHOLD_PRESETS, (n) => formatMultiDiffSummaryThreshold(n)],
    [30, 'maxConcurrent', MAX_CONCURRENT_PRESETS, (n) => presetLabel(n, 'runtime default')],
    [38, 'breakerAutoKillResetMs', BREAKER_TIMEOUT_PRESETS, (n) => formatBreakerTimeout(n)],
  ];
  for (const [f, key, presets, fmt] of PRESET_FIELDS) {
    if (field !== f) continue;
    // Try matching as a number first.
    const asNum = Number.parseInt(raw, 10);
    if (!Number.isNaN(asNum) && presets.includes(asNum)) {
      return { ok: true, patch: { [key]: asNum } as SettingsPickerPatch, label, displayValue: fmt(asNum) };
    }
    // Try matching against display names (e.g. "unlimited" → 0, "30s" → 30000).
    const byName = presets.find((p) => fmt(p).toLowerCase() === raw);
    if (byName !== undefined) {
      return { ok: true, patch: { [key]: byName } as SettingsPickerPatch, label, displayValue: fmt(byName) };
    }
    const options = presets.map((p) => fmt(p)).join(', ');
    return {
      ok: false,
      error: `Invalid value "${input}" for ${label}. Available: ${options}.`,
    };
  }

  // ── Text field (thinking word) ──
  if (field === 22) {
    const word = input.trim();
    if (word.length === 0 || word.length > MAX_TUI_THINKING_WORD_LENGTH) {
      return {
        ok: false,
        error: `"${input}" is not a valid thinking word. Use a single short word (1–${MAX_TUI_THINKING_WORD_LENGTH} chars, letters/numbers only).`,
      };
    }
    if (!/^[\p{L}\p{N}_-]+$/u.test(word)) {
      return {
        ok: false,
        error: `"${input}" is not a valid thinking word. Use a single short word (1–${MAX_TUI_THINKING_WORD_LENGTH} chars, letters/numbers only).`,
      };
    }
    return { ok: true, patch: { thinkingWord: word }, label, displayValue: word };
  }

  return { ok: false, error: `Unknown settings field ${field}.` };
}

/**
 * Read-only counterpart to {@link resolveSettingsFieldValue}. Given the
 * current settings-picker values and a field index, returns the value
 * formatted for display (e.g. `30s`, `unlimited`, `off`, `high`).
 *
 * Used by the `/settings-get <chord>` slash command so the user can
 * query a setting without opening the picker.
 *
 * The input type is `SettingsPickerValues` — all keys of
 * {@link SettingsPickerPatch} made required — which matches the
 * settingsPicker state slice from app-state.ts (minus non-configurable
 * keys like `open`, `field`, `filter`).
 */
export type SettingsPickerValues = {
  [K in keyof SettingsPickerPatch]-?: SettingsPickerPatch[K];
};

export function getSettingsFieldValue(
  values: SettingsPickerValues,
  field: number,
): { ok: true; label: string; displayValue: string } | { ok: false; error: string } {
  const label = SETTINGS_FIELD_LABELS[field] ?? `Field ${field}`;

  // Boolean fields — display as "on"/"off".
  const BOOL_KEYS: ReadonlyArray<readonly [number, keyof SettingsPickerPatch]> = [
    [2, 'titleAnimation'], [3, 'yolo'], [5, 'chime'],
    [6, 'confirmExit'], [7, 'nextPrediction'], [8, 'featureMcp'],
    [9, 'featurePlugins'], [10, 'featureMemory'], [11, 'featureSkills'],
    [12, 'featureModelsRegistry'], [14, 'allowOutsideProjectRoot'],
    [18, 'enhanceEnabled'], [20, 'indexOnStart'], [25, 'reasoningPreserve'],
    [27, 'contextAutoCompact'], [33, 'debugStream'], [37, 'breakerEnabled'],
    [39, 'showModelReasoning'],
  ];
  for (const [f, key] of BOOL_KEYS) {
    if (field !== f) continue;
    return { ok: true, label, displayValue: values[key] ? 'on' : 'off' };
  }

  // Enum fields — display the raw value.
  const ENUM_KEYS: ReadonlyArray<readonly [number, keyof SettingsPickerPatch]> = [
    [0, 'mode'], [4, 'fleetChat'], [13, 'tokenSavingTier'], [19, 'enhanceLanguage'],
    [23, 'reasoningMode'], [24, 'reasoningEffort'], [26, 'cacheTtl'],
    [28, 'contextStrategy'], [29, 'contextMode'], [31, 'logLevel'],
    [32, 'auditLevel'], [34, 'statuslineMode'], [35, 'configScope'],
    [36, 'animationStyle'],
  ];
  for (const [f, key] of ENUM_KEYS) {
    if (field !== f) continue;
    return { ok: true, label, displayValue: String(values[key]) };
  }

  // Preset fields — display via the format function.
  const presetLabel = (n: number, zeroLabel: string): string => (n === 0 ? zeroLabel : String(n));
  const PRESET_KEYS: ReadonlyArray<readonly [number, keyof SettingsPickerPatch, (n: number) => string]> = [
    [1, 'delayMs', formatSettingsDelay],
    [15, 'maxIterations', formatMaxIterations],
    [16, 'autoProceedMaxIterations', formatMaxIterations],
    [17, 'enhanceDelayMs', formatEnhanceDelay],
    [21, 'multiDiffSummaryThreshold', formatMultiDiffSummaryThreshold],
    [30, 'maxConcurrent', (n) => presetLabel(n, 'runtime default')],
    [38, 'breakerAutoKillResetMs', formatBreakerTimeout],
  ];
  for (const [f, key, fmt] of PRESET_KEYS) {
    if (field !== f) continue;
    return { ok: true, label, displayValue: fmt(values[key] as number) };
  }

  // Text field (thinking word).
  if (field === 22) {
    return { ok: true, label, displayValue: values.thinkingWord };
  }

  return { ok: false, error: `Unknown settings field ${field}.` };
}

/**
 * Section headings and their field ranges, matching the picker's visual
 * grouping. Used by {@link formatAllSettingsSummary} to produce a compact
 * grouped overview.
 */
const SETTINGS_SECTIONS: ReadonlyArray<{ name: string; fields: readonly number[] }> = [
  {
    name: 'Autonomy',
    fields: [0, 1],
  },
  {
    name: 'UX',
    fields: [2, 3, 4, 5, 6, 7],
  },
  {
    name: 'Features',
    fields: [8, 9, 10, 11, 12, 13, 14],
  },
  {
    name: 'Tools',
    fields: [15, 16, 17, 18, 19, 20, 21, 22],
  },
  {
    name: 'Reasoning',
    fields: [23, 24, 25, 26],
  },
  {
    name: 'Context',
    fields: [27, 28, 29],
  },
  {
    name: 'Fleet',
    fields: [30],
  },
  {
    name: 'Logging',
    fields: [31, 32],
  },
  {
    name: 'Debug',
    fields: [33, 34, 35, 36],
  },
  {
    name: 'Safety',
    fields: [37, 38],
  },
  {
    name: 'Display',
    fields: [39],
  },
];

/**
 * Produce a compact, section-grouped text summary of ALL settings values.
 * Used by the `/settings-get` command when called with no arguments, so
 * the user can see their full configuration at a glance without opening
 * the picker overlay.
 *
 * Format (one line per field):
 * ```
 * ── Autonomy ──
 *   Default autonomy mode     auto
 *   Auto-proceed delay        30s
 * ── UX ──
 *   YOLO mode                 off
 *   ...
 * ```
 */
export function formatAllSettingsSummary(values: SettingsPickerValues): string {
  const lines: string[] = [];
  for (const section of SETTINGS_SECTIONS) {
    lines.push(`── ${section.name} ──`);
    for (const field of section.fields) {
      const result = getSettingsFieldValue(values, field);
      if (result.ok) {
        lines.push(`  ${result.label.padEnd(28)} ${result.displayValue}`);
      }
    }
  }
  return lines.join('\n');
}

/**
 * Default values for all configurable settings fields, in the same
 * shape as {@link SettingsPickerValues}. Extracted from the reducer's
 * initial state so there is a single source of truth for "factory
 * defaults". Used by {@link resetSettingsFieldValue}.
 */
export const SETTINGS_DEFAULTS: Readonly<SettingsPickerValues> = Object.freeze({
  // Factory defaults mirror the core config defaults: autonomy 'auto'
  // (self-driving) and yolo on (auto-approve). Live values still come from
  // config via getSettings(); these are the "reset to default" targets.
  mode: 'auto',
  delayMs: 0,
  titleAnimation: true,
  yolo: true,
  fleetChat: 'compact',
  chime: false,
  confirmExit: true,
  nextPrediction: false,
  featureMcp: true,
  featurePlugins: true,
  featureMemory: true,
  featureSkills: true,
  featureModelsRegistry: true,
  tokenSavingTier: 'off',
  allowOutsideProjectRoot: true,
  contextAutoCompact: true,
  contextStrategy: 'hybrid',
  contextMode: 'balanced',
  maxConcurrent: 10,
  logLevel: 'info',
  auditLevel: 'standard',
  indexOnStart: true,
  multiDiffSummaryThreshold: 5,
  maxIterations: 500,
  autoProceedMaxIterations: 50,
  enhanceDelayMs: 60_000,
  enhanceEnabled: true,
  enhanceLanguage: 'original',
  debugStream: false,
  statuslineMode: 'detailed',
  reasoningMode: 'auto',
  reasoningEffort: 'high',
  reasoningPreserve: false,
  thinkingWord: 'thinking',
  cacheTtl: 'default',
  configScope: 'global',
  animationStyle: 'rainbow',
  breakerEnabled: false,
  breakerAutoKillResetMs: 60_000,
  showModelReasoning: true,
} as const);

/**
 * Reset a single settings field to its factory default. Returns the
 * same shape as {@link resolveSettingsFieldValue} so the command
 * handler can use the same dispatch + persist logic.
 *
 * Used by the `/settings reset <chord>` slash command.
 */
export function resetSettingsFieldValue(
  field: number,
): { ok: true; patch: SettingsPickerPatch; label: string; displayValue: string } | { ok: false; error: string } {
  const result = getSettingsFieldValue(SETTINGS_DEFAULTS, field);
  if (!result.ok) return result;

  const patch = buildResetPatch(field);
  if (!patch) return { ok: false, error: `Unknown settings field ${field}.` };
  return { ok: true, patch, label: result.label, displayValue: result.displayValue };
}

/**
 * Map a field index to its state key and extract the default value.
 * This is the inverse of the field→key tables in resolveSettingsFieldValue.
 */
function buildResetPatch(field: number): SettingsPickerPatch | null {
  const KEY_MAP: ReadonlyArray<readonly [number, keyof SettingsPickerValues]> = [
    [0, 'mode'], [1, 'delayMs'], [2, 'titleAnimation'], [3, 'yolo'],
    [4, 'fleetChat'], [5, 'chime'], [6, 'confirmExit'], [7, 'nextPrediction'],
    [8, 'featureMcp'], [9, 'featurePlugins'], [10, 'featureMemory'], [11, 'featureSkills'],
    [12, 'featureModelsRegistry'], [13, 'tokenSavingTier'], [14, 'allowOutsideProjectRoot'],
    [15, 'maxIterations'], [16, 'autoProceedMaxIterations'], [17, 'enhanceDelayMs'],
    [18, 'enhanceEnabled'], [19, 'enhanceLanguage'], [20, 'indexOnStart'],
    [21, 'multiDiffSummaryThreshold'], [22, 'thinkingWord'], [23, 'reasoningMode'],
    [24, 'reasoningEffort'], [25, 'reasoningPreserve'], [26, 'cacheTtl'],
    [27, 'contextAutoCompact'], [28, 'contextStrategy'], [29, 'contextMode'],
    [30, 'maxConcurrent'], [31, 'logLevel'], [32, 'auditLevel'], [33, 'debugStream'],
    [34, 'statuslineMode'], [35, 'configScope'], [36, 'animationStyle'],
    [37, 'breakerEnabled'], [38, 'breakerAutoKillResetMs'], [39, 'showModelReasoning'],
  ];
  for (const [f, key] of KEY_MAP) {
    if (f === field) {
      return { [key]: SETTINGS_DEFAULTS[key] } as SettingsPickerPatch;
    }
  }
  return null;
}

export function SettingsPicker({
  field,
  filter,
  mode,
  delayMs,
  titleAnimation,
  yolo,
  fleetChat,
  chime,
  confirmExit,
  nextPrediction,
  featureMcp,
  featurePlugins,
  featureMemory,
  featureSkills,
  featureModelsRegistry,
  tokenSavingTier,
  allowOutsideProjectRoot,
  maxIterations,
  autoProceedMaxIterations,
  enhanceDelayMs,
  enhanceEnabled,
  enhanceLanguage,
  indexOnStart,
  multiDiffSummaryThreshold,
  thinkingWord,
  thinkingWordEditing,
  thinkingWordDraft,
  reasoningMode,
  reasoningEffort,
  reasoningPreserve,
  cacheTtl,
  contextAutoCompact,
  contextStrategy,
  contextMode,
  maxConcurrent,
  logLevel,
  auditLevel,
  debugStream,
  statuslineMode,
  configScope,
  animationStyle,
  breakerEnabled,
  breakerAutoKillResetMs,
  showModelReasoning,
  hint,
}: SettingsPickerProps): React.ReactElement {
  const boolVal = (v: boolean) => (v ? 'on' : 'off');

  interface Row {
    section?: string | undefined;
    label?: string | undefined;
    value?: string | undefined;
    detail?: string | undefined;
  }

  const rows: Row[] = [
    // ── Autonomy ──
    { section: 'Autonomy' },
    { label: 'Default autonomy mode', value: mode, detail: MODE_DESC[mode] },
    {
      label: 'Auto-proceed delay',
      value: formatSettingsDelay(delayMs),
      detail: 'Wait before auto-continuing in auto mode',
    },
    // ── UX ──
    { section: 'UX' },
    {
      label: 'Terminal title animation',
      value: boolVal(titleAnimation),
      detail: 'Animated window/tab title with status',
    },
    {
      label: 'YOLO mode',
      value: boolVal(yolo),
      detail: 'Skip all confirmation prompts',
    },
    {
      label: 'Fleet chat',
      value: fleetChat,
      detail: FLEET_CHAT_MODE_DESCS[fleetChat],
    },
    {
      label: 'Completion chime',
      value: boolVal(chime),
      detail: 'Play a sound when agent finishes',
    },
    {
      label: 'Confirm before exit',
      value: boolVal(confirmExit),
      detail: 'Confirmation on Esc interrupt & Ctrl+C exit',
    },
    {
      label: 'Next-step prediction',
      value: boolVal(nextPrediction),
      detail: 'Show LLM-predicted next steps (/next)',
    },
    // ── Features ──
    { section: 'Features' },
    {
      label: 'MCP servers',
      value: boolVal(featureMcp),
      detail: 'Load MCP servers from config',
    },
    {
      label: 'Plugins',
      value: boolVal(featurePlugins),
      detail: 'Load npm plugins from config',
    },
    {
      label: 'Memory',
      value: boolVal(featureMemory),
      detail: 'Enable remember/forget tools',
    },
    {
      label: 'Skills',
      value: boolVal(featureSkills),
      detail: 'Discover and load skills from disk',
    },
    {
      label: 'Models registry',
      value: boolVal(featureModelsRegistry),
      detail: 'Fetch models.dev catalog at startup',
    },
    {
      label: 'Token-saving mode',
      value: tokenSavingTier,
      detail: TOKEN_SAVING_TIER_DESCS[tokenSavingTier],
    },
    {
      label: 'Allow outside project',
      value: boolVal(allowOutsideProjectRoot),
      detail: 'Allow tools to access paths outside project root',
    },
    // ── Tools ──
    { section: 'Tools' },
    {
      label: 'Max iterations',
      value: formatMaxIterations(maxIterations),
      detail: '100–1000 or unlimited (0)',
    },
    {
      label: 'Auto-proceed max iterations',
      value: formatMaxIterations(autoProceedMaxIterations),
      detail: 'Stop auto-proceed after N iterations (0 = unlimited, default 50)',
    },
    {
      label: 'Refine preview countdown',
      value: formatEnhanceDelay(enhanceDelayMs),
      detail: 'Timeout for prompt refinement preview (15s–120s)',
    },
    {
      label: 'Refine',
      value: boolVal(enhanceEnabled),
      detail: 'Enable prompt refinement before sending',
    },
    {
      label: 'Refine language',
      value: enhanceLanguage,
      detail: 'original (keep language) | english (translate)',
    },
    {
      label: 'Index on session start',
      value: boolVal(indexOnStart),
      detail: 'Run incremental index at session start',
    },
    {
      label: 'Multi-diff summary',
      value: formatMultiDiffSummaryThreshold(multiDiffSummaryThreshold),
      detail:
        'Min files before aggregate header (0 = off, default 5, 10 for big diffs)',
    },
    // ── Reasoning ──
    { section: 'Reasoning' },
    {
      label: 'Thinking word',
      value: thinkingWordEditing ? `${thinkingWordDraft ?? ''}▏` : thinkingWord,
      detail: thinkingWordEditing
        ? 'type a word · Enter ✓ · Esc ✗ (≤16, letters/digits/_/-)'
        : 'Status-bar working word · thinking/random = surprise me · ←/→ presets · Enter to type',
    },
    {
      label: 'Reasoning mode',
      value: reasoningMode,
      detail: 'auto (provider default) | on | off',
    },
    {
      label: 'Reasoning effort',
      value: reasoningEffort,
      detail: 'none–max (model-dependent)',
    },
    {
      label: 'Preserve thinking',
      value: boolVal(reasoningPreserve),
      detail: 'Keep reasoning across turns',
    },
    {
      label: 'Cache TTL',
      value: cacheTtl,
      detail: 'Prompt cache TTL (5m | 1h)',
    },
    // ── Context ──
    { section: 'Context' },
    {
      label: 'Auto-compact',
      value: boolVal(contextAutoCompact),
      detail: 'Auto-compact context when thresholds crossed',
    },
    {
      label: 'Compactor strategy',
      value: contextStrategy,
      detail: 'hybrid (fast) | intelligent (LLM) | selective',
    },
    {
      label: 'Context mode',
      value: contextMode,
      detail: CONTEXT_MODE_DESCS[contextMode],
    },
    // ── Fleet ──
    { section: 'Fleet' },
    {
      label: 'Max concurrent',
      value: maxConcurrent === 0 ? 'default' : String(maxConcurrent),
      detail: 'Max subagents (0 = default)',
    },
    // ── Logging ──
    { section: 'Logging' },
    {
      label: 'Log level',
      value: logLevel,
      detail: 'Console log verbosity',
    },
    {
      label: 'Audit level',
      value: auditLevel,
      detail: 'minimal | standard | full (large)',
    },
    // ── Debug ──
    { section: 'Debug' },
    {
      label: 'Stream debug logging',
      value: boolVal(debugStream),
      detail: 'Hex-dump raw SSE bytes to stderr',
    },
    {
      label: 'Statusline',
      value: statuslineMode,
      detail: STATUSLINE_MODE_DESCS[statuslineMode],
    },
    {
      label: 'Config scope',
      value: configScope,
      detail: 'global (~/.wrongstack/) or project (.wrongstack/)',
    },
    {
      label: 'Animation',
      value: animationStyle,
      detail: formatAnimationStyle(animationStyle),
    },
    // ── Safety ──
    { section: 'Safety' },
    {
      label: 'Circuit breaker',
      value: boolVal(breakerEnabled),
      detail: 'Gate bash/exec after repeated failures',
    },
    {
      label: 'Breaker timeout',
      value: formatBreakerTimeout(breakerAutoKillResetMs),
      detail: 'Auto kill/reset delay when tripped (manual = /kill reset)',
    },
    // ── Display ──
    { section: 'Display' },
    {
      label: 'Show model reasoning',
      value: boolVal(showModelReasoning),
      detail: 'Show LLM reasoning blocks in chat history',
    },
  ];

  // Build field → row index mapping. `rows` includes section headers
  // that are NOT counted by `field`; without this mapping the highlight
  // lands on the wrong row (or never shows on the first field).
  const fieldRowIndex: number[] = [];
  for (let i = 0; i < rows.length; i++) {
    if (!rows[i]?.section) fieldRowIndex.push(i);
  }

  // ── Filter mode ──
  // When the user presses `/` and types a query, the picker renders only
  // rows whose label matches the query. Matching uses two strategies:
  //   1. Contiguous substring (case-insensitive) — "diff" matches "Multi-diff"
  //   2. Fuzzy scattered-character (each char appears in order) — "mds"
  //      matches "Multi-diff Summary"
  // Strategy 1 is tried first (higher relevance). The leading `/` from the
  // filter value is stripped before matching.
  const filterActive = Boolean(filter && filter.length > 1);
  const filterQuery = filter && filter.length > 1 ? filter.slice(1).toLowerCase() : '';

  /**
   * Fuzzy-scattered match: every character of `needle` must appear in
   * `haystack` in the same order, but not necessarily contiguously.
   * Returns the array of matched character indices (for highlighting),
   * or undefined when no subsequence match exists.
   *
   *   fuzzyMatch("multi-diff summary", "mds")
   *     → [0, 6, 11]  (m-u-l-t-i-[-]-d-i-f-f-[ ]-s-u-m-m-a-r-y → m@0, d@6, s@11)
   *
   * This is the classic "command-T / fzf" subsequence filter — cheap
   * to compute (one pass) and handles abbreviations like "mds" →
   * "Multi-diff summary" without requiring the user to type the full
   * word.
   */
  const fuzzyMatch = (haystack: string, needle: string): number[] | undefined => {
    const lower = haystack.toLowerCase();
    const indices: number[] = [];
    let ni = 0;
    for (let hi = 0; hi < lower.length && ni < needle.length; hi++) {
      if (lower[hi] === needle[ni]) {
        indices.push(hi);
        ni++;
      }
    }
    return ni === needle.length ? indices : undefined;
  };

  // Pre-compute fuzzy match results for every chord — used by both the
  // filter (does it match?) and the highlighter (which characters?).
  // Each result also carries a numeric `score` (lower = better match)
  // so the filtered list can be ranked by relevance.
  type FuzzyResult = {
    chord: SettingsPickerJumpChord;
    contiguous: boolean;
    fuzzyIdx: number[] | undefined;
    /** Lower = better. Contiguous always beats fuzzy. */
    score: number;
  };

  /**
   * Score a match for ranking. Lower is better.
   *
   *   - Contiguous matches always score below fuzzy matches (prefix 0
   *     vs prefix 1000).
   *   - Within each tier, the score combines:
   *       - Match position (earlier = better: position 0 adds 0, position 20 adds 20)
   *       - Label length (shorter = better: length 9 adds 0, length 30 adds 21)
   *       - Total gap between matched chars (tighter = better: 0 gaps adds 0)
   *
   * This mirrors fzf/command-T scoring heuristics without the complexity
   * of a full dynamic-programming alignment. The goal is "the row the
   * user obviously meant" appearing at the top.
   */
  const scoreMatch = (
    contiguous: boolean,
    matchIndices: number[] | undefined,
    labelLength: number,
  ): number => {
    const tier = contiguous ? 0 : 1000;
    if (!matchIndices || matchIndices.length === 0) {
      // Contiguous with no indices means the query is a substring but we
      // didn't compute individual indices — estimate the first occurrence.
      return tier;
    }
    const firstPos = matchIndices[0] ?? 0;
    // Total gap = distance between first and last matched char minus the
    // number of matched chars (a measure of how "spread out" the match is).
    const span = (matchIndices.at(-1) ?? 0) - firstPos;
    const gap = span - (matchIndices.length - 1);
    // Label length penalty: longer labels are slightly worse.
    const lengthPenalty = Math.max(0, labelLength - 8);
    return tier + firstPos + gap * 2 + lengthPenalty;
  };

  const fuzzyResults: FuzzyResult[] = filterActive
    ? SETTINGS_PICKER_JUMP_CHORDS.map((c) => {
        const label = c.label;
        const contiguous = label.toLowerCase().includes(filterQuery);
        if (contiguous) {
          // For contiguous matches, compute the first occurrence index
          // for scoring (highlighting uses the full highlightSegments path).
          const firstIdx = label.toLowerCase().indexOf(filterQuery);
          const indices = Array.from({ length: filterQuery.length }, (_, i) => firstIdx + i);
          return { chord: c, contiguous, fuzzyIdx: undefined, score: scoreMatch(true, indices, label.length) };
        }
        const fuzzyIdx = fuzzyMatch(label, filterQuery);
        return {
          chord: c,
          contiguous: false,
          fuzzyIdx,
          score: fuzzyIdx !== undefined ? scoreMatch(false, fuzzyIdx, label.length) : Infinity,
        };
      })
    : [];

  // Sort matched results by score (ascending). Unmatched results have
  // Infinity and sink to the bottom; they're filtered out below.
  const rankedResults = fuzzyResults
    .filter((r) => r.contiguous || r.fuzzyIdx !== undefined)
    .sort((a, b) => a.score - b.score);

  const filteredFieldIndices = rankedResults.map((r) => r.chord.field);

  /**
   * Split a label into match/non-match segments for incremental-search
   * highlighting.
   *
   * **Contiguous match** (query appears as a substring): splits into
   *   non-match / match / non-match blocks.
   *
   * **Fuzzy scattered match** (query chars appear in order but scattered):
   *   marks each matched character individually, so the user sees which
   *   individual characters contributed to the match:
   *     "mds" → `M`·u·l·t·i·-·`d`·i·f·f· ·`s`·u·m·m·a·r·y
   *
   * When the filter is inactive or the query is empty, returns the whole
   * label as a single non-match segment.
   */
  const highlightSegments = (label: string): Array<{ text: string; match: boolean }> => {
    if (!filterActive || !filterQuery) return [{ text: label, match: false }];

    // Find this label's match result from the pre-computed set.
    const result = fuzzyResults.find((r) => r.chord.label === label);
    if (!result) return [{ text: label, match: false }];

    if (result.contiguous) {
      // Contiguous substring: find all occurrences and split into blocks.
      const lower = label.toLowerCase();
      const segments: Array<{ text: string; match: boolean }> = [];
      let cursor = 0;
      while (cursor < label.length) {
        const idx = lower.indexOf(filterQuery, cursor);
        if (idx === -1) {
          segments.push({ text: label.slice(cursor), match: false });
          break;
        }
        if (idx > cursor) {
          segments.push({ text: label.slice(cursor, idx), match: false });
        }
        segments.push({ text: label.slice(idx, idx + filterQuery.length), match: true });
        cursor = idx + filterQuery.length;
      }
      return segments;
    }

    // Fuzzy scattered match: mark individual characters at the matched indices.
    if (result.fuzzyIdx) {
      const matchSet = new Set(result.fuzzyIdx);
      const segments: Array<{ text: string; match: boolean }> = [];
      let current = '';
      let currentMatch = false;
      for (let i = 0; i < label.length; i++) {
        const isMatch = matchSet.has(i);
        if (i === 0) {
          current = label[i] ?? '';
          currentMatch = isMatch;
        } else if (isMatch === currentMatch) {
          current += label[i] ?? '';
        } else {
          segments.push({ text: current, match: currentMatch });
          current = label[i] ?? '';
          currentMatch = isMatch;
        }
      }
      if (current) segments.push({ text: current, match: currentMatch });
      return segments;
    }

    return [{ text: label, match: false }];
  };

  // Compute visible window. On small terminals, the picker can overflow;
  // we show at most VISIBLE_FIELDS around the current selection so every
  // field stays reachable. The window grows with the terminal: 8 fields is
  // the floor (the historical fixed size), taller terminals show more.
  // Reserved rows: picker chrome (border/title/legend/scroll indicators/
  // footer, ~9) + the input box, statusline and key-hint bar below (~8)
  // + up to 9 section-header lines that render inside the window.
  const { stdout } = useStdout();
  const termRows = stdout?.rows ?? 24;
  const VISIBLE_FIELDS = Math.max(8, termRows - 26);
  const totalFields = fieldRowIndex.length; // = SETTINGS_FIELD_COUNT
  const windowStart =
    totalFields <= VISIBLE_FIELDS
      ? 0
      : Math.max(0, Math.min(field - Math.floor(VISIBLE_FIELDS / 2), totalFields - VISIBLE_FIELDS));
  const windowEnd = Math.min(windowStart + VISIBLE_FIELDS, totalFields);
  const hasAbove = windowStart > 0;
  const hasBelow = windowEnd < totalFields;

  // Build section → field range map so we can decide whether to show
  // a section header (show it when ANY of its fields are in the window).
  const sectionFields: Array<{ headerIdx: number; fieldStart: number; fieldEnd: number }> = [];
  let curHeader = -1;
  for (let i = 0; i < rows.length; i++) {
    if (rows[i]?.section) curHeader = i;
    else if (curHeader >= 0) {
      const fieldIdx = fieldRowIndex.indexOf(i);
      if (fieldIdx === -1) continue;
      const entry = sectionFields.find((s) => s.headerIdx === curHeader);
      if (entry) {
        entry.fieldEnd = fieldIdx + 1;
      } else {
        sectionFields.push({ headerIdx: curHeader, fieldStart: fieldIdx, fieldEnd: fieldIdx + 1 });
      }
    }
  }
  const shouldShowSection = (headerIdx: number): boolean => {
    const sec = sectionFields.find((s) => s.headerIdx === headerIdx);
    if (!sec) return false;
    return sec.fieldStart < windowEnd && sec.fieldEnd > windowStart;
  };

  return (
    <Box flexDirection="column" borderStyle="round" borderColor="yellow" paddingX={1}>
      <Text color="cyan" bold>
        ━━ Settings ━━
      </Text>
      {filterActive ? (
        <Text color="yellow" bold>{`Filter: ${filter} (${filteredFieldIndices.length} match${filteredFieldIndices.length === 1 ? '' : 'es'})`}</Text>
      ) : (
        <Text dimColor>↑/↓ field · ←/→ change + autosave · `/` to search · F5 to close</Text>
      )}
      {hasAbove && !filterActive ? (
        <Text dimColor>{`  ↑ ${windowStart} field${windowStart === 1 ? '' : 's'} above`}</Text>
      ) : null}
      {filterActive && filteredFieldIndices.length === 0 ? (
        <Text dimColor italic>No matching settings rows.</Text>
      ) : null}
      {filterActive
        ? // Filter mode: render ranked rows in score order (not picker
          // order). Each row is looked up by its field index from the
          // `rows` array via `fieldRowIndex`.
          rankedResults.map((result) => {
            const fieldIdx = result.chord.field;
            // Find the `rows` entry for this field index.
            const rowIdx = fieldRowIndex[fieldIdx] ?? -1;
            const row = rows[rowIdx];
            if (!row?.label) return null;
            const selected = fieldIdx === field;
            const labelStr = row.label;
            const segments = highlightSegments(labelStr);
            const padNeeded = Math.max(0, 26 - labelStr.length);
            return (
              <Text key={`frow-${labelStr}`} inverse={selected} {...(selected ? { color: 'yellow' } : {})}>
                {selected ? '› ' : '  '}
                {segments.map((seg, j) => (
                  <Text
                    key={j}
                    bold
                    {...(seg.match ? { color: 'yellow' } : { dimColor: true })}
                  >
                    {seg.text}
                  </Text>
                ))}
                <Text bold dimColor>{' '.repeat(padNeeded)}</Text>
                <Text color="cyan">{String(row.value ?? '').padEnd(12)}</Text>
                <Text dimColor>{row.detail ?? ''}</Text>
              </Text>
            );
          })
        : // Normal mode: render rows in picker order with windowing.
          rows.map((row, i) => {
        const fieldAtRow = fieldRowIndex.indexOf(i);
        // Section headers are always shown when they fall between visible fields.
        // Non-section rows are only shown when their field index is in the window.
        if (fieldAtRow === -1) {
          if (filterActive) return null; // hide section headers in filter mode
          // Section header — show when any of its fields are in the window.
          if (shouldShowSection(i)) {
            return (
              <Text key={`section-${row.section ?? i}`} bold color="green">
                ── {row.section} ──
              </Text>
            );
          }
          return null;
        }
        // In filter mode, show only rows whose field index is in the
        // filtered set. In normal mode, show only rows in the visible window.
        if (filterActive) {
          if (!filteredFieldIndices.includes(fieldAtRow)) return null;
        } else if (fieldAtRow < windowStart || fieldAtRow >= windowEnd) return null;
        const selected = fieldAtRow === field;
        const labelStr = row.label ?? '';
        const segments = highlightSegments(labelStr);
        // Pad the label to 26 chars total so the value/detail columns
        // still align. Compute padding from the full label length (not
        // the segmented version — segments only affect colour, not width).
        const padNeeded = Math.max(0, 26 - labelStr.length);
        return (
          <Text key={`row-${row.label ?? fieldAtRow}`} inverse={selected} {...(selected ? { color: 'yellow' } : {})}>
            {selected ? '› ' : '  '}
            {filterActive ? (
              <>
                {segments.map((seg, j) => (
                  <Text
                    key={j}
                    bold
                    {...(seg.match ? { color: 'yellow' } : { dimColor: true })}
                  >
                    {seg.text}
                  </Text>
                ))}
                <Text bold dimColor>{' '.repeat(padNeeded)}</Text>
              </>
            ) : (
              <Text bold>{labelStr.padEnd(26)}</Text>
            )}
            <Text color="cyan">{String(row.value ?? '').padEnd(12)}</Text>
            <Text dimColor>{row.detail ?? ''}</Text>
          </Text>
        );
      })}
      {hasBelow && !filterActive ? (
        <Text dimColor>{`  ↓ ${totalFields - windowEnd} field${totalFields - windowEnd === 1 ? '' : 's'} below`}</Text>
      ) : null}
      <Text dimColor>
        {configScope === 'project'
          ? 'Persisted to <project>/.wrongstack/config.json'
          : 'Persisted to ~/.wrongstack/config.json'}
      </Text>
      {hint ? <Text color="yellow">{hint}</Text> : null}
    </Box>
  );
}
