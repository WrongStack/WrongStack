import type { State } from '../app-state.js';
import {
  cycleEffort,
  EFFORT_KEEP,
  effortOptionsForFocused,
} from '../components/model-picker-effort.js';
import { filterPromptPicker } from '../components/prompt-picker-model.js';
import { filterResourceMenuItems } from '../components/resource-menu-model.js';
import { getActiveThemeName, THEME_OPTIONS } from '../theme.js';
import { filterThemeOptions } from '../theme-picker-rows.js';

import * as h from './helpers.js';
export function reduceComposerPickers(state: State, action: ComposerAction): State {
  switch (action.type) {
    case 'modelPickerOpen': {
      const purpose = action.purpose ?? 'switch';
      return {
        ...state,
        // Generic 'pick' invocations are transient overlays ON TOP of the
        // calling panel (e.g. the Brain panel) — leave other panels open so
        // the caller is still there when the promise resolves.
        ...(purpose === 'pick' ? {} : h.closePanels(state)),
        modelPicker: {
          open: true,
          step: 'provider',
          providerOptions: action.providers,
          modelOptions: [],
          filteredOptions: [],
          selected: 0,
          hint: undefined,
          searchQuery: '',
          effort: EFFORT_KEEP,
          purpose,
          title: action.title,
        },
      };
    }
    case 'modelPickerClose':
      return {
        ...state,
        modelPicker: {
          open: false,
          step: 'provider',
          providerOptions: [],
          modelOptions: [],
          filteredOptions: [],
          selected: 0,
          searchQuery: '',
          effort: EFFORT_KEEP,
          purpose: 'switch',
          title: undefined,
        },
      };
    case 'modelPickerMove': {
      if (!state.modelPicker.open) return state;
      const list =
        state.modelPicker.step === 'provider'
          ? state.modelPicker.providerOptions
          : state.modelPicker.filteredOptions;
      const len = list.length;
      if (len === 0) return state;
      const next = (state.modelPicker.selected + action.delta + len) % len;
      return {
        ...state,
        // The effort choice belongs to the row it was made on: moving the
        // cursor must not carry "max" over to the next model, whose catalog
        // may not even document that level.
        modelPicker: { ...state.modelPicker, selected: next, effort: EFFORT_KEEP },
      };
    }
    case 'modelPickerPickProvider':
      return {
        ...state,
        modelPicker: {
          ...state.modelPicker,
          step: 'model',
          modelOptions: action.models,
          filteredOptions: action.models,
          selected: 0,
          pickedProviderId: action.providerId,
          hint: undefined,
          searchQuery: '',
          effort: EFFORT_KEEP,
        },
      };
    case 'modelPickerBack':
      return {
        ...state,
        modelPicker: {
          ...state.modelPicker,
          step: 'provider',
          modelOptions: [],
          filteredOptions: [],
          selected: 0,
          pickedProviderId: undefined,
          hint: undefined,
          searchQuery: '',
          effort: EFFORT_KEEP,
        },
      };
    case 'modelPickerSearch': {
      if (!state.modelPicker.open || state.modelPicker.step !== 'model') return state;
      const q = action.query.toLowerCase();
      const filtered = q
        ? state.modelPicker.modelOptions.filter((id) => id.toLowerCase().includes(q))
        : state.modelPicker.modelOptions;
      const selected =
        filtered.length > 0 ? Math.min(state.modelPicker.selected, filtered.length - 1) : 0;
      return {
        ...state,
        modelPicker: {
          ...state.modelPicker,
          filteredOptions: filtered,
          selected,
          searchQuery: action.query,
          effort: EFFORT_KEEP,
          hint: undefined,
        },
      };
    }
    case 'modelPickerEffort': {
      if (!state.modelPicker.open || state.modelPicker.step !== 'model') return state;
      const options = effortOptionsForFocused(state.modelPicker);
      // Non-reasoning model (or a 'pick' invocation): the strip is not shown,
      // so ←/→ are inert rather than silently arming a value Enter would save.
      if (options.length === 0) return state;
      return {
        ...state,
        modelPicker: {
          ...state.modelPicker,
          effort: cycleEffort(options, state.modelPicker.effort, action.delta),
          hint: undefined,
        },
      };
    }
    case 'modelPickerHint':
      return {
        ...state,
        modelPicker: { ...state.modelPicker, hint: action.text },
      };
    case 'autonomyPickerOpen':
      return {
        ...state,
        ...h.closePanels(state),
        autonomyPicker: { open: true, options: action.options, selected: 0, hint: undefined },
      };
    case 'autonomyPickerClose':
      return {
        ...state,
        autonomyPicker: { open: false, options: [], selected: 0 },
      };
    case 'autonomyPickerMove': {
      const n = state.autonomyPicker.options.length;
      if (n === 0) return state;
      const next = (state.autonomyPicker.selected + action.delta + n) % n;
      return {
        ...state,
        autonomyPicker: { ...state.autonomyPicker, selected: next },
      };
    }
    case 'autonomyPickerHint':
      return {
        ...state,
        autonomyPicker: { ...state.autonomyPicker, hint: action.text },
      };
    case 'themePickerOpen': {
      // Initial selection lands on the currently active theme so the user
      // sees which preset is in effect before they confirm. Caller can
      // override via `action.selected` (used by `/theme <preset>` to drop
      // the user on the matching row). Safe to read synchronously —
      // `theme.ts` is module-scoped state, not a hook.
      //
      // `previous` seeds the undo target: the preset in effect when the
      // picker opened, so `themePickerUndo` can swap back to it. It is
      // re-read on every open, so a second `/theme` always undoes to the
      // currently live palette rather than to a stale value.
      const fallback = Math.max(
        0,
        THEME_OPTIONS.findIndex((o) => o.id === getActiveThemeName()),
      );
      const selected = action.selected ?? fallback;
      return {
        ...state,
        ...h.closePanels(state),
        themePicker: {
          open: true,
          selected,
          hint: undefined,
          filter: '',
          filtering: false,
          previous: getActiveThemeName(),
        },
      };
    }
    case 'themePickerClose':
      return {
        ...state,
        themePicker: { open: false, selected: 0 },
      };
    case 'themePickerMove': {
      // `selected` indexes the FILTERED list, so a query that hides rows must
      // not let ↑↓ walk past the end of what is actually on screen.
      const visible = filterThemeOptions(THEME_OPTIONS, state.themePicker.filter ?? '');
      const n = visible.length;
      if (n === 0) return state;
      const next = (state.themePicker.selected + action.delta + n) % n;
      if (next === state.themePicker.selected) return state;
      return {
        ...state,
        themePicker: { ...state.themePicker, selected: next, hint: undefined },
      };
    }
    case 'themePickerHint':
      return {
        ...state,
        themePicker: { ...state.themePicker, hint: action.text },
      };
    case 'themePickerPreview':
      return {
        ...state,
        themePicker: {
          ...state.themePicker,
          preview: action.on,
          // Entering preview re-baselines `previous` to whatever is live RIGHT
          // NOW, so Esc restores the palette that was in effect when preview
          // began — not the one from when the picker was first opened.
          ...(action.on ? { previous: getActiveThemeName() } : {}),
        },
      };
    case 'themePickerFilterMode': {
      const currentFilter = state.themePicker.filter ?? '';
      let selected = state.themePicker.selected;
      if (!action.on && currentFilter) {
        const previousId = filterThemeOptions(THEME_OPTIONS, currentFilter)[selected]?.id;
        const retained = THEME_OPTIONS.findIndex((o) => o.id === previousId);
        selected = Math.max(retained, 0);
      }
      return {
        ...state,
        themePicker: {
          ...state.themePicker,
          filtering: action.on,
          // Leaving filter mode with `/` also drops the query, so the mode
          // flag and the visible list can never disagree about what is shown.
          filter: action.on ? state.themePicker.filter : '',
          selected,
        },
      };
    }
    case 'themePickerFilter': {
      // Keep the focused row pointing at the SAME preset across a query
      // change where possible: resolve the previously focused id against the
      // new filtered list, and only fall back to 0 when it was filtered out.
      // Without this, every keystroke would yank the cursor back to the top.
      const previousId = filterThemeOptions(THEME_OPTIONS, state.themePicker.filter ?? '')[
        state.themePicker.selected
      ]?.id;
      const visible = filterThemeOptions(THEME_OPTIONS, action.text);
      const retained = visible.findIndex((o) => o.id === previousId);
      return {
        ...state,
        themePicker: {
          ...state.themePicker,
          filter: action.text,
          selected: Math.max(retained, 0),
          hint: undefined,
        },
      };
    }
    case 'themePickerUndo':
      // The handler applies the swap (it owns setActiveTheme + persistence);
      // the reducer has no theme work to do here.
      return state;
    case 'themePickerSwapPrevious': {
      // After an undo the swap target becomes the palette we just left, so a
      // second press toggles back. Reuse `selected`'s row by looking up the
      // newly-active preset in the filtered list.
      const visible = filterThemeOptions(THEME_OPTIONS, state.themePicker.filter ?? '');
      const activeIndex = visible.findIndex((o) => o.id === getActiveThemeName());
      return {
        ...state,
        themePicker: {
          ...state.themePicker,
          previous: getActiveThemeName(),
          ...(activeIndex >= 0 ? { selected: activeIndex } : {}),
        },
      };
    }
    case 'modePickerOpen':
      return {
        ...state,
        ...h.closePanels(state),
        modePicker: { open: true, modes: action.modes, selected: 0, hint: undefined },
      };
    case 'modePickerClose':
      return {
        ...state,
        modePicker: { open: false, modes: [], selected: 0 },
      };
    case 'modePickerMove': {
      const n = state.modePicker.modes.length;
      if (n === 0) return state;
      const next = (state.modePicker.selected + action.delta + n) % n;
      return {
        ...state,
        modePicker: { ...state.modePicker, selected: next },
      };
    }
    case 'modePickerHint':
      return {
        ...state,
        modePicker: { ...state.modePicker, hint: action.text },
      };
    case 'skillPickerOpen':
      return {
        ...state,
        ...h.closePanels(state),
        skillPicker: {
          open: true,
          mention: action.mention,
          entries: action.entries,
          selected: 0,
          hint: undefined,
        },
      };
    case 'skillMentionResults': {
      const current = state.skillPicker.mention;
      if (
        !state.skillPicker.open ||
        !current ||
        current.start !== action.mention.start ||
        current.end !== action.mention.end ||
        current.query !== action.mention.query
      )
        return state;
      return {
        ...state,
        skillPicker: {
          ...state.skillPicker,
          entries: action.entries,
          selected: 0,
          hint: action.hint,
        },
      };
    }
    case 'skillPickerClose':
      return {
        ...state,
        skillPicker: {
          open: false,
          entries: [],
          selected: 0,
          hint: undefined,
        },
      };
    case 'skillPickerMove': {
      const n = state.skillPicker.entries.length;
      if (n === 0) return state;
      const next = (state.skillPicker.selected + action.delta + n) % n;
      return {
        ...state,
        skillPicker: { ...state.skillPicker, selected: next },
      };
    }
    case 'skillPickerHint':
      return {
        ...state,
        skillPicker: { ...state.skillPicker, hint: action.text },
      };
    case 'resourceMenuOpen':
      return {
        ...state,
        ...h.closePanels(state),
        resourceMenu: {
          open: true,
          snapshot: action.snapshot,
          selected: 0,
          filter: '',
          filtering: false,
          hint: undefined,
          pendingAction: undefined,
        },
      };
    case 'resourceMenuClose':
      return {
        ...state,
        resourceMenu: {
          open: false,
          snapshot: null,
          selected: 0,
          filter: '',
          filtering: false,
          hint: undefined,
          pendingAction: undefined,
        },
      };
    case 'resourceMenuMove': {
      const n = state.resourceMenu.snapshot
        ? filterResourceMenuItems(state.resourceMenu.snapshot, state.resourceMenu.filter).length
        : 0;
      if (n === 0) return state;
      const selected = (state.resourceMenu.selected + action.delta + n) % n;
      return {
        ...state,
        resourceMenu: {
          ...state.resourceMenu,
          selected,
          pendingAction: undefined,
          hint: undefined,
        },
      };
    }
    case 'resourceMenuHint':
      return { ...state, resourceMenu: { ...state.resourceMenu, hint: action.text } };
    case 'resourceMenuFilter':
      return {
        ...state,
        resourceMenu: {
          ...state.resourceMenu,
          filter: action.filter,
          filtering: action.active,
          selected: 0,
          pendingAction: undefined,
        },
      };
    case 'resourceMenuConfirm':
      return {
        ...state,
        resourceMenu: { ...state.resourceMenu, pendingAction: action.action, hint: undefined },
      };
    case 'designPickerOpen':
      return {
        ...state,
        ...h.closePanels(state),
        designPicker: {
          open: true,
          kits: action.kits,
          selected: 0,
          stack: state.designPicker.stack || 'web',
        },
      };
    case 'designPickerClose':
      return {
        ...state,
        designPicker: { ...state.designPicker, open: false },
      };
    case 'designPickerMove': {
      const n = state.designPicker.kits.length;
      if (n === 0) return state;
      const next = (state.designPicker.selected + action.delta + n) % n;
      return {
        ...state,
        designPicker: { ...state.designPicker, selected: next },
      };
    }
    case 'designPickerStack':
      return {
        ...state,
        designPicker: { ...state.designPicker, stack: action.stack },
      };
    case 'promptPickerOpen':
      return {
        ...state,
        ...h.closePanels(state),
        promptPicker: {
          open: true,
          all: action.all,
          categories: action.categories,
          recentSlugs: action.recentSlugs,
          catIndex: 0,
          selected: 0,
        },
      };
    case 'promptPickerClose':
      return {
        ...state,
        promptPicker: { ...state.promptPicker, open: false },
      };
    case 'promptPickerLevel':
      return { ...state, promptPicker: { ...state.promptPicker, level: action.level } };
    case 'promptPickerMove': {
      const filt = filterPromptPicker(
        state.promptPicker.all,
        state.promptPicker.categories,
        state.promptPicker.catIndex,
        state.promptPicker.recentSlugs,
      );
      const n = filt.length;
      if (n === 0) return state;
      const next = (state.promptPicker.selected + action.delta + n) % n;
      return { ...state, promptPicker: { ...state.promptPicker, selected: next } };
    }
    case 'promptPickerCategory': {
      const m = state.promptPicker.categories.length;
      if (m === 0) return state;
      const catIndex = (state.promptPicker.catIndex + action.delta + m) % m;
      return { ...state, promptPicker: { ...state.promptPicker, catIndex, selected: 0 } };
    }
  }
  return state;
}

import type { ComposerAction } from './composer-action-types.js';
