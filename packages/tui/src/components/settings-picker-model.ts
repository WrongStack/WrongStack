import type { SettingsPickerPatch } from '../settings-contracts.js';
import { DEFAULT_PANEL_POSITIONS, PANEL_IDS, PANEL_POSITION_FIELD_START } from '../ui-contracts.js';
import {
  DEFAULT_STATUSLINE_MODE,
  formatBreakerTimeout,
  formatEnhanceDelay,
  formatMaxIterations,
  formatMultiDiffSummaryThreshold,
  formatPreRefineSeconds,
  formatSettingsDelay,
  SETTINGS_FIELD_LABELS,
} from './settings-picker-constants.js';

export * from './settings-picker-constants.js';
export * from './settings-picker-resolver.js';

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
