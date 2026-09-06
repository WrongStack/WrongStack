import type { Action } from '../app-action-type.js';
import type { State } from '../app-state.js';
import {
  AUTH_PANEL_INITIAL,
  type AuthPanelState,
  authMoveSelected,
  authPanelRows,
} from '../auth-panel-model.js';
import { nextSendModeIndex, SEND_MODE_OPTIONS } from '../components/send-mode-picker.js';
import { F_KEY_PANEL_ENTRIES } from '../f-key-panels.js';
import { closePanels, firstSelectable, skipDivider } from './helpers.js';

const dialogActionTypes = [
  'authOpen',
  'authClose',
  'authProviders',
  'authCatalog',
  'authView',
  'authMove',
  'authBusy',
  'authHint',
  'authFilter',
  'authFlowStart',
  'authFlowLog',
  'authFlowDone',
  'authPromptStart',
  'authPromptChange',
  'authPromptEnd',
  'authConfirmStart',
  'authConfirmEnd',
  'projectPickerOpen',
  'projectPickerClose',
  'projectPickerMove',
  'projectPickerFilter',
  'projectPickerHint',
  'fKeyPickerOpen',
  'fKeyPickerClose',
  'fKeyPickerMove',
  'confirmOpen',
  'confirmClose',
  'confirmClearAll',
  'shellCommandWarningOpen',
  'shellCommandWarningClose',
  'enhanceOpen',
  'enhanceClose',
  'enhanceSet',
  'enhanceBusy',
  'topicCheckBusy',
  'refineCountdownOpen',
  'refineCountdownClose',
  'refineFailureOpen',
  'refineFailureClose',
  'continueConfirmOpen',
  'continueConfirmClose',
  'bugHuntContinueOpen',
  'bugHuntContinueClose',
  'bugHuntRunningOpen',
  'bugHuntRunningClose',
  'clearConfirmOpen',
  'clearConfirmSetValue',
  'clearConfirmClose',
  'exitConfirmOpen',
  'exitConfirmClose',
  'slashConfirmOpen',
  'slashConfirmClose',
  'escConfirmOpen',
  'escConfirmClose',
  'fallbackOverlayOpen',
  'fallbackOverlayMove',
  'fallbackOverlayClose',
  'sendModePickerOpen',
  'sendModePickerMove',
  'sendModePickerClose',
  'resetContextChip',
] as const satisfies readonly Action['type'][];

type DialogAction = Extract<Action, { type: (typeof dialogActionTypes)[number] }>;
const dialogActionTypeSet = new Set<string>(dialogActionTypes);

export function isDialogAction(action: Action): action is DialogAction {
  return dialogActionTypeSet.has(action.type);
}

function clampAuthSelected(panel: AuthPanelState): number {
  const count = authPanelRows(panel).length;
  if (count === 0) return 0;
  return Math.min(panel.selected, count - 1);
}

/** Reduces authentication, project selection, confirmation, and run dialogs. */
export function reduceDialogs(state: State, action: DialogAction): State {
  switch (action.type) {
    case 'authOpen':
      return {
        ...state,
        ...closePanels(state),
        authPanel: {
          ...AUTH_PANEL_INITIAL,
          open: true,
          view: action.view ?? 'list',
          providers: action.providers ?? state.authPanel.providers,
          presets: action.presets ?? state.authPanel.presets,
          catalog: state.authPanel.catalog,
          busy: action.providers === undefined,
        },
      };
    case 'authClose':
      return { ...state, authPanel: { ...state.authPanel, open: false, busy: false } };
    case 'authProviders': {
      const next = { ...state.authPanel, providers: action.providers, busy: false };
      return { ...state, authPanel: { ...next, selected: clampAuthSelected(next) } };
    }
    case 'authCatalog': {
      const next = { ...state.authPanel, catalog: action.catalog, busy: false };
      return { ...state, authPanel: { ...next, selected: clampAuthSelected(next) } };
    }
    case 'authView':
      return {
        ...state,
        authPanel: {
          ...state.authPanel,
          view: action.view,
          providerId: action.providerId ?? state.authPanel.providerId,
          selected: 0,
          filter: '',
          hint: undefined,
        },
      };
    case 'authMove':
      return {
        ...state,
        authPanel: {
          ...state.authPanel,
          selected: authMoveSelected(state.authPanel, action.delta),
          hint: undefined,
        },
      };
    case 'authBusy':
      return { ...state, authPanel: { ...state.authPanel, busy: action.busy } };
    case 'authHint':
      return { ...state, authPanel: { ...state.authPanel, hint: action.text } };
    case 'authFilter':
      return { ...state, authPanel: { ...state.authPanel, filter: action.filter, selected: 0 } };
    case 'authFlowStart':
      return {
        ...state,
        authPanel: {
          ...state.authPanel,
          view: 'flow',
          flowTitle: action.title,
          log: [],
          flowDone: false,
          flowOk: undefined,
          busy: true,
          hint: undefined,
        },
      };
    case 'authFlowLog': {
      const log = [...state.authPanel.log, action.line].slice(-200);
      return { ...state, authPanel: { ...state.authPanel, log } };
    }
    case 'authFlowDone': {
      const log = action.message
        ? [...state.authPanel.log, action.message].slice(-200)
        : state.authPanel.log;
      return {
        ...state,
        authPanel: {
          ...state.authPanel,
          flowDone: true,
          flowOk: action.ok,
          busy: false,
          log,
          input: undefined,
        },
      };
    }
    case 'authPromptStart':
      return {
        ...state,
        authPanel: {
          ...state.authPanel,
          input: { label: action.label, masked: action.masked, draft: '' },
        },
      };
    case 'authPromptChange':
      return state.authPanel.input
        ? {
            ...state,
            authPanel: {
              ...state.authPanel,
              input: { ...state.authPanel.input, draft: action.draft },
            },
          }
        : state;
    case 'authPromptEnd':
      return { ...state, authPanel: { ...state.authPanel, input: undefined } };
    case 'authConfirmStart':
      return {
        ...state,
        authPanel: {
          ...state.authPanel,
          confirm: { question: action.question, action: action.action },
        },
      };
    case 'authConfirmEnd':
      return { ...state, authPanel: { ...state.authPanel, confirm: undefined } };
    case 'projectPickerOpen':
      return {
        ...state,
        ...closePanels(state),
        projectPicker: {
          open: true,
          allItems: action.items,
          items: action.items,
          selected: firstSelectable(action.items),
          filter: '',
          hint: undefined,
        },
      };
    case 'projectPickerClose':
      return {
        ...state,
        projectPicker: {
          open: false,
          allItems: [],
          items: [],
          selected: 0,
          filter: '',
          hint: undefined,
        },
      };
    case 'projectPickerMove': {
      const cur = state.projectPicker;
      if (cur.items.length === 0) return state;
      const nextRaw = (cur.selected + action.delta + cur.items.length) % cur.items.length;
      const next = skipDivider(cur.items, nextRaw, action.delta > 0 ? 1 : -1);
      return { ...state, projectPicker: { ...cur, selected: next } };
    }
    case 'projectPickerFilter': {
      const cur = state.projectPicker;
      const filtered = action.filter
        ? cur.allItems.filter(
            (item) =>
              item.kind !== 'project' ||
              item.label.toLowerCase().includes(action.filter.toLowerCase()) ||
              (item.subtitle ?? '').toLowerCase().includes(action.filter.toLowerCase()),
          )
        : cur.allItems;
      return {
        ...state,
        projectPicker: {
          ...cur,
          filter: action.filter,
          items: filtered,
          selected: firstSelectable(filtered),
        },
      };
    }
    case 'projectPickerHint':
      return { ...state, projectPicker: { ...state.projectPicker, hint: action.text } };
    case 'fKeyPickerOpen':
      return { ...state, ...closePanels(state), fKeyPicker: { open: true, selected: 0 } };
    case 'fKeyPickerClose':
      return { ...state, fKeyPicker: { open: false, selected: 0 } };
    case 'fKeyPickerMove': {
      // Derived from the table, not hardcoded — a literal `12` silently
      // made the 13th entry (Ctrl+N connections) unreachable by arrow keys
      // when the table grew.
      const count = F_KEY_PANEL_ENTRIES.length;
      const next = (state.fKeyPicker.selected + action.delta + count) % count;
      return { ...state, fKeyPicker: { ...state.fKeyPicker, selected: next } };
    }
    case 'confirmOpen':
      return { ...state, confirmQueue: [...state.confirmQueue, action.info] };
    case 'confirmClose':
      return { ...state, confirmQueue: state.confirmQueue.slice(1) };
    case 'confirmClearAll':
      return { ...state, confirmQueue: [] };
    case 'shellCommandWarningOpen':
      return { ...state, shellCommandWarning: action.info };
    case 'shellCommandWarningClose':
      return { ...state, shellCommandWarning: null };
    case 'enhanceOpen':
      return { ...state, enhance: action.info };
    case 'enhanceClose':
      return { ...state, enhance: null };
    case 'enhanceSet':
      return { ...state, enhanceEnabled: action.enabled };
    case 'enhanceBusy':
      return { ...state, enhanceBusy: action.on };
    case 'topicCheckBusy':
      return { ...state, topicCheckBusy: action.on };
    case 'refineCountdownOpen':
      return {
        ...state,
        refineCountdown: action.info,
        refineCountdownGen: state.refineCountdownGen + 1,
      };
    case 'refineCountdownClose':
      // A superseded refine flow unwinds AFTER the newer one opened its own
      // countdown. Closing on identity keeps that late close from leaving the
      // live countdown's promise hanging with no panel to resolve it.
      if (action.info && state.refineCountdown !== action.info) return state;
      return { ...state, refineCountdown: null };
    case 'refineFailureOpen':
      return { ...state, refineFailure: action.info };
    case 'refineFailureClose':
      return { ...state, refineFailure: null };
    case 'continueConfirmOpen':
      return { ...state, continueConfirm: action.info };
    case 'continueConfirmClose':
      return { ...state, continueConfirm: null };
    case 'bugHuntContinueOpen':
      return { ...state, bugHuntContinue: action.info };
    case 'bugHuntContinueClose':
      return { ...state, bugHuntContinue: null };
    case 'bugHuntRunningOpen':
      return { ...state, bugHuntRunning: action.info };
    case 'bugHuntRunningClose':
      return { ...state, bugHuntRunning: null };
    case 'clearConfirmOpen':
      return { ...state, clearConfirm: action.info };
    case 'clearConfirmSetValue':
      return state.clearConfirm
        ? { ...state, clearConfirm: { ...state.clearConfirm, value: action.value } }
        : state;
    case 'clearConfirmClose':
      return { ...state, clearConfirm: null };
    case 'exitConfirmOpen':
      return { ...state, exitConfirm: action.info };
    case 'exitConfirmClose':
      return { ...state, exitConfirm: null };
    case 'slashConfirmOpen':
      return { ...state, ...closePanels(state), slashConfirm: action.info };
    case 'slashConfirmClose':
      return { ...state, slashConfirm: null };
    case 'escConfirmOpen':
      return { ...state, escConfirm: { snapshot: action.snapshot } };
    case 'escConfirmClose':
      return { ...state, escConfirm: null };
    case 'fallbackOverlayOpen':
      return { ...state, fallbackOverlay: action.info };
    case 'fallbackOverlayMove': {
      if (!state.fallbackOverlay) return state;
      const n = state.fallbackOverlay.candidates.length;
      if (n === 0) return state;
      const next = (state.fallbackOverlay.selected + action.delta + n) % n;
      return { ...state, fallbackOverlay: { ...state.fallbackOverlay, selected: next } };
    }
    case 'fallbackOverlayClose':
      return { ...state, fallbackOverlay: null };
    case 'sendModePickerOpen':
      return { ...state, sendModePicker: action.info };
    case 'sendModePickerMove': {
      if (!state.sendModePicker) return state;
      const next = nextSendModeIndex(
        state.sendModePicker.selected,
        action.delta,
        SEND_MODE_OPTIONS.length,
      );
      return { ...state, sendModePicker: { ...state.sendModePicker, selected: next } };
    }
    case 'sendModePickerClose':
      return { ...state, sendModePicker: null };
    case 'resetContextChip':
      return { ...state, contextChipVersion: state.contextChipVersion + 1 };
    default:
      void (action satisfies never);
      return state;
  }
}
