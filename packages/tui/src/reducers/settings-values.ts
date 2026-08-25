import { expectDefined } from '@wrongstack/core/utils';
import { MAX_WRONGPROXY_URL_LENGTH } from '@wrongstack/core/types';
import type { Action } from '../app-action-type.js';
import type { State } from '../app-state.js';
import {
  ANIMATION_STYLE_CHOICES,
  type AnimationStyleChoice,
  AUDIT_LEVELS,
  AUTO_PROCEED_MAX_PRESETS,
  BREAKER_TIMEOUT_PRESETS,
  CACHE_TTLS,
  COMPACTOR_STRATEGIES,
  CONFIG_SCOPES,
  CONTEXT_MODES,
  DEFAULT_STATUSLINE_MODE,
  DELAY_PRESETS_MS,
  ENHANCE_DELAY_PRESETS,
  ENHANCE_LANGUAGES,
  FLEET_CHAT_MODES,
  LOG_LEVELS,
  MAX_CONCURRENT_PRESETS,
  MAX_ITERATIONS_PRESETS,
  MULTI_DIFF_SUMMARY_THRESHOLD_PRESETS,
  PRE_REFINE_SECONDS_PRESETS,
  REASONING_EFFORTS,
  REASONING_MODES,
  SAGE_THRESHOLD_PRESETS,
  SETTINGS_MODES,
  STATUSLINE_MODES,
  THINKING_WORD_FIELD,
  THINKING_WORD_PRESETS,
  TOKEN_SAVING_TIERS,
} from '../components/settings-picker.js';
import { MAX_TUI_THINKING_WORD_LENGTH, normalizeTuiThinkingWord } from '../thinking-word.js';
import { PANEL_IDS, PANEL_POSITION_FIELD_START } from '../ui-contracts.js';

const settingsValueActionTypes = [
  'settingsValueChange',
  'settingsValueSet',
  'settingsHint',
  'settingsThinkingEditStart',
  'settingsThinkingEditChange',
  'settingsThinkingEditCommit',
  'settingsThinkingEditCancel',
  // WrongProxy / WrongTrace URL (field 60) text-edit quartet.
  // Adding these here routes them into `reduceSettingsValues` via the
  // `SettingsValueAction` extract — without these, the actions hit the
  // generic `reduce*` path and the `action satisfies never` narrowing
  // marks the whole `Action` union as unassignable to `never`.
  'settingsWrongProxyUrlEditStart',
  'settingsWrongProxyUrlEditChange',
  'settingsWrongProxyUrlEditCommit',
  'settingsWrongProxyUrlEditCancel',
] as const satisfies readonly Action['type'][];

type SettingsValueAction = Extract<Action, { type: (typeof settingsValueActionTypes)[number] }>;
const settingsValueActionTypeSet = new Set<string>(settingsValueActionTypes);

export function isSettingsValueAction(action: Action): action is SettingsValueAction {
  return settingsValueActionTypeSet.has(action.type);
}

/** Reduces validated settings values and thinking-word editing. */
export function reduceSettingsValues(state: State, action: SettingsValueAction): State {
  switch (action.type) {
    case 'settingsValueChange': {
      const sp = state.settingsPicker;
      const f = sp.field;
      // Boot-only settings can't be applied to the running session — they are
      // loaded at startup (feature toggles, index-on-start) or require
      // rebinding subsystems (compactor strategy). Surface a hint when one of
      // these is changed so the user knows a restart is needed; all other
      // fields apply live (see cli-main applyLiveSettings + TUI live refs).
      const bootHint = '↻ Takes effect next session';
      // Field 0: autonomy mode (cycle SETTINGS_MODES)
      if (f === 0) {
        const i = SETTINGS_MODES.indexOf(sp.mode);
        const base = i < 0 ? 0 : i;
        const next = (base + action.delta + SETTINGS_MODES.length) % SETTINGS_MODES.length;
        return {
          ...state,
          settingsPicker: { ...sp, mode: expectDefined(SETTINGS_MODES[next]), hint: undefined },
        };
      }
      // Field 1: delay presets
      if (f === 1) {
        const j = DELAY_PRESETS_MS.indexOf(sp.delayMs);
        const base = j < 0 ? 0 : j;
        const next = (base + action.delta + DELAY_PRESETS_MS.length) % DELAY_PRESETS_MS.length;
        return {
          ...state,
          settingsPicker: {
            ...sp,
            delayMs: expectDefined(DELAY_PRESETS_MS[next]),
            hint: undefined,
          },
        };
      }
      // Field 2–7: UX boolean toggles
      if (f === 2)
        return {
          ...state,
          settingsPicker: { ...sp, titleAnimation: !sp.titleAnimation, hint: undefined },
        };
      if (f === 3) return { ...state, settingsPicker: { ...sp, yolo: !sp.yolo, hint: undefined } };
      // Field 4: fleet-chat verbosity (off | compact | full) — enum cycle
      if (f === 4) {
        const i = FLEET_CHAT_MODES.indexOf(sp.fleetChat);
        const base = i < 0 ? 0 : i;
        const next = (base + action.delta + FLEET_CHAT_MODES.length) % FLEET_CHAT_MODES.length;
        return {
          ...state,
          settingsPicker: {
            ...sp,
            fleetChat: expectDefined(FLEET_CHAT_MODES[next]),
            hint: undefined,
          },
        };
      }
      if (f === 5)
        return { ...state, settingsPicker: { ...sp, chime: !sp.chime, hint: undefined } };
      if (f === 6)
        return {
          ...state,
          settingsPicker: { ...sp, confirmExit: !sp.confirmExit, hint: undefined },
        };
      if (f === 7)
        return {
          ...state,
          settingsPicker: { ...sp, nextPrediction: !sp.nextPrediction, hint: undefined },
        };
      // Field 8–12: Features boolean toggles
      if (f === 8)
        return { ...state, settingsPicker: { ...sp, featureMcp: !sp.featureMcp, hint: bootHint } };
      if (f === 9)
        return {
          ...state,
          settingsPicker: { ...sp, featurePlugins: !sp.featurePlugins, hint: bootHint },
        };
      if (f === 10)
        return {
          ...state,
          settingsPicker: { ...sp, featureMemory: !sp.featureMemory, hint: bootHint },
        };
      if (f === 11)
        return {
          ...state,
          settingsPicker: { ...sp, featureSkills: !sp.featureSkills, hint: bootHint },
        };
      if (f === 12)
        return {
          ...state,
          settingsPicker: {
            ...sp,
            featureModelsRegistry: !sp.featureModelsRegistry,
            hint: bootHint,
          },
        };
      // Field 13: Token-saving tier (cycle)
      if (f === 13) {
        const i = TOKEN_SAVING_TIERS.indexOf(
          sp.tokenSavingTier as (typeof TOKEN_SAVING_TIERS)[number],
        );
        const base = i < 0 ? 0 : i;
        const next = (base + action.delta + TOKEN_SAVING_TIERS.length) % TOKEN_SAVING_TIERS.length;
        return {
          ...state,
          settingsPicker: {
            ...sp,
            tokenSavingTier: TOKEN_SAVING_TIERS[next] ?? 'off',
            hint: bootHint,
          },
        };
      }
      // Field 14: allow outside project root (boolean)
      if (f === 14)
        return {
          ...state,
          settingsPicker: {
            ...sp,
            allowOutsideProjectRoot: !sp.allowOutsideProjectRoot,
            hint: undefined,
          },
        };
      // ── Tools ──────────────────────────────────────────────────────────────
      // Field 15: max iterations (cycle presets)
      if (f === 15) {
        const j = MAX_ITERATIONS_PRESETS.indexOf(sp.maxIterations);
        const base = j < 0 ? 0 : j;
        const next =
          (base + action.delta + MAX_ITERATIONS_PRESETS.length) % MAX_ITERATIONS_PRESETS.length;
        return {
          ...state,
          settingsPicker: {
            ...sp,
            maxIterations: expectDefined(MAX_ITERATIONS_PRESETS[next]),
            hint: undefined,
          },
        };
      }
      // Field 16: auto-proceed max iterations (cycle presets)
      if (f === 16) {
        const aj = AUTO_PROCEED_MAX_PRESETS.indexOf(sp.autoProceedMaxIterations);
        const abase = aj < 0 ? 0 : aj;
        const anext =
          (abase + action.delta + AUTO_PROCEED_MAX_PRESETS.length) %
          AUTO_PROCEED_MAX_PRESETS.length;
        return {
          ...state,
          settingsPicker: {
            ...sp,
            autoProceedMaxIterations: expectDefined(AUTO_PROCEED_MAX_PRESETS[anext]),
            hint: undefined,
          },
        };
      }
      // Field 17: enhance delay (cycle presets)
      if (f === 17) {
        const ej = ENHANCE_DELAY_PRESETS.indexOf(sp.enhanceDelayMs);
        const ebase = ej < 0 ? 0 : ej;
        const enext =
          (ebase + action.delta + ENHANCE_DELAY_PRESETS.length) % ENHANCE_DELAY_PRESETS.length;
        return {
          ...state,
          settingsPicker: {
            ...sp,
            enhanceDelayMs: expectDefined(ENHANCE_DELAY_PRESETS[enext]),
            hint: undefined,
          },
        };
      }
      // Field 18: enhance enabled (boolean)
      if (f === 18)
        return {
          ...state,
          settingsPicker: { ...sp, enhanceEnabled: !sp.enhanceEnabled, hint: undefined },
        };
      // Field 19: enhance language (cycle original/english)
      if (f === 19) {
        const i = ENHANCE_LANGUAGES.indexOf(sp.enhanceLanguage);
        const base = i < 0 ? 0 : i;
        const next = (base + action.delta + ENHANCE_LANGUAGES.length) % ENHANCE_LANGUAGES.length;
        return {
          ...state,
          settingsPicker: {
            ...sp,
            enhanceLanguage: expectDefined(ENHANCE_LANGUAGES[next]),
            hint: undefined,
          },
        };
      }
      // Field 20: index on start (boolean)
      if (f === 20)
        return {
          ...state,
          settingsPicker: { ...sp, indexOnStart: !sp.indexOnStart, hint: bootHint },
        };
      // Field 21: multi-diff summary threshold (cycle presets). 0 disables
      // the summary footer; positive values set the minimum file count.
      if (f === 21) {
        const j = MULTI_DIFF_SUMMARY_THRESHOLD_PRESETS.indexOf(sp.multiDiffSummaryThreshold);
        const base = j < 0 ? 0 : j;
        const next =
          (base + action.delta + MULTI_DIFF_SUMMARY_THRESHOLD_PRESETS.length) %
          MULTI_DIFF_SUMMARY_THRESHOLD_PRESETS.length;
        const multiDiffSummaryThreshold = expectDefined(MULTI_DIFF_SUMMARY_THRESHOLD_PRESETS[next]);
        return {
          ...state,
          settingsPicker: { ...sp, multiDiffSummaryThreshold, hint: undefined },
        };
      }
      // Field 22: thinking word — ←/→ cycles curated presets (Enter opens
      // free-text editing, handled by the settingsThinkingEdit* actions). The
      // current word is folded into the list so cycling never drops a custom
      // value set via the editor or config.
      if (f === THINKING_WORD_FIELD) {
        const cur = sp.thinkingWord;
        const list: string[] = (THINKING_WORD_PRESETS as readonly string[]).includes(cur)
          ? [...THINKING_WORD_PRESETS]
          : [cur, ...THINKING_WORD_PRESETS];
        const i = list.indexOf(cur);
        const base = i < 0 ? 0 : i;
        const next = (base + action.delta + list.length) % list.length;
        return {
          ...state,
          settingsPicker: { ...sp, thinkingWord: expectDefined(list[next]), hint: undefined },
        };
      }
      // ── Reasoning ───────────────────────────────────────────────────────────
      // Field 23: reasoning mode (cycle auto/on/off)
      if (f === 23) {
        const i = REASONING_MODES.indexOf(sp.reasoningMode as (typeof REASONING_MODES)[number]);
        const base = i < 0 ? 0 : i;
        const next = (base + action.delta + REASONING_MODES.length) % REASONING_MODES.length;
        return {
          ...state,
          settingsPicker: {
            ...sp,
            reasoningMode: expectDefined(REASONING_MODES[next]),
            hint: undefined,
          },
        };
      }
      // Field 24: reasoning effort (cycle)
      if (f === 24) {
        const i = REASONING_EFFORTS.indexOf(
          sp.reasoningEffort as (typeof REASONING_EFFORTS)[number],
        );
        const base = i < 0 ? REASONING_EFFORTS.indexOf('high') : i;
        const next = (base + action.delta + REASONING_EFFORTS.length) % REASONING_EFFORTS.length;
        return {
          ...state,
          settingsPicker: {
            ...sp,
            reasoningEffort: expectDefined(REASONING_EFFORTS[next]),
            hint: undefined,
          },
        };
      }
      // Field 25: reasoning preserve (boolean toggle)
      if (f === 25)
        return {
          ...state,
          settingsPicker: { ...sp, reasoningPreserve: !sp.reasoningPreserve, hint: undefined },
        };
      // Field 26: cache TTL (cycle default/5m/1h)
      if (f === 26) {
        const i = CACHE_TTLS.indexOf(sp.cacheTtl as (typeof CACHE_TTLS)[number]);
        const base = i < 0 ? 0 : i;
        const next = (base + action.delta + CACHE_TTLS.length) % CACHE_TTLS.length;
        return {
          ...state,
          settingsPicker: { ...sp, cacheTtl: expectDefined(CACHE_TTLS[next]), hint: undefined },
        };
      }
      // ── Context ────────────────────────────────────────────────────────────
      // Field 27: context auto-compact (boolean)
      if (f === 27)
        return {
          ...state,
          settingsPicker: { ...sp, contextAutoCompact: !sp.contextAutoCompact, hint: undefined },
        };
      // Field 28: compactor strategy (cycle)
      if (f === 28) {
        const i = COMPACTOR_STRATEGIES.indexOf(sp.contextStrategy);
        const base = i < 0 ? 0 : i;
        const next =
          (base + action.delta + COMPACTOR_STRATEGIES.length) % COMPACTOR_STRATEGIES.length;
        return {
          ...state,
          settingsPicker: {
            ...sp,
            contextStrategy: expectDefined(COMPACTOR_STRATEGIES[next]),
            hint: bootHint,
          },
        };
      }
      // Field 29: context mode (cycle)
      if (f === 29) {
        const i = CONTEXT_MODES.indexOf(sp.contextMode);
        const base = i < 0 ? 0 : i;
        const next = (base + action.delta + CONTEXT_MODES.length) % CONTEXT_MODES.length;
        return {
          ...state,
          settingsPicker: {
            ...sp,
            contextMode: expectDefined(CONTEXT_MODES[next]),
            hint: bootHint,
          },
        };
      }
      // ── Fleet ──────────────────────────────────────────────────────────────
      // Field 30: max concurrent (cycle presets)
      if (f === 30) {
        const j = MAX_CONCURRENT_PRESETS.indexOf(sp.maxConcurrent);
        const base = j < 0 ? 0 : j;
        const next =
          (base + action.delta + MAX_CONCURRENT_PRESETS.length) % MAX_CONCURRENT_PRESETS.length;
        const maxConcurrent = expectDefined(MAX_CONCURRENT_PRESETS[next]);
        return {
          ...state,
          settingsPicker: {
            ...sp,
            maxConcurrent,
            hint: maxConcurrent === 0 ? bootHint : undefined,
          },
        };
      }
      // ── Logging ────────────────────────────────────────────────────────────
      // Field 31: log level (cycle)
      if (f === 31) {
        const i = LOG_LEVELS.indexOf(sp.logLevel);
        const base = i < 0 ? 0 : i;
        const next = (base + action.delta + LOG_LEVELS.length) % LOG_LEVELS.length;
        return {
          ...state,
          settingsPicker: { ...sp, logLevel: expectDefined(LOG_LEVELS[next]), hint: undefined },
        };
      }
      // Field 32: audit level (cycle)
      if (f === 32) {
        const i = AUDIT_LEVELS.indexOf(sp.auditLevel);
        const base = i < 0 ? 0 : i;
        const next = (base + action.delta + AUDIT_LEVELS.length) % AUDIT_LEVELS.length;
        return {
          ...state,
          settingsPicker: { ...sp, auditLevel: expectDefined(AUDIT_LEVELS[next]), hint: undefined },
        };
      }
      // ── Debug ──────────────────────────────────────────────────────────────
      // Field 33: debug stream (boolean toggle)
      if (f === 33)
        return {
          ...state,
          settingsPicker: { ...sp, debugStream: !sp.debugStream, hint: undefined },
        };
      // Field 34: statusline mode (cycle minimum/detailed)
      if (f === 34) {
        const i = STATUSLINE_MODES.indexOf(sp.statuslineMode);
        const base = i < 0 ? STATUSLINE_MODES.indexOf(DEFAULT_STATUSLINE_MODE) : i;
        const next = (base + action.delta + STATUSLINE_MODES.length) % STATUSLINE_MODES.length;
        return {
          ...state,
          settingsPicker: {
            ...sp,
            statuslineMode: expectDefined(STATUSLINE_MODES[next]),
            hint: undefined,
          },
        };
      }
      // Field 35: config scope (cycle global/project)
      if (f === 35) {
        const i = CONFIG_SCOPES.indexOf(sp.configScope);
        const base = i < 0 ? 0 : i;
        const next = (base + action.delta + CONFIG_SCOPES.length) % CONFIG_SCOPES.length;
        return {
          ...state,
          settingsPicker: {
            ...sp,
            configScope: expectDefined(CONFIG_SCOPES[next]),
            hint: undefined,
          },
        };
      }
      // Field 36: animation style (cycle ANIMATION_STYLE_CHOICES)
      if (f === 36) {
        const i = ANIMATION_STYLE_CHOICES.indexOf(sp.animationStyle as AnimationStyleChoice);
        const base = i < 0 ? 0 : i;
        const next =
          (base + action.delta + ANIMATION_STYLE_CHOICES.length) % ANIMATION_STYLE_CHOICES.length;
        return {
          ...state,
          settingsPicker: {
            ...sp,
            animationStyle: expectDefined(ANIMATION_STYLE_CHOICES[next]),
            hint: undefined,
          },
        };
      }
      // ── Safety ─────────────────────────────────────────────────────────────
      // Field 37: circuit breaker (boolean toggle)
      if (f === 37)
        return {
          ...state,
          settingsPicker: { ...sp, breakerEnabled: !sp.breakerEnabled, hint: undefined },
        };
      // Field 38: breaker auto kill/reset timeout (cycle presets)
      if (f === 38) {
        const j = BREAKER_TIMEOUT_PRESETS.indexOf(sp.breakerAutoKillResetMs);
        const base = j < 0 ? 0 : j;
        const next =
          (base + action.delta + BREAKER_TIMEOUT_PRESETS.length) % BREAKER_TIMEOUT_PRESETS.length;
        return {
          ...state,
          settingsPicker: {
            ...sp,
            breakerAutoKillResetMs: expectDefined(BREAKER_TIMEOUT_PRESETS[next]),
            hint: undefined,
          },
        };
      }
      // ── Display ──────────────────────────────────────────────────────────────
      // Field 39: show model reasoning blocks in chat history (boolean toggle)
      if (f === 39)
        return {
          ...state,
          settingsPicker: { ...sp, showModelReasoning: !sp.showModelReasoning, hint: undefined },
        };
      // Field 40: agent swarm panel placement.
      // This field is now a DERIVED view of panelPositions.fleet — cycling
      // it directly updates panelPositions.fleet, and showAgentSwarmPanel
      // is computed from the fleet position. The 'off' semantic is
      // preserved via a separate hidden state: when the user cycles past
      // 'sidebar', the fleet position stays 'bottom' but showAgentSwarmPanel
      // becomes 'off' (hiding the persistent FleetPanel fallback).
      if (f === 40) {
        const fleetPos = sp.panelPositions.fleet;
        // Cycle: bottom → sidebar → off → bottom
        // bottom = fleet:'bottom', showAgentSwarmPanel:'bottom'
        // sidebar = fleet:'sidebar', showAgentSwarmPanel:'sidebar'
        // off = fleet:'bottom', showAgentSwarmPanel:'off'
        const currentDerived: 'bottom' | 'sidebar' | 'off' =
          fleetPos === 'sidebar' ? 'sidebar' : sp.showAgentSwarmPanel;
        const SWARM_CYCLE = ['bottom', 'sidebar', 'off'] as const;
        const j = SWARM_CYCLE.indexOf(currentDerived);
        const base = j < 0 ? 0 : j;
        const next =
          SWARM_CYCLE[(base + action.delta + SWARM_CYCLE.length) % SWARM_CYCLE.length] ?? 'bottom';
        return {
          ...state,
          settingsPicker: {
            ...sp,
            showAgentSwarmPanel: next,
            panelPositions: {
              ...sp.panelPositions,
              fleet: next === 'sidebar' ? 'sidebar' : 'bottom',
            },
            hint: undefined,
          },
        };
      }
      // Field 41: pre-refine countdown (cycle presets [0, 2, 3, 5, 8, 10])
      if (f === 41) {
        const j = PRE_REFINE_SECONDS_PRESETS.indexOf(sp.preRefineSeconds);
        const base = j < 0 ? 0 : j;
        const next =
          (base + action.delta + PRE_REFINE_SECONDS_PRESETS.length) %
          PRE_REFINE_SECONDS_PRESETS.length;
        return {
          ...state,
          settingsPicker: {
            ...sp,
            preRefineSeconds: expectDefined(PRE_REFINE_SECONDS_PRESETS[next]),
            hint: undefined,
          },
        };
      }
      // Field 42: readSymbols (boolean toggle)
      if (f === 42)
        return {
          ...state,
          settingsPicker: { ...sp, readSymbols: !sp.readSymbols, hint: undefined },
        };
      // Field 43: showSageMemoryInject (boolean toggle)
      if (f === 43)
        return {
          ...state,
          settingsPicker: {
            ...sp,
            showSageMemoryInject: !sp.showSageMemoryInject,
            hint: undefined,
          },
        };
      // Field 44: sageMemoryInjectThreshold (cycle SAGE_THRESHOLD_PRESETS)
      if (f === 44) {
        const j = SAGE_THRESHOLD_PRESETS.indexOf(sp.sageMemoryInjectThreshold);
        const base = j < 0 ? 0 : j;
        const next =
          (base + action.delta + SAGE_THRESHOLD_PRESETS.length) % SAGE_THRESHOLD_PRESETS.length;
        return {
          ...state,
          settingsPicker: {
            ...sp,
            sageMemoryInjectThreshold: expectDefined(SAGE_THRESHOLD_PRESETS[next]),
            hint: undefined,
          },
        };
      }
      // Field 45: nextStepsTool (boolean toggle)
      if (f === 45)
        return {
          ...state,
          settingsPicker: { ...sp, nextStepsTool: !sp.nextStepsTool, hint: undefined },
        };
      // Field 59: WrongProxy / WrongTrace master switch. Toggles on
      // left/right, mirroring the other boolean cycle entries above.
      // The companion URL field (60) is text — Enter opens an inline
      // edit, not a cycle, so it has no entry here.
      if (f === 59)
        return {
          ...state,
          settingsPicker: { ...sp, wrongProxyEnabled: !sp.wrongProxyEnabled, hint: undefined },
        };
      // Field 61: Right sidebar master switch (on/off).
      if (f === 61)
        return {
          ...state,
          settingsPicker: { ...sp, showSidebar: !sp.showSidebar, hint: undefined },
        };
      // Fields PANEL_POSITION_FIELD_START..PANEL_POSITION_FIELD_START+PANEL_IDS.length:
      // per-panel position (cycle 'bottom' → 'sidebar'). One field index
      // per PanelId, in PANEL_IDS order. The first 46 indices (0–45) are
      // preserved because jumps, persisted lastSettingsField, and several
      // tests rely on stable indices. The bounds check guarantees
      // PANEL_IDS[f - PANEL_POSITION_FIELD_START] is defined; the map is
      // normalized to a full PanelPositionMap at boot (see
      // coercePanelPositionMap in app-settings-type.ts) so the index
      // access on `sp.panelPositions` is also total. Using
      // PANEL_IDS.length (not a hardcoded 57) keeps the range in sync
      // when a new panel is added to PANEL_IDS.
      if (f >= PANEL_POSITION_FIELD_START && f - PANEL_POSITION_FIELD_START < PANEL_IDS.length) {
        const PANEL_POSITION_CYCLE = ['bottom', 'sidebar'] as const;
        const panelId = PANEL_IDS[f - PANEL_POSITION_FIELD_START]!;
        const current = sp.panelPositions[panelId];
        const j = PANEL_POSITION_CYCLE.indexOf(current);
        const base = j < 0 ? 0 : j;
        const next =
          PANEL_POSITION_CYCLE[
            (base + action.delta + PANEL_POSITION_CYCLE.length) % PANEL_POSITION_CYCLE.length
          ] ?? 'bottom';
        // When the fleet panel changes, derive showAgentSwarmPanel so the
        // two fields can't diverge: sidebar → 'sidebar', bottom → 'bottom'
        // (preserving 'off' if the user explicitly hid the swarm).
        const swarmSync =
          panelId === 'fleet'
            ? {
                showAgentSwarmPanel:
                  next === 'sidebar'
                    ? ('sidebar' as const)
                    : sp.showAgentSwarmPanel === 'off'
                      ? ('off' as const)
                      : ('bottom' as const),
              }
            : {};
        return {
          ...state,
          settingsPicker: {
            ...sp,
            panelPositions: { ...sp.panelPositions, [panelId]: next },
            ...swarmSync,
            hint: undefined,
          },
        };
      }
      return state;
    }
    case 'settingsValueSet': {
      // Direct value-set from the `/settings <chord> <value>` slash
      // command. The patch is already validated by
      // `resolveSettingsFieldValue` before dispatch, so the reducer just
      // spreads it and clears any stale hint.
      //
      // `panelPositions` is the one exception: callers (`resolveSettingsFieldValue`,
      // `buildResetPatch`) emit partial maps (single-key spreads) so unrelated
      // panels survive the slash command. The reducer deep-merges those
      // partials here rather than overwriting the whole map.
      //
      // When the merged result changes panelPositions.fleet AND the patch
      // does NOT explicitly set showAgentSwarmPanel, derive
      // showAgentSwarmPanel from it so the two fields can't diverge:
      //   fleet:'sidebar' → showAgentSwarmPanel:'sidebar'
      //   fleet:'bottom'  → showAgentSwarmPanel stays as-is (could be 'off')
      // An explicit showAgentSwarmPanel in the patch (e.g. resetSettingsFieldValue
      // for field 40) takes priority and is not overridden.
      const { panelPositions: panelPositionsPatch, showAgentSwarmPanel: swarmPatch, ...restPatch } =
        action.patch;
      const mergedPanelPositions =
        panelPositionsPatch !== undefined
          ? { ...state.settingsPicker.panelPositions, ...panelPositionsPatch }
          : state.settingsPicker.panelPositions;
      // Derive showAgentSwarmPanel from the merged fleet position ONLY
      // when the patch doesn't explicitly set it. Guard against undefined
      // fleet (merged map may not have it in edge cases like test fixtures).
      const fleetPos = (mergedPanelPositions as Record<string, unknown>)?.fleet;
      const derivedSwarmMode: import('../app-settings-type.js').AgentSwarmPanelMode =
        swarmPatch !== undefined
          ? swarmPatch
          : fleetPos === 'sidebar'
            ? 'sidebar'
            : state.settingsPicker.showAgentSwarmPanel === 'off'
              ? 'off'
              : 'bottom';
      return {
        ...state,
        settingsPicker: {
          ...state.settingsPicker,
          ...restPatch,
          ...(panelPositionsPatch !== undefined ? { panelPositions: mergedPanelPositions } : {}),
          showAgentSwarmPanel: derivedSwarmMode,
          hint: undefined,
        },
      };
    }
    case 'settingsHint':
      return { ...state, settingsPicker: { ...state.settingsPicker, hint: action.text } };
    case 'settingsThinkingEditStart':
      return {
        ...state,
        settingsPicker: {
          ...state.settingsPicker,
          thinkingWordEditing: true,
          // Seed the draft with the current word so the user edits from it.
          thinkingWordDraft: state.settingsPicker.thinkingWord,
          hint: undefined,
        },
      };
    case 'settingsThinkingEditChange':
      return {
        ...state,
        settingsPicker: {
          ...state.settingsPicker,
          // Hard-cap the draft so it can't grow past the persisted limit.
          thinkingWordDraft: action.draft.slice(0, MAX_TUI_THINKING_WORD_LENGTH),
          hint: undefined,
        },
      };
    case 'settingsThinkingEditCommit': {
      const sp = state.settingsPicker;
      const raw = sp.thinkingWordDraft.trim();
      // Empty draft = cancel (keep the current word). Otherwise validate: an
      // invalid word keeps the current value and surfaces a hint rather than
      // silently snapping to the default.
      if (raw.length === 0) {
        return {
          ...state,
          settingsPicker: {
            ...sp,
            thinkingWordEditing: false,
            thinkingWordDraft: '',
            hint: undefined,
          },
        };
      }
      const normalized = normalizeTuiThinkingWord(raw);
      const valid = normalized === raw; // normalize falls back to default on invalid input
      return {
        ...state,
        settingsPicker: {
          ...sp,
          thinkingWord: valid ? normalized : sp.thinkingWord,
          thinkingWordEditing: false,
          thinkingWordDraft: '',
          hint: valid
            ? undefined
            : `Invalid word — keep it ≤${MAX_TUI_THINKING_WORD_LENGTH} chars (letters/digits/_/-)`,
        },
      };
    }
    case 'settingsThinkingEditCancel':
      return {
        ...state,
        settingsPicker: {
          ...state.settingsPicker,
          thinkingWordEditing: false,
          thinkingWordDraft: '',
          hint: undefined,
        },
      };
    // WrongProxy URL (field 60) free-text edit quartet. Mirrors the
    // `settingsThinkingEdit*` shape: Enter on the row opens the edit
    // (seeding the draft with the current URL), Change caps the draft
    // (URLs don't have a strict length cap, but we cap to a sane 2 KiB
    // to prevent pathological input), Commit validates the scheme and
    // applies the new value, Cancel discards. Empty draft on commit
    // keeps the current URL (same semantics as the thinking-word edit).
    case 'settingsWrongProxyUrlEditStart':
      return {
        ...state,
        settingsPicker: {
          ...state.settingsPicker,
          wrongProxyUrlEditing: true,
          // Seed the draft with the current URL so the user edits from it.
          wrongProxyUrlDraft: state.settingsPicker.wrongProxyUrl,
          hint: undefined,
        },
      };
    case 'settingsWrongProxyUrlEditChange':
      return {
        ...state,
        settingsPicker: {
          ...state.settingsPicker,
          // Cap to a sane 2 KiB so a runaway paste can't bloat the slice.
          wrongProxyUrlDraft: action.draft.slice(0, MAX_WRONGPROXY_URL_LENGTH),
          hint: undefined,
        },
      };
    case 'settingsWrongProxyUrlEditCommit': {
      const sp = state.settingsPicker;
      const raw = sp.wrongProxyUrlDraft.trim();
      // Empty draft = cancel (keep the current URL).
      if (raw.length === 0) {
        return {
          ...state,
          settingsPicker: {
            ...sp,
            wrongProxyUrlEditing: false,
            wrongProxyUrlDraft: '',
            hint: undefined,
          },
        };
      }
      // Validate with full URL parsing — a prefix-only regex accepts
      // `http://host/path with space` (unanchored), which the runtime
      // probe would then treat as unreachable. `URL` rejects internal
      // whitespace and malformed hosts; scheme must still be http(s).
      let valid = false;
      try {
        const parsed = new URL(raw);
        valid = parsed.protocol === 'http:' || parsed.protocol === 'https:';
      } catch {
        valid = false;
      }
      return {
        ...state,
        settingsPicker: {
          ...sp,
          wrongProxyUrl: valid ? raw : sp.wrongProxyUrl,
          wrongProxyUrlEditing: false,
          wrongProxyUrlDraft: '',
          hint: valid
            ? undefined
            : 'Invalid URL — use http://host:port or https://host:port (no whitespace).',
        },
      };
    }
    case 'settingsWrongProxyUrlEditCancel':
      return {
        ...state,
        settingsPicker: {
          ...state.settingsPicker,
          wrongProxyUrlEditing: false,
          wrongProxyUrlDraft: '',
          hint: undefined,
        },
      };
    default:
      void (action satisfies never);
      return state;
  }
}
