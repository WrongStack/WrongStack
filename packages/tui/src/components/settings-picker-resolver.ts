import type { SettingsPickerPatch } from '../settings-contracts.js';
import { MAX_TUI_THINKING_WORD_LENGTH } from '../thinking-word.js';
import { PANEL_IDS, PANEL_POSITION_FIELD_START } from '../ui-contracts.js';
import {
  ANIMATION_STYLE_CHOICES,
  AUDIT_LEVELS,
  AUTO_PROCEED_MAX_PRESETS,
  BREAKER_TIMEOUT_PRESETS,
  CACHE_TTLS,
  COMPACTOR_STRATEGIES,
  CONFIG_SCOPES,
  CONTEXT_MODES,
  DELAY_PRESETS_MS,
  ENHANCE_DELAY_PRESETS,
  ENHANCE_LANGUAGES,
  FLEET_CHAT_MODES,
  type FleetChatVerbosityTui,
  formatBreakerTimeout,
  formatEnhanceDelay,
  formatMaxIterations,
  formatMultiDiffSummaryThreshold,
  formatPreRefineSeconds,
  formatSageThreshold,
  formatSettingsDelay,
  LOG_LEVELS,
  MAX_CONCURRENT_PRESETS,
  MAX_ITERATIONS_PRESETS,
  MULTI_DIFF_SUMMARY_THRESHOLD_PRESETS,
  PRE_REFINE_SECONDS_PRESETS,
  REASONING_EFFORTS,
  REASONING_MODES,
  SAGE_THRESHOLD_PRESETS,
  SETTINGS_FIELD_LABELS,
  SETTINGS_MODES,
  STATUSLINE_MODES,
  TOKEN_SAVING_TIERS,
} from './settings-picker-constants.js';

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
    [42, 'readSymbols'],
    [43, 'showSageMemoryInject'],
    [45, 'nextStepsTool'],
    [59, 'wrongProxyEnabled'],
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
    const asNum = Number.parseInt(raw, 10);
    if (!Number.isNaN(asNum) && presets.includes(asNum)) {
      return {
        ok: true,
        patch: { [key]: asNum } as SettingsPickerPatch,
        label,
        displayValue: fmt(asNum),
      };
    }
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
  if (field === 60) {
    const url = input.trim();
    if (url.length === 0) {
      return {
        ok: false,
        error: `"${input}" is not a valid proxy URL. Use http://host:port or https://host:port.`,
      };
    }
    if (!/^https?:\/\//i.test(url)) {
      return {
        ok: false,
        error: `"${input}" is not a valid proxy URL. Use http://host:port or https://host:port.`,
      };
    }
    return { ok: true, patch: { wrongProxyUrl: url }, label, displayValue: url };
  }

  // Per-panel position rows (46–58).
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
