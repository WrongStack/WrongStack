import type { ReasoningEffort as CoreReasoningEffort } from '@wrongstack/core/types';
import type { SettingsPickerPatch } from '../settings-contracts.js';
import { MAX_TUI_THINKING_WORD_LENGTH } from '../thinking-word.js';
import {
  DEFAULT_PANEL_POSITIONS,
  PANEL_IDS,
  PANEL_POSITION_FIELD_START,
  TOTAL_SETTINGS_FIELD_COUNT,
} from '../ui-contracts.js';
import { ANIMATION_STYLE_DESCS, ANIMATION_STYLES } from './animation-style.js';

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
export const CONTEXT_MODES = ['balanced', 'frugal', 'deep'] as const;
export type ContextMode = (typeof CONTEXT_MODES)[number];

export const CONTEXT_MODE_DESCS: Record<ContextMode, string> = {
  balanced: 'Normal context usage (default)',
  frugal: 'Conservative token use',
  deep: 'Larger context for complex tasks',
};

export const STATUSLINE_MODES = ['minimum', 'detailed', 'no-color'] as const;
export type StatuslineMode = (typeof STATUSLINE_MODES)[number];

/**
 * Factory default statusline density. `minimum` is the default so a fresh
 * session shows a single clean rail (state · provider/model · context meter ·
 * version) with conditional chips only when relevant; `detailed` and
 * `no-color` are opt-in via /settings. Every app-level default site references
 * this constant so the default has a single source of truth. (The StatusBar
 * component's own prop default stays 'detailed' for back-compat with callers
 * that omit `mode` — the user-facing default is applied at the settings layer.)
 */
export const DEFAULT_STATUSLINE_MODE: StatuslineMode = 'minimum';

export const REASONING_MODES = ['auto', 'on', 'off'] as const;
export type ReasoningMode = (typeof REASONING_MODES)[number];

/**
 * Effort levels cycled by the /settings picker. Pinned to core's canonical
 * union via `satisfies` (subset-typed, not equal-typed, so a future core level
 * shows up here as a compile error reminding us to add it to the cycle) and
 * the exported type re-exports core's union directly.
 */
export const REASONING_EFFORTS = [
  'none',
  'minimal',
  'low',
  'medium',
  'high',
  'xhigh',
  'max',
] as const satisfies readonly CoreReasoningEffort[];
export type ReasoningEffort = CoreReasoningEffort;

export const CACHE_TTLS = ['default', '5m', '1h'] as const;
export type CacheTtl = (typeof CACHE_TTLS)[number];

export const STATUSLINE_MODE_DESCS: Record<StatuslineMode, string> = {
  minimum: 'Single line with essential chips only (default)',
  detailed: 'Full multi-line statusline',
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

/** Presets for pre-refine grace countdown (seconds). 0 = skip. */
export const PRE_REFINE_SECONDS_PRESETS = [0, 2, 3, 5, 8, 10];

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

/** Token-saving tier options — cyclable via ←/→ in the settings picker.
 *  `auto` is the default: it keeps the executable catalog, uses the medium
 *  direct surface, and adapts prompt trimming to the model window. */
export const TOKEN_SAVING_TIERS = [
  'auto',
  'off',
  'minimal',
  'light',
  'medium',
  'aggressive',
] as const;
export type TokenSavingTierTui = (typeof TOKEN_SAVING_TIERS)[number];

export const TOKEN_SAVING_TIER_DESCS: Record<TokenSavingTierTui, string> = {
  auto: 'Medium direct surface; prompt adapts to the model window',
  off: 'Every enabled catalog tool is sent directly; full prompt',
  minimal: 'Essential direct tools; compact prompt and guidance',
  light: 'Essential direct tools; retains common workflow guidance',
  medium: 'Essential + regular development tools; moderate trimming',
  aggressive: 'Smallest direct surface and most compact prompt',
};

/**
 * Fleet-chat verbosity options — cyclable via ←/→ in the settings picker.
 * Values MUST match core's `FleetChatVerbosity` union (config schema).
 */
export const FLEET_CHAT_MODES = ['off', 'full'] as const;
export type FleetChatVerbosityTui = (typeof FLEET_CHAT_MODES)[number];

export const FLEET_CHAT_MODE_DESCS: Record<FleetChatVerbosityTui, string> = {
  off: 'No subagent lines in chat (F2/F3 monitors stay live)',
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

export function formatPreRefineSeconds(s: number): string {
  if (s === 0) return 'off';
  return `${s}s`;
}

/** Animation style choices for the settings picker — all AnimationStyles plus 'cycle'. */
export const ANIMATION_STYLE_CHOICES = [...ANIMATION_STYLES, 'cycle'] as const;
export type AnimationStyleChoice = (typeof ANIMATION_STYLE_CHOICES)[number];

/** Human-readable label for an animation style choice (including cycle). */
export function formatAnimationStyle(style: AnimationStyleChoice): string {
  if (style === 'cycle') return 'cycle (shuffle all)';
  return ANIMATION_STYLE_DESCS[style];
}

export const MODE_DESC: Record<SettingsMode, string> = {
  off: 'Agent stops after each turn (normal)',
  suggest: 'Shows next-step suggestions after each turn',
  auto: 'Self-driving — agent continues automatically',
};

/** Total number of settings rows (used for wrap-around navigation).
 *  Indices 0–45 are the legacy auto-rebuilt Settings surface; 46..45+PANEL_IDS.length
 *  are the per-panel position rows (one per PanelId in PANEL_IDS order)
 *  added when the showAgentSwarmPanel tri-state was generalized into the
 *  per-panel PanelPositionMap. Derived from PANEL_IDS.length so adding
 *  a new panel id automatically extends the surface. */
export const SETTINGS_FIELD_COUNT = TOTAL_SETTINGS_FIELD_COUNT;

/**
 * Field index of the "Thinking word" row. The reducer's per-field switch and
 * the app.tsx key handler both branch on this, so it lives next to the row
 * definitions to keep the three in sync. If the row order changes, update this.
 */
export const THINKING_WORD_FIELD = 22;

/**
 * Field index of the "WrongProxy URL" row. Same rationale as
 * {@link THINKING_WORD_FIELD}: the keyboard handler in `use-app-picker-keys.ts`
 * dispatches `settingsWrongProxyUrlEditStart` when the user presses Enter
 * on this row, so the constant lives next to the row definition to keep
 * the three in sync.
 */
export const WRONGPROXY_URL_FIELD = 60;

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
 * Re-export of the canonical `SettingsPickerPatch` from `settings-contracts.ts`.
 * That module is the single source of truth so that `Action['patch']` (in
 * app-action-type.ts) and the helpers below stay in lock-step. Adding a new
 * key here requires adding it there too — keep them in sync.
 */
export type { SettingsPickerPatch };

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
  'Agent swarm panel', // 40
  'Pre-refine countdown', // 41
  'Read symbols', // 42
  'Show SAGE Memory Inject', // 43
  'SAGE Memory Inject threshold', // 44
  'Nextsteps tool', // 45
  'Project switcher placement', // 46 (P panel id index 0)
  'Fleet placement', // 47 (P panel id index 1)
  'Agents placement', // 48 (P panel id index 2)
  'Worktree placement', // 49 (P panel id index 3)
  'Plan placement', // 50 (P panel id index 4)
  'Todos placement', // 51 (P panel id index 5)
  'Queue placement', // 52 (P panel id index 6)
  'Process list placement', // 53 (P panel id index 7)
  'Goal placement', // 54 (P panel id index 8)
  'Sessions placement', // 55 (P panel id index 9)
  'Coordinator placement', // 56 (P panel id index 10)
  'Kanban placement', // 57 (P panel id index 11)
  'Connections placement', // 58 (P panel id index 12)
  // WrongProxy / WrongTrace (appended at the end so existing field
  // indices 0–58 — including the panel-position block at 46–58 — are
  // not shifted by the addition). The runtime probe in
  // `packages/cli/src/wiring/proxy-probe.ts` reacts to these via the
  // WS `prefs.update` pipeline; the picker is just the user surface.
  'WrongProxy / WrongTrace', // 59
  'WrongProxy URL', // 60
  'Right sidebar', // 61
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
):
  | { ok: true; patch: SettingsPickerPatch; label: string; displayValue: string }
  | { ok: false; error: string } {
  const raw = input.trim().toLowerCase();
  const label = SETTINGS_FIELD_LABELS[field] ?? `Field ${field}`;

  // ── Boolean fields ──
  const BOOL_FIELDS = new Map<number, keyof SettingsPickerPatch>([
    [2, 'titleAnimation'],
    [3, 'yolo'],
    [5, 'chime'],
    [6, 'confirmExit'],
    [7, 'nextPrediction'],
    [8, 'featureMcp'],
    [9, 'featurePlugins'],
    [10, 'featureMemory'],
    [11, 'featureSkills'],
    [12, 'featureModelsRegistry'],
    [14, 'allowOutsideProjectRoot'],
    [18, 'enhanceEnabled'],
    [20, 'indexOnStart'],
    [25, 'reasoningPreserve'],
    [27, 'contextAutoCompact'],
    [33, 'debugStream'],
    [37, 'breakerEnabled'],
    [39, 'showModelReasoning'],
    // [40, 'showAgentSwarmPanel'] — now an enum, see ENUM_FIELDS below
    [42, 'readSymbols'],
    [43, 'showSageMemoryInject'],
    [45, 'nextStepsTool'],
    // WrongProxy / WrongTrace master switch (field 59). The companion
    // URL field (60) is text-typed, see resolveSettingsFieldValue.
    [59, 'wrongProxyEnabled'],
    // Right sidebar master switch (field 61).
    [61, 'showSidebar'],
  ]);
  const boolKey = BOOL_FIELDS.get(field);
  if (boolKey) {
    if (['on', 'true', 'yes', '1'].includes(raw)) {
      return {
        ok: true,
        patch: { [boolKey]: true } as SettingsPickerPatch,
        label,
        displayValue: 'on',
      };
    }
    if (['off', 'false', 'no', '0'].includes(raw)) {
      return {
        ok: true,
        patch: { [boolKey]: false } as SettingsPickerPatch,
        label,
        displayValue: 'off',
      };
    }
    return { ok: false, error: `Invalid value "${input}" for ${label}. Use on or off.` };
  }

  // ── Enum fields ──
  // Each entry: [field, stateKey, allowedValues]
  // Field 4 (fleet chat) accepts the legacy boolean tokens too:
  // "on"/"true" → 'full', "false"/"no" → 'off' — so old `/settings
  // stream-fleet on|off` muscle memory keeps working.
  if (field === 4) {
    const legacy = ['on', 'true', 'yes', '1'].includes(raw)
      ? 'full'
      : ['false', 'no', '0'].includes(raw)
        ? 'off'
        : undefined;
    const match = (FLEET_CHAT_MODES as readonly string[]).includes(raw)
      ? (raw as FleetChatVerbosityTui)
      : legacy;
    if (match) {
      return {
        ok: true,
        patch: { fleetChat: match as FleetChatVerbosityTui },
        label,
        displayValue: match,
      };
    }
    return {
      ok: false,
      error: `Invalid value "${input}" for ${label}. Valid: ${FLEET_CHAT_MODES.join(', ')}.`,
    };
  }

  const ENUM_FIELDS: ReadonlyArray<
    readonly [number, keyof SettingsPickerPatch, readonly string[]]
  > = [
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
    [40, 'showAgentSwarmPanel', ['bottom', 'sidebar', 'off']],
    // Note: field 40 (`showAgentSwarmPanel`, tri-state including 'off') and
    // field 47 (`Agents placement` from PANEL_IDS[2]='agents', 2-state
    // 'bottom'|'sidebar') both target the same panel. `PanelPosition`
    // cannot express 'off', so the legacy field carries the hidden state
    // while the per-panel row carries the placement. Precedence (defined
    // by app-view routing, a pending task) will be: when
    // `showAgentSwarmPanel === 'off'`, the Agents panel is hidden
    // regardless of `panelPositions.agents`. When `'bottom'` or
    // `'sidebar'`, the per-panel row controls placement and the legacy
    // field is a redundant alias. Setter surfaces currently emit each
    // control independently; if a future write goes through a unified
    // setter, fold `'off'` into `panelPositions.agents` removal and
    // collapse field 40 to a derived view.
  ];
  for (const [f, key, values] of ENUM_FIELDS) {
    if (field !== f) continue;
    const match = values.find((v) => v.toLowerCase() === raw);
    if (match) {
      return {
        ok: true,
        patch: { [key]: match } as SettingsPickerPatch,
        label,
        displayValue: match,
      };
    }
    return {
      ok: false,
      error: `Invalid value "${input}" for ${label}. Valid: ${values.join(', ')}.`,
    };
  }

  // ── SAGE threshold (float presets) ──
  // Uses parseFloat because the values are 0.72–0.95, not integers.
  if (field === 44) {
    const presets = SAGE_THRESHOLD_PRESETS;
    const rawMatch = raw.match(/^(\d+(?:\.\d+)?)$/);
    if (rawMatch) {
      const asFloat = Number.parseFloat(rawMatch[1]!);
      if (presets.includes(asFloat)) {
        return {
          ok: true,
          patch: { sageMemoryInjectThreshold: asFloat },
          label,
          displayValue: formatSageThreshold(asFloat),
        };
      }
    }
    const options = presets.map((p) => formatSageThreshold(p)).join(', ');
    return {
      ok: false,
      error: `Invalid value "${input}" for ${label}. Available: ${options}.`,
    };
  }

  // ── Preset (numeric) fields ──
  // Each entry: [field, stateKey, presets, formatFn]
  // formatFn maps a preset number → its display name (for "unlimited", "off", etc.)
  const presetLabel = (n: number, zeroLabel: string): string => (n === 0 ? zeroLabel : String(n));
  const PRESET_FIELDS: ReadonlyArray<
    readonly [number, keyof SettingsPickerPatch, readonly number[], (n: number) => string]
  > = [
    [1, 'delayMs', DELAY_PRESETS_MS, (n) => formatSettingsDelay(n)],
    [15, 'maxIterations', MAX_ITERATIONS_PRESETS, (n) => formatMaxIterations(n)],
    [16, 'autoProceedMaxIterations', AUTO_PROCEED_MAX_PRESETS, (n) => formatMaxIterations(n)],
    [17, 'enhanceDelayMs', ENHANCE_DELAY_PRESETS, (n) => formatEnhanceDelay(n)],
    [41, 'preRefineSeconds', PRE_REFINE_SECONDS_PRESETS, (n) => formatPreRefineSeconds(n)],
    [
      21,
      'multiDiffSummaryThreshold',
      MULTI_DIFF_SUMMARY_THRESHOLD_PRESETS,
      (n) => formatMultiDiffSummaryThreshold(n),
    ],
    [30, 'maxConcurrent', MAX_CONCURRENT_PRESETS, (n) => presetLabel(n, 'runtime default')],
    [38, 'breakerAutoKillResetMs', BREAKER_TIMEOUT_PRESETS, (n) => formatBreakerTimeout(n)],
  ];
  for (const [f, key, presets, fmt] of PRESET_FIELDS) {
    if (field !== f) continue;
    // Try matching as a number first.
    const asNum = Number.parseInt(raw, 10);
    if (!Number.isNaN(asNum) && presets.includes(asNum)) {
      return {
        ok: true,
        patch: { [key]: asNum } as SettingsPickerPatch,
        label,
        displayValue: fmt(asNum),
      };
    }
    // Try matching against display names (e.g. "unlimited" → 0, "30s" → 30000).
    const byName = presets.find((p) => fmt(p).toLowerCase() === raw);
    if (byName !== undefined) {
      return {
        ok: true,
        patch: { [key]: byName } as SettingsPickerPatch,
        label,
        displayValue: fmt(byName),
      };
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

  // ── WrongProxy URL (text, field 60) ──
  // Permissive validation: accept any non-empty string starting with
  // http:// or https://. The runtime probe in
  // `packages/cli/src/wiring/proxy-probe.ts` flips `active` to false on
  // any malformed/4xx/5xx/timeout response, so over-permissive parsing
  // here is harmless — the user simply sees the toggle stay inactive
  // until the URL points at a real daemon. Mirrors how the WebUI
  // `IntegrationsSection` Input accepts free-form text.
  if (field === 60) {
    const url = input.trim();
    if (url.length === 0) {
      return { ok: false, error: `"${input}" is not a valid proxy URL. Use http://host:port or https://host:port.` };
    }
    if (!/^https?:\/\//i.test(url)) {
      return { ok: false, error: `"${input}" is not a valid proxy URL. Use http://host:port or https://host:port.` };
    }
    return { ok: true, patch: { wrongProxyUrl: url }, label, displayValue: url };
  }

  // Per-panel position rows (45–57). Accept 'bottom' or 'sidebar' as the
  // value; produce a partial patch that updates ONLY the matching panel id.
  // The reducer's `settingsValueSet` case deep-merges the partial
  // `panelPositions` into the existing map (see settings-values.ts), so we
  // emit a single-key spread rather than a full DEFAULT_PANEL_POSITIONS —
  // otherwise unrelated panels would silently snap back to 'bottom'.
  // The bounds check above guarantees PANEL_IDS[field - 45] is defined;
  // using PANEL_IDS.length (not a hardcoded 57) keeps the range in sync
  // when a new panel is added to PANEL_IDS.
  if (
    field >= PANEL_POSITION_FIELD_START &&
    field - PANEL_POSITION_FIELD_START < PANEL_IDS.length
  ) {
    const panelId = PANEL_IDS[field - PANEL_POSITION_FIELD_START]!;
    if (raw === 'bottom' || raw === 'sidebar') {
      return {
        ok: true,
        patch: { panelPositions: { [panelId]: raw } } as SettingsPickerPatch,
        label,
        displayValue: raw,
      };
    }
    return {
      ok: false,
      error: `Invalid value "${input}" for ${label}. Use bottom or sidebar.`,
    };
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
    [2, 'titleAnimation'],
    [3, 'yolo'],
    [5, 'chime'],
    [6, 'confirmExit'],
    [7, 'nextPrediction'],
    [8, 'featureMcp'],
    [9, 'featurePlugins'],
    [10, 'featureMemory'],
    [11, 'featureSkills'],
    [12, 'featureModelsRegistry'],
    [14, 'allowOutsideProjectRoot'],
    [18, 'enhanceEnabled'],
    [20, 'indexOnStart'],
    [25, 'reasoningPreserve'],
    [27, 'contextAutoCompact'],
    [33, 'debugStream'],
    [37, 'breakerEnabled'],
    [39, 'showModelReasoning'],
    // [40, 'showAgentSwarmPanel'] — now an enum, see ENUM_KEYS below
    [42, 'readSymbols'],
    [43, 'showSageMemoryInject'],
    [45, 'nextStepsTool'],
    // WrongProxy / WrongTrace master switch (field 59). The companion
    // URL field (60) is text-typed, see getSettingsFieldValue.
    [59, 'wrongProxyEnabled'],
    // Right sidebar master switch (field 61).
    [61, 'showSidebar'],
  ];
  for (const [f, key] of BOOL_KEYS) {
    if (field !== f) continue;
    return { ok: true, label, displayValue: values[key] ? 'on' : 'off' };
  }

  // Enum fields — display the raw value.
  const ENUM_KEYS: ReadonlyArray<readonly [number, keyof SettingsPickerPatch]> = [
    [0, 'mode'],
    [4, 'fleetChat'],
    [13, 'tokenSavingTier'],
    [19, 'enhanceLanguage'],
    [23, 'reasoningMode'],
    [24, 'reasoningEffort'],
    [26, 'cacheTtl'],
    [28, 'contextStrategy'],
    [29, 'contextMode'],
    [31, 'logLevel'],
    [32, 'auditLevel'],
    [34, 'statuslineMode'],
    [35, 'configScope'],
    [36, 'animationStyle'],
    [40, 'showAgentSwarmPanel'],
  ];
  for (const [f, key] of ENUM_KEYS) {
    if (field !== f) continue;
    return { ok: true, label, displayValue: String(values[key]) };
  }

  // Preset fields — display via the format function.
  const presetLabel = (n: number, zeroLabel: string): string => (n === 0 ? zeroLabel : String(n));
  const PRESET_KEYS: ReadonlyArray<
    readonly [number, keyof SettingsPickerPatch, (n: number) => string]
  > = [
    [1, 'delayMs', formatSettingsDelay],
    [15, 'maxIterations', formatMaxIterations],
    [16, 'autoProceedMaxIterations', formatMaxIterations],
    [17, 'enhanceDelayMs', formatEnhanceDelay],
    [41, 'preRefineSeconds', formatPreRefineSeconds],
    [21, 'multiDiffSummaryThreshold', formatMultiDiffSummaryThreshold],
    [30, 'maxConcurrent', (n) => presetLabel(n, 'runtime default')],
    [38, 'breakerAutoKillResetMs', formatBreakerTimeout],
    [44, 'sageMemoryInjectThreshold', formatSageThreshold],
  ];
  for (const [f, key, fmt] of PRESET_KEYS) {
    if (field !== f) continue;
    return { ok: true, label, displayValue: fmt(values[key] as number) };
  }

  // Text field (thinking word).
  if (field === 22) {
    return { ok: true, label, displayValue: values.thinkingWord };
  }

  // Text field (WrongProxy URL, field 60). Display the verbatim URL so the
  // user can confirm exactly which daemon is being probed.
  if (field === 60) {
    return { ok: true, label, displayValue: values.wrongProxyUrl };
  }

  // Per-panel position rows (45–57). Each field maps onto one panel id in
  // PANEL_IDS order; display the current placement for that panel. The map
  // is always normalized to a full PanelPositionMap at boot (see
  // coercePanelPositionMap), so the index access is total. The bounds
  // check above guarantees PANEL_IDS[field - 45] is defined; using
  // PANEL_IDS.length (not a hardcoded 57) keeps the range in sync when a
  // new panel is added to PANEL_IDS.
  if (
    field >= PANEL_POSITION_FIELD_START &&
    field - PANEL_POSITION_FIELD_START < PANEL_IDS.length
  ) {
    const panelId = PANEL_IDS[field - PANEL_POSITION_FIELD_START]!;
    // The map is normalized to a full PanelPositionMap at boot (see
    // coercePanelPositionMap), so panelPositions[panelId] is always
    // defined. The `?? 'bottom'` fallback appeases noUncheckedIndexedAccess
    // and matches the runtime invariant.
    return {
      ok: true,
      label,
      displayValue: values.panelPositions[panelId] ?? 'bottom',
    };
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
    fields: [15, 16, 17, 18, 19, 20, 21, 22, 42, 45],
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
    fields: [39, 40, 41, 43, 44, 61],
  },
  {
    name: 'Panels',
    fields: [46, 47, 48, 49, 50, 51, 52, 53, 54, 55, 56, 57, 58],
  },
  {
    // WrongProxy / WrongTrace — fields 59 (master switch) + 60 (URL).
    // Sits in its own section because the runtime probe + base-URL
    // rewrite it controls live outside the picker's normal "feature
    // toggle" semantics; matching the WebUI's IntegrationsSection
    // keeps the cross-surface contract obvious. Appended at the end
    // to avoid shifting the panel-position block 46–58 indices.
    name: 'Integrations',
    fields: [59, 60],
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

/** Presets for the SAGE memory injection threshold. Values 0.72–0.95. */
export const SAGE_THRESHOLD_PRESETS = [0.72, 0.75, 0.85, 0.9, 0.95];

/** Format the threshold value. All valid values are in {@link SAGE_THRESHOLD_PRESETS}. */
export function formatSageThreshold(t: number): string {
  return t.toFixed(2);
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
  fleetChat: 'off',
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
  preRefineSeconds: 3,
  enhanceEnabled: true,
  enhanceLanguage: 'original',
  debugStream: false,
  statuslineMode: DEFAULT_STATUSLINE_MODE,
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
  showAgentSwarmPanel: 'bottom',
  panelPositions: DEFAULT_PANEL_POSITIONS,
  readSymbols: false,
  showSageMemoryInject: true,
  sageMemoryInjectThreshold: 0.85,
  nextStepsTool: false,
  // WrongProxy / WrongTrace. Defaults mirror the WebUI `LocalPrefs`
  // DEFAULTS in `packages/webui/src/stores/local-prefs.ts` (master
  // switch off, URL 'http://localhost:3444'). Required keys here
  // because `SettingsPickerValues` (mapped from `SettingsPickerPatch`)
  // makes every key mandatory — omitting them here breaks the type
  // contract for the entire TUI settings module. See Chimera review.
  wrongProxyEnabled: false,
  wrongProxyUrl: 'http://localhost:3444',
  showSidebar: true,
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
):
  | { ok: true; patch: SettingsPickerPatch; label: string; displayValue: string }
  | { ok: false; error: string } {
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
    [0, 'mode'],
    [1, 'delayMs'],
    [2, 'titleAnimation'],
    [3, 'yolo'],
    [4, 'fleetChat'],
    [5, 'chime'],
    [6, 'confirmExit'],
    [7, 'nextPrediction'],
    [8, 'featureMcp'],
    [9, 'featurePlugins'],
    [10, 'featureMemory'],
    [11, 'featureSkills'],
    [12, 'featureModelsRegistry'],
    [13, 'tokenSavingTier'],
    [14, 'allowOutsideProjectRoot'],
    [15, 'maxIterations'],
    [16, 'autoProceedMaxIterations'],
    [17, 'enhanceDelayMs'],
    [18, 'enhanceEnabled'],
    [19, 'enhanceLanguage'],
    [20, 'indexOnStart'],
    [21, 'multiDiffSummaryThreshold'],
    [22, 'thinkingWord'],
    [23, 'reasoningMode'],
    [24, 'reasoningEffort'],
    [25, 'reasoningPreserve'],
    [26, 'cacheTtl'],
    [27, 'contextAutoCompact'],
    [28, 'contextStrategy'],
    [29, 'contextMode'],
    [30, 'maxConcurrent'],
    [31, 'logLevel'],
    [32, 'auditLevel'],
    [33, 'debugStream'],
    [34, 'statuslineMode'],
    [35, 'configScope'],
    [36, 'animationStyle'],
    [37, 'breakerEnabled'],
    [38, 'breakerAutoKillResetMs'],
    [39, 'showModelReasoning'],
    [40, 'showAgentSwarmPanel'],
    [41, 'preRefineSeconds'],
    [42, 'readSymbols'],
    [43, 'showSageMemoryInject'],
    [44, 'sageMemoryInjectThreshold'],
    [45, 'nextStepsTool'],
    // WrongProxy / WrongTrace: appended at the end so the existing
    // 46+13 = 59 entries are not shifted (the picker caps + scrolls;
    // field 59 is boolean, 60 is text). See `Settings.wrongProxy*`
    // and `ToolsConfig.wrongProxy?: WrongProxyToolConfig` for the
    // canonical persistence shape.
    [59, 'wrongProxyEnabled'],
    [60, 'wrongProxyUrl'],
    // Right sidebar master switch (field 61). Without this entry,
    // `/settings reset sidebar` returns null and the field is
    // unresettable even though BOOL_FIELDS accepts on/off for it.
    [61, 'showSidebar'],
  ];
  for (const [f, key] of KEY_MAP) {
    if (f === field) {
      // Field 40 (showAgentSwarmPanel) is derived from panelPositions.fleet.
      // When resetting it, also reset the fleet position so the two fields
      // stay in sync — the settingsValueSet reducer derives showAgentSwarmPanel
      // from panelPositions.fleet, so an explicit swarm value alone would be
      // overridden if fleet is still 'sidebar'.
      if (f === 40) {
        return {
          showAgentSwarmPanel: SETTINGS_DEFAULTS['showAgentSwarmPanel'],
          panelPositions: { fleet: 'bottom' as const },
        } as SettingsPickerPatch;
      }
      return { [key]: SETTINGS_DEFAULTS[key] } as SettingsPickerPatch;
    }
  }
  // Fields 45..44+PANEL_IDS.length: per-panel position rows. Each maps
  // onto the single panelPositions state key, but the patch must reset
  // only the matching panel id (not the whole map). The factory default
  // for every panel position is 'bottom', so each row resolves to a
  // single-key partial. The reducer's `settingsValueSet` case deep-merges
  // partial `panelPositions` patches (see settings-values.ts). Using
  // PANEL_IDS.length (not a hardcoded 57) keeps the range in sync when a
  // new panel is added to PANEL_IDS.
  if (
    field >= PANEL_POSITION_FIELD_START &&
    field - PANEL_POSITION_FIELD_START < PANEL_IDS.length
  ) {
    const panelId = PANEL_IDS[field - PANEL_POSITION_FIELD_START]!;
    return {
      panelPositions: { [panelId]: 'bottom' as const },
    } as SettingsPickerPatch;
  }
  return null;
}
