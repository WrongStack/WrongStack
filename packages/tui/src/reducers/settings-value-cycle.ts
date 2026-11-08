import { expectDefined } from '@wrongstack/core/utils';
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
  cycleToolResultViewMode,
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
  SYSTEM_PROMPT_CHOICES,
  THINKING_WORD_FIELD,
  THINKING_WORD_PRESETS,
  TOKEN_SAVING_TIERS,
} from '../components/settings-picker-model.js';
import { hasPanelRoutedToSidebar, PANEL_IDS, PANEL_POSITION_FIELD_START } from '../ui-contracts.js';
import { SIDEBAR_PINNED_HINT } from './settings-sidebar-hint.js';
import type { SettingsValueAction } from './settings-value-actions.js';
export function cycleSettingsValue(inputs: {
  action: SettingsValueAction;
  state: import('../app-state.js').State;
}): State {
  const { action, state } = inputs;
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
        const base = Math.max(i, 0);
        const next = (base + action.delta + SETTINGS_MODES.length) % SETTINGS_MODES.length;
        return {
          ...state,
          settingsPicker: { ...sp, mode: expectDefined(SETTINGS_MODES[next]), hint: undefined },
        };
      }
      // Field 1: delay presets
      if (f === 1) {
        const j = DELAY_PRESETS_MS.indexOf(sp.delayMs);
        const base = Math.max(j, 0);
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
        const base = Math.max(i, 0);
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
        const base = Math.max(i, 0);
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
        const base = Math.max(j, 0);
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
        const abase = Math.max(aj, 0);
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
        const ebase = Math.max(ej, 0);
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
        const base = Math.max(i, 0);
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
        const base = Math.max(j, 0);
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
        const base = Math.max(i, 0);
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
        const base = Math.max(i, 0);
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
      // Field 24: reasoning effort (cycle) — model-aware, WebUI parity. The
      // active model's documented vocabulary (host-injected at picker-open)
      // narrows the cycle; an undocumented model keeps the full canonical
      // set, and a persisted-but-unadvertised value is appended so it stays
      // reachable (the runtime resolver omits unsupported values).
      if (f === 24) {
        // Host gate contract (reasoningEffortVocabulary): undefined =
        // undocumented reasoner (full canonical set); [] = the model
        // documents effortSupported === false — no effort control at all. The
        // runtime resolver drops any effort for it, so cycling would persist
        // a dead value: leave the field inert (the picker's detail line says
        // so — see settings-picker.tsx).
        if (sp.reasoningEffortLevels !== undefined && sp.reasoningEffortLevels.length === 0) {
          return state;
        }
        const documented = (sp.reasoningEffortLevels ?? []).filter(
          (level): level is (typeof REASONING_EFFORTS)[number] =>
            REASONING_EFFORTS.some((candidate) => candidate === level),
        );
        const cycle =
          documented.length > 0
            ? REASONING_EFFORTS.filter(
                (level) => documented.includes(level) || level === sp.reasoningEffort,
              )
            : [...REASONING_EFFORTS];
        const base = Math.max(0, cycle.indexOf(sp.reasoningEffort));
        const next = (base + action.delta + cycle.length) % cycle.length;
        return {
          ...state,
          settingsPicker: {
            ...sp,
            reasoningEffort: expectDefined(cycle[next]),
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
        const base = Math.max(i, 0);
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
        const base = Math.max(i, 0);
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
        const base = Math.max(i, 0);
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
        const base = Math.max(j, 0);
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
        const base = Math.max(i, 0);
        const next = (base + action.delta + LOG_LEVELS.length) % LOG_LEVELS.length;
        return {
          ...state,
          settingsPicker: { ...sp, logLevel: expectDefined(LOG_LEVELS[next]), hint: undefined },
        };
      }
      // Field 32: audit level (cycle)
      if (f === 32) {
        const i = AUDIT_LEVELS.indexOf(sp.auditLevel);
        const base = Math.max(i, 0);
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
        const base = Math.max(i, 0);
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
        const base = Math.max(i, 0);
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
        const base = Math.max(j, 0);
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
        const base = Math.max(j, 0);
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
        const base = Math.max(j, 0);
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
        const base = Math.max(j, 0);
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
      // Field 60 is text-edited rather than cycled here.
      if (f === 59)
        return {
          ...state,
          settingsPicker: { ...sp, wrongProxyEnabled: !sp.wrongProxyEnabled, hint: undefined },
        };
      if (f === 61) {
        // Pin rule: at least one F-key panel is routed to the sidebar (read
        // from the picker draft, which is seeded from the persisted config
        // at open and tracks the user's in-flight routing edits), so the
        // sidebar can't be switched off. Force it on and say why rather
        // than silently ignoring the press.
        if (hasPanelRoutedToSidebar(sp.panelPositions, sp.showAgentSwarmPanel === 'sidebar')) {
          return {
            ...state,
            settingsPicker: { ...sp, showSidebar: true, hint: SIDEBAR_PINNED_HINT },
          };
        }
        return {
          ...state,
          settingsPicker: { ...sp, showSidebar: !sp.showSidebar, hint: undefined },
        };
      }
      if (f === 62)
        return {
          ...state,
          toolResultViewOverrides: new Map(),
          settingsPicker: {
            ...sp,
            toolResultViewMode: cycleToolResultViewMode(sp.toolResultViewMode, action.delta),
            hint: undefined,
          },
        };
      if (f === 67)
        return {
          ...state,
          settingsPicker: {
            ...sp,
            selectionMode: sp.selectionMode === 'text' ? 'block' : 'text',
            hint: undefined,
          },
        };
      if (f === 63)
        return {
          ...state,
          settingsPicker: { ...sp, featureToolCoach: !sp.featureToolCoach, hint: undefined },
        };
      // Field 64: required next steps (boolean toggle over `autonomy.nextSteps`)
      if (f === 64)
        return {
          ...state,
          settingsPicker: { ...sp, nextStepsRequired: !sp.nextStepsRequired, hint: undefined },
        };
      // Field 65: reuse last startup choices (model / system prompt / launch mode)
      if (f === 65)
        return {
          ...state,
          settingsPicker: {
            ...sp,
            rememberStartupChoices: !sp.rememberStartupChoices,
            hint: bootHint,
          },
        };
      // Field 66: system prompt for the NEXT session — the running session
      // keeps the prompt (and tool surface) it was built with.
      if (f === 66) {
        const i = SYSTEM_PROMPT_CHOICES.indexOf(sp.nextSystemPromptVariant);
        const base = Math.max(i, 0);
        const next =
          SYSTEM_PROMPT_CHOICES[
            (base + action.delta + SYSTEM_PROMPT_CHOICES.length) % SYSTEM_PROMPT_CHOICES.length
          ] ?? 'pro';
        return {
          ...state,
          settingsPicker: { ...sp, nextSystemPromptVariant: next, hint: bootHint },
        };
      }
      // Field 68: include the user-scope AGENTS.md in the system prompt
      // (`systemPrompt.includeGlobalAgents`) — applies from the next build.
      if (f === 68)
        return {
          ...state,
          settingsPicker: { ...sp, includeGlobalAgents: !sp.includeGlobalAgents, hint: bootHint },
        };
      // Field 69: the project's root AGENTS.md (`systemPrompt.includeProjectAgents`).
      if (f === 69)
        return {
          ...state,
          settingsPicker: { ...sp, includeProjectAgents: !sp.includeProjectAgents, hint: bootHint },
        };
      if (f >= PANEL_POSITION_FIELD_START && f - PANEL_POSITION_FIELD_START < PANEL_IDS.length) {
        const PANEL_POSITION_CYCLE = ['bottom', 'sidebar'] as const;
        const panelId = PANEL_IDS[f - PANEL_POSITION_FIELD_START]!;
        const current = sp.panelPositions[panelId];
        const j = PANEL_POSITION_CYCLE.indexOf(current);
        const base = Math.max(j, 0);
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
  }
  throw new Error('Unhandled delegated case');
}
