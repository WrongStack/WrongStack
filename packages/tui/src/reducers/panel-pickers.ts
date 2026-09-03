import type { Action } from '../app-action-type.js';
import type { State } from '../app-state.js';
import { brainPanelRows } from '../brain-panel-model.js';
import {
  clampLine,
  effectiveDensity,
  effectiveLine,
  LINE_TITLES,
  STATUSLINE_ITEMS,
} from '@wrongstack/core/statusline';
import {
  type ChipMeta,
  navigableFields,
  nextDensity,
  STATUSLINE_FIELD_COUNT,
} from '../components/statusline-picker.js';
import { closePanels } from './helpers.js';

const panelPickerActionTypes = [
  'statuslineOpen',
  'statuslineClose',
  'statuslineFieldMove',
  'statuslineFieldSet',
  'statuslineToggle',
  'statuslineSetLine',
  'statuslineMoveLine',
  'statuslineSetDensity',
  'statuslineToggleLine',
  'statuslineResetLayout',
  'statuslineFilter',
  'statuslineHint',
  'statuslineChipShow',
  'statuslineChipExpire',
  'statuslineVisibleChipsSync',
  'pluginPickerOpen',
  'pluginPickerClose',
  'pluginPickerMove',
  'pluginPickerSetItems',
  'pluginPickerBusy',
  'pluginPickerHint',
  'mcpPickerOpen',
  'mcpPickerClose',
  'mcpPickerMove',
  'mcpPickerSetItems',
  'mcpPickerBusy',
  'mcpPickerHint',
  'toolsPickerOpen',
  'toolsPickerClose',
  'toolsPickerMove',
  'toolsPickerSetItems',
  'toolsPickerToggle',
  'toolsPickerBusy',
  'toolsPickerHint',
  'toolsPickerFilter',
  'brainOpen',
  'brainClose',
  'brainMove',
  'brainRiskChange',
  'brainSetLog',
  'brainHint',
  'brainSettingsLoaded',
  'brainView',
  'brainRowMove',
  'brainBusy',
  'helpOpen',
  'helpClose',
  'helpMove',
  'helpFilter',
  'helpHint',
  'shadowOpen',
  'shadowClose',
  'shadowUpdate',
  'shadowHint',
] as const satisfies readonly Action['type'][];

type PanelPickerAction = Extract<Action, { type: (typeof panelPickerActionTypes)[number] }>;
const panelPickerActionTypeSet = new Set<string>(panelPickerActionTypes);

export function isPanelPickerAction(action: Action): action is PanelPickerAction {
  return panelPickerActionTypeSet.has(action.type);
}

/** Reduces statusline, extension, brain, help, and shadow picker panels. */
export function reducePanelPickers(state: State, action: PanelPickerAction): State {
  switch (action.type) {
    // ── Statusline picker ───────────────────────────────────────────────
    case 'statuslineOpen':
      return {
        ...state,
        ...closePanels(state),
        statuslinePicker: {
          open: true,
          field: 0,
          hiddenItems: action.hiddenItems,
          visibleChips: state.statuslinePicker.visibleChips,
          lines: action.lines ?? state.statuslinePicker.lines,
          densities: action.densities ?? state.statuslinePicker.densities,
          filter: '',
          filtering: false,
          layoutSeeded: action.lines != null || action.densities != null,
          hint: undefined,
        },
      };
    case 'statuslineClose':
      return {
        ...state,
        statuslinePicker: { ...state.statuslinePicker, open: false, hint: undefined },
      };
    case 'statuslineFieldMove': {
      // Navigation walks the FILTERED fields so `/cost` + ↓ doesn't stall on
      // rows the picker isn't drawing. With no filter this is the plain
      // wrap-around over STATUSLINE_ITEMS the mouse hit-test assumes.
      const fields = navigableFields(state.statuslinePicker.filter);
      const at = fields.indexOf(state.statuslinePicker.field);
      const from = at >= 0 ? at : 0;
      const next = fields[(from + action.delta + fields.length) % fields.length]!;
      return {
        ...state,
        statuslinePicker: { ...state.statuslinePicker, field: next, hint: undefined },
      };
    }
    case 'statuslineFieldSet': {
      const totalFields = STATUSLINE_FIELD_COUNT;
      const field = action.field >= 0 && action.field < totalFields ? action.field : 0;
      return { ...state, statuslinePicker: { ...state.statuslinePicker, field, hint: undefined } };
    }
    case 'statuslineToggle': {
      const cur = state.statuslinePicker;
      const hiddenSet = new Set(cur.hiddenItems);
      if (hiddenSet.has(action.item)) {
        hiddenSet.delete(action.item);
      } else {
        hiddenSet.add(action.item);
      }
      return {
        ...state,
        statuslinePicker: { ...cur, hiddenItems: [...hiddenSet] as typeof cur.hiddenItems },
      };
    }
    case 'statuslineSetLine': {
      const cur = state.statuslinePicker;
      // Report the CLAMPED line: a raw out-of-range value would otherwise
      // store 4 while telling the user it went to 9.
      const line = clampLine(action.line);
      return {
        ...state,
        statuslinePicker: {
          ...cur,
          lines: { ...cur.lines, [action.item]: line },
          layoutSeeded: true,
          hint: `${action.item} → line ${line} (${LINE_TITLES[line]})`,
        },
      };
    }
    case 'statuslineMoveLine': {
      const cur = state.statuslinePicker;
      const current = effectiveLine(action.item, cur.lines);
      // Wrap within 1-4 so `[` on line 1 lands on line 4 rather than sticking.
      const next = clampLine(((current - 1 + action.delta + 4) % 4) + 1);
      return {
        ...state,
        statuslinePicker: {
          ...cur,
          lines: { ...cur.lines, [action.item]: next },
          layoutSeeded: true,
          hint: `${action.item} → line ${next} (${LINE_TITLES[next]})`,
        },
      };
    }
    case 'statuslineSetDensity': {
      const cur = state.statuslinePicker;
      const current = effectiveDensity(action.item, cur.densities);
      const next = action.density ?? nextDensity(current);
      const densities = { ...cur.densities };
      // 'auto' is the absence of a pin, so it is deleted rather than stored —
      // the persisted document stays sparse.
      if (next === 'auto') delete densities[action.item];
      else densities[action.item] = next;
      return {
        ...state,
        statuslinePicker: {
          ...cur,
          densities,
          layoutSeeded: true,
          hint: `${action.item} density: ${next}`,
        },
      };
    }
    case 'statuslineToggleLine': {
      const cur = state.statuslinePicker;
      const onLine = STATUSLINE_ITEMS.filter(
        (item) => effectiveLine(item, cur.lines) === action.line,
      );
      const hiddenSet = new Set(cur.hiddenItems);
      const anyVisible = onLine.some((item) => !hiddenSet.has(item));
      for (const item of onLine) {
        if (anyVisible) hiddenSet.add(item);
        else hiddenSet.delete(item);
      }
      return {
        ...state,
        statuslinePicker: {
          ...cur,
          hiddenItems: [...hiddenSet] as typeof cur.hiddenItems,
          hint: `line ${action.line}: ${anyVisible ? 'all off' : 'all on'}`,
        },
      };
    }
    case 'statuslineResetLayout':
      return {
        ...state,
        statuslinePicker: {
          ...state.statuslinePicker,
          lines: {},
          densities: {},
          layoutSeeded: true,
          hint: 'layout reset — default lines and densities restored',
        },
      };
    case 'statuslineFilter': {
      const cur = state.statuslinePicker;
      const filter = action.text ?? cur.filter;
      const filtering = action.filtering ?? cur.filtering;
      // Keep the selection on a row that survives the new filter, so the
      // list never shows a highlight the user cannot see.
      const fields = navigableFields(filter);
      const field = fields.includes(cur.field) ? cur.field : (fields[0] ?? 0);
      return {
        ...state,
        statuslinePicker: { ...cur, filter, filtering, field, hint: undefined },
      };
    }
    case 'statuslineHint':
      return { ...state, statuslinePicker: { ...state.statuslinePicker, hint: action.text } };
    case 'statuslineChipShow': {
      const cur = state.statuslinePicker;
      const existing = cur.visibleChips.findIndex((c) => c.key === action.key);
      // Only include expiresIn if it is explicitly set — with exactOptionalPropertyTypes,
      // assigning undefined to an optional property is a type error.
      const meta: ChipMeta =
        action.expiresIn != null
          ? { key: action.key, shownAt: Date.now(), expiresIn: action.expiresIn }
          : { key: action.key, shownAt: Date.now() };
      if (existing >= 0) {
        // Reset shownAt if already visible
        const updated = [...cur.visibleChips];
        updated[existing] = meta;
        return { ...state, statuslinePicker: { ...cur, visibleChips: updated } };
      }
      return { ...state, statuslinePicker: { ...cur, visibleChips: [...cur.visibleChips, meta] } };
    }
    case 'statuslineChipExpire': {
      const cur = state.statuslinePicker;
      return {
        ...state,
        statuslinePicker: {
          ...cur,
          visibleChips: cur.visibleChips.filter((c) => c.key !== action.key),
        },
      };
    }
    case 'statuslineVisibleChipsSync':
      return {
        ...state,
        statuslinePicker: { ...state.statuslinePicker, visibleChips: action.visibleChips },
      };
    case 'pluginPickerOpen': {
      const items = action.items ?? state.pluginPicker.items;
      return {
        ...state,
        ...closePanels(state),
        pluginPicker: {
          open: true,
          items,
          selected: Math.min(state.pluginPicker.selected, Math.max(0, items.length - 1)),
          busy: items.length === 0,
          hint: undefined,
        },
      };
    }
    case 'pluginPickerClose':
      return { ...state, pluginPicker: { ...state.pluginPicker, open: false, busy: false } };
    case 'pluginPickerMove': {
      const count = state.pluginPicker.items.length;
      if (count === 0) return state;
      return {
        ...state,
        pluginPicker: {
          ...state.pluginPicker,
          selected: (state.pluginPicker.selected + action.delta + count) % count,
          hint: undefined,
        },
      };
    }
    case 'pluginPickerSetItems':
      return {
        ...state,
        pluginPicker: {
          ...state.pluginPicker,
          items: action.items,
          selected: Math.min(state.pluginPicker.selected, Math.max(0, action.items.length - 1)),
          busy: false,
        },
      };
    case 'pluginPickerBusy':
      return { ...state, pluginPicker: { ...state.pluginPicker, busy: action.busy } };
    case 'pluginPickerHint':
      return { ...state, pluginPicker: { ...state.pluginPicker, hint: action.text } };
    case 'mcpPickerOpen': {
      const items = action.items ?? state.mcpPicker.items;
      return {
        ...state,
        ...closePanels(state),
        mcpPicker: {
          open: true,
          items,
          selected: Math.min(state.mcpPicker.selected, Math.max(0, items.length - 1)),
          busy: items.length === 0,
          hint: undefined,
        },
      };
    }
    case 'mcpPickerClose':
      return { ...state, mcpPicker: { ...state.mcpPicker, open: false, busy: false } };
    case 'mcpPickerMove': {
      const count = state.mcpPicker.items.length;
      if (count === 0) return state;
      return {
        ...state,
        mcpPicker: {
          ...state.mcpPicker,
          selected: (state.mcpPicker.selected + action.delta + count) % count,
          hint: undefined,
        },
      };
    }
    case 'mcpPickerSetItems':
      return {
        ...state,
        mcpPicker: {
          ...state.mcpPicker,
          items: action.items,
          selected: Math.min(state.mcpPicker.selected, Math.max(0, action.items.length - 1)),
          busy: false,
        },
      };
    case 'mcpPickerBusy':
      return { ...state, mcpPicker: { ...state.mcpPicker, busy: action.busy } };
    case 'mcpPickerHint':
      return { ...state, mcpPicker: { ...state.mcpPicker, hint: action.text } };
    case 'toolsPickerOpen': {
      const items = action.items ?? state.toolsPicker.items;
      return {
        ...state,
        ...closePanels(state),
        toolsPicker: {
          open: true,
          items,
          selected: Math.min(state.toolsPicker.selected, Math.max(0, items.length - 1)),
          busy: items.length === 0,
          hint: undefined,
          filter: undefined,
        },
      };
    }
    case 'toolsPickerClose':
      return {
        ...state,
        toolsPicker: { ...state.toolsPicker, open: false, busy: false, filter: undefined },
      };
    case 'toolsPickerMove': {
      const count = state.toolsPicker.items.length;
      if (count === 0) return state;
      return {
        ...state,
        toolsPicker: {
          ...state.toolsPicker,
          selected: (state.toolsPicker.selected + action.delta + count) % count,
          hint: undefined,
        },
      };
    }
    case 'toolsPickerSetItems':
      return {
        ...state,
        toolsPicker: {
          ...state.toolsPicker,
          items: action.items,
          selected: Math.min(state.toolsPicker.selected, Math.max(0, action.items.length - 1)),
          busy: false,
        },
      };
    case 'toolsPickerToggle':
      // The toggle is handled by the host callback; this case just
      // prevents the reducer from crashing on the action type.
      return state;
    case 'toolsPickerBusy':
      return { ...state, toolsPicker: { ...state.toolsPicker, busy: action.busy } };
    case 'toolsPickerHint':
      return { ...state, toolsPicker: { ...state.toolsPicker, hint: action.text } };
    case 'toolsPickerFilter':
      return { ...state, toolsPicker: { ...state.toolsPicker, filter: action.filter } };
    case 'brainOpen': {
      return {
        ...state,
        ...closePanels(state),
        brainPanel: {
          open: true,
          riskLevel: action.riskLevel,
          log: action.log,
          selected: 0,
          hint: undefined,
          // With a settings snapshot the panel opens in editor view;
          // without one it falls back to the legacy risk+log view.
          view: action.settings ? 'settings' : 'log',
          settings: action.settings,
          row: 0,
          busy: false,
        },
      };
    }
    case 'brainClose':
      return { ...state, brainPanel: { ...state.brainPanel, open: false, busy: false } };
    case 'brainMove': {
      const count = state.brainPanel.log.length;
      if (count === 0) return state;
      return {
        ...state,
        brainPanel: {
          ...state.brainPanel,
          selected: (state.brainPanel.selected + action.delta + count) % count,
          hint: undefined,
        },
      };
    }
    case 'brainRiskChange': {
      const levels = ['off', 'low', 'medium', 'high', 'all'] as const;
      const cur = levels.indexOf(state.brainPanel.riskLevel as (typeof levels)[number]);
      const next = (cur + action.delta + levels.length) % levels.length;
      return {
        ...state,
        brainPanel: {
          ...state.brainPanel,
          riskLevel: levels[next] as typeof state.brainPanel.riskLevel,
        },
      };
    }
    case 'brainSetLog':
      return {
        ...state,
        brainPanel: {
          ...state.brainPanel,
          log: action.log,
          selected: Math.min(state.brainPanel.selected, Math.max(0, action.log.length - 1)),
        },
      };
    case 'brainHint':
      return { ...state, brainPanel: { ...state.brainPanel, hint: action.text } };
    case 'brainSettingsLoaded': {
      const rows = brainPanelRows(action.settings);
      return {
        ...state,
        brainPanel: {
          ...state.brainPanel,
          settings: action.settings,
          riskLevel: action.settings.riskLevel,
          row: Math.min(state.brainPanel.row, Math.max(0, rows.length - 1)),
          busy: false,
        },
      };
    }
    case 'brainView':
      return {
        ...state,
        brainPanel: { ...state.brainPanel, view: action.view, hint: undefined },
      };
    case 'brainRowMove': {
      const settings = state.brainPanel.settings;
      if (!settings) return state;
      const count = brainPanelRows(settings).length;
      if (count === 0) return state;
      return {
        ...state,
        brainPanel: {
          ...state.brainPanel,
          row: (state.brainPanel.row + action.delta + count) % count,
          hint: undefined,
        },
      };
    }
    case 'brainBusy':
      return { ...state, brainPanel: { ...state.brainPanel, busy: action.busy } };
    case 'helpOpen':
      return {
        ...state,
        ...closePanels(state),
        helpPanel: {
          open: true,
          entries: action.entries,
          selected: 0,
          filter: '',
          hint: undefined,
        },
      };
    case 'helpClose':
      return { ...state, helpPanel: { ...state.helpPanel, open: false, filter: '' } };
    case 'helpMove': {
      const count = state.helpPanel.entries.length;
      if (count === 0) return state;
      return {
        ...state,
        helpPanel: {
          ...state.helpPanel,
          selected: (state.helpPanel.selected + action.delta + count) % count,
          hint: undefined,
        },
      };
    }
    case 'helpFilter':
      return { ...state, helpPanel: { ...state.helpPanel, filter: action.filter, selected: 0 } };
    case 'helpHint':
      return { ...state, helpPanel: { ...state.helpPanel, hint: action.text } };
    case 'shadowOpen':
      return {
        ...state,
        ...closePanels(state),
        shadowPanel: { open: true, shadow: action.shadow, hint: undefined },
      };
    case 'shadowClose':
      return { ...state, shadowPanel: { ...state.shadowPanel, open: false } };
    case 'shadowUpdate':
      return { ...state, shadowPanel: { ...state.shadowPanel, shadow: action.shadow } };
    case 'shadowHint':
      return { ...state, shadowPanel: { ...state.shadowPanel, hint: action.text } };
    default:
      void (action satisfies never);
      return state;
  }
}
