import { MAX_WRONGPROXY_URL_LENGTH } from '@wrongstack/contracts/types';
import type { State } from '../app-state.js';
import { MAX_TUI_THINKING_WORD_LENGTH, normalizeTuiThinkingWord } from '../thinking-word.js';
import { hasPanelRoutedToSidebar } from '../ui-contracts.js';
import { SIDEBAR_PINNED_HINT } from './settings-sidebar-hint.js';
import type { SettingsValueAction } from './settings-value-actions.js';
import { cycleSettingsValue } from './settings-value-cycle.js';

export { isSettingsValueAction } from './settings-value-actions.js';

/** Reduces validated settings values and thinking-word editing. */
export function reduceSettingsValues(state: State, action: SettingsValueAction): State {
  switch (action.type) {
    case 'settingsValueChange':
      return cycleSettingsValue({ action, state });

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
      const {
        panelPositions: panelPositionsPatch,
        showAgentSwarmPanel: swarmPatch,
        showSidebar: showSidebarPatch,
        ...restPatch
      } = action.patch;
      const resetToolViews = action.patch.toolResultViewMode !== undefined;
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
      // Pin rule (mirrors field 61 + the render-side clamp in
      // `app-ui-state.ts#resolveSidebarLayout`): a `showSidebar: false`
      // patch is clamped to on while any panel still routes to the sidebar
      // — `/settings sidebar off` is refused this way, and the refusal is
      // surfaced as a picker hint rather than a silent no-op. Turning the
      // sidebar ON (or patches that don't touch it) is never blocked.
      const mergedShowSidebar = showSidebarPatch ?? state.settingsPicker.showSidebar;
      const sidebarPinnedByPatch = hasPanelRoutedToSidebar(
        mergedPanelPositions,
        derivedSwarmMode === 'sidebar',
      );
      const blockedSidebarOff = mergedShowSidebar === false && sidebarPinnedByPatch;
      return {
        ...state,
        ...(resetToolViews ? { toolResultViewOverrides: new Map<number, never>() } : {}),
        settingsPicker: {
          ...state.settingsPicker,
          ...restPatch,
          ...(panelPositionsPatch !== undefined ? { panelPositions: mergedPanelPositions } : {}),
          showAgentSwarmPanel: derivedSwarmMode,
          showSidebar: blockedSidebarOff ? true : mergedShowSidebar,
          hint: blockedSidebarOff ? SIDEBAR_PINNED_HINT : undefined,
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
