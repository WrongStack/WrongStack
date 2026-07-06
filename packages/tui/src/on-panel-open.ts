// Slash-command → TUI panel dispatch bridge.
//
// Slash commands like `/plugin`, `/plugin menu`, `/f1`..`/f12`, `/audit`, and
// `/settings menu` call `onPanelOpen.current(action)` to open a panel via
// the dispatch reducer. The App's mount-effect in `app.tsx` installs this
// bridge; without it, the slash commands silently fall through to their
// text response and the pickers never open.
//
// The bridge is implemented as a pure function (`createPanelOpenDispatcher`)
// so it can be exercised by tests without mounting React. Tests live in
// `tests/on-panel-open-bridge.test.ts`.

import type { Action } from './app-reducer.js';
import type { PluginPickerItem } from './components/plugin-picker.js';

/**
 * Action strings that the bridge recognises. Mirrored from the reducer's
 * `Action` type union but kept as a string allow-list here so an unrecognised
 * action can return `false` (text fallback) without crashing.
 */
export type PanelAction =
  | 'pluginPickerOpen'
  | 'mcpPickerOpen'
  | 'toolsPickerOpen'
  | 'brainOpen'
  | 'shadowOpen'
  | 'projectPickerOpen'
  | 'statuslineOpen'
  | 'authOpen'
  | 'authOauthOpen'
  | 'modePickerOpen'
  | 'toggleMonitor'
  | 'toggleAuditPanel'
  | 'toggleAgentsMonitor'
  | 'toggleWorktreeMonitor'
  | 'togglePlanPanel'
  | 'toggleKanbanPanel'
  | 'toggleTodosMonitor'
  | 'toggleQueuePanel'
  | 'toggleProcessList'
  | 'toggleGoalPanel'
  | 'toggleSessionsPanel'
  | 'toggleCoordinatorMonitor'
  | (string & {}); // forward-compatible: unknown strings return false

export interface PanelOpenDeps {
  /**
   * Reducer dispatcher. For an action that has typed reducer cases the
   * caller passes a narrowed `Dispatch<Action>`; for the action-typed-aliasing
   * cases below we widen via `dispatch as (a: Action) => void` internally.
   */
  dispatch: (action: Action) => void;
  /** Async opener for the project picker panel (F1). Fetches items first. */
  openProjectPicker: () => void | Promise<unknown>;
  /** Opener for the statusline picker; computes the hiddenItems snapshot. */
  openStatuslinePicker: () => void;
  /**
   * Opener for the interactive auth panel (`/auth`). Returns false when the
   * CLI didn't provide an auth host — the slash command then falls back to
   * its plain-text output. Optional so older hosts keep working.
   */
  openAuthPanel?: ((view?: 'list' | 'oauth') => boolean) | undefined;
  /**
   * Async opener for the mode picker (`/mode`). Fetches all modes + active
   * mode from the host and dispatches modePickerOpen with the populated list.
   */
  openModePicker?: (() => void | Promise<unknown>) | undefined;
  /**
   * Async opener for the Brain panel (`/brain`). Fetches current risk level
   * and decision log from the host, then dispatches brainOpen.
   */
  openBrainPanel?: (() => void | Promise<unknown>) | undefined;
  /**
   * Async opener for the Shadow Agent panel (`/shadow`). Fetches shadow state
   * from the host, then dispatches shadowOpen.
   */
  openShadowPanel?: (() => void | Promise<unknown>) | undefined;
}

/**
 * Build the dispatcher that lives at `onPanelOpen.current(action)`.
 *
 * Returns `true` when the action was handled (so the slash command suppresses
 * its text fallback), or `false` when the action is not in the catalogue
 * (so the slash command can print its plain-text response — the headless /
 * REPL fallback path).
 */
export function createPanelOpenDispatcher(deps: PanelOpenDeps): (action: string) => boolean {
  const { dispatch, openProjectPicker, openStatuslinePicker, openAuthPanel } = deps;
  return (action: string): boolean => {
    switch (action) {
      case 'authOpen':
        // Requires the CLI-provided auth host; without it, fall back to the
        // slash command's read-only text output.
        return openAuthPanel ? openAuthPanel('list') : false;
      case 'authOauthOpen':
        return openAuthPanel ? openAuthPanel('oauth') : false;
      case 'pluginPickerOpen':
        // The picker self-loads via getPluginItems in its own refresh effect,
        // so we just dispatch the open action.
        dispatch({ type: 'pluginPickerOpen' });
        return true;
      case 'mcpPickerOpen':
        // The picker self-loads via getMcpServers in its own refresh effect.
        dispatch({ type: 'mcpPickerOpen' });
        return true;
      case 'toolsPickerOpen':
        dispatch({ type: 'toolsPickerOpen' });
        return true;
      case 'projectPickerOpen':
        // Items must be loaded from the host before opening — delegate to the
        // same async opener that F1 uses.
        void openProjectPicker();
        return true;
      case 'statuslineOpen':
        // statuslineOpen requires a hiddenItems snapshot — delegate to the
        // existing callback which knows how to compute it.
        openStatuslinePicker();
        return true;
      case 'modePickerOpen':
        // Async — fetches modes from the host, then dispatches open.
        if (deps.openModePicker) {
          void deps.openModePicker();
          return true;
        }
        return false;
      case 'brainOpen':
        if (deps.openBrainPanel) {
          void deps.openBrainPanel();
          return true;
        }
        return false;
      case 'shadowOpen':
        if (deps.openShadowPanel) {
          void deps.openShadowPanel();
          return true;
        }
        return false;
      case 'toggleMonitor':
        dispatch({ type: 'toggleMonitor' });
        return true;
      case 'toggleAuditPanel':
        dispatch({ type: 'toggleAuditPanel' });
        return true;
      // All other toggle* panels share the same handler in the reducer —
      // the action type string IS the dispatch type. Dispatching them
      // verbatim works because the reducer's switch covers every F-key
      // panel action.
      case 'toggleAgentsMonitor':
      case 'toggleWorktreeMonitor':
      case 'togglePlanPanel':
      case 'toggleKanbanPanel':
      case 'toggleTodosMonitor':
      case 'toggleQueuePanel':
      case 'toggleProcessList':
      case 'toggleGoalPanel':
      case 'toggleSessionsPanel':
      case 'toggleCoordinatorMonitor':
        dispatch({ type: action } as Action);
        return true;
      default:
        // Unknown action — let the slash command fall back to text.
        return false;
    }
  };
}

/**
 * Re-export PluginPickerItem so consumers of the dispatcher can construct
 * typed items without an extra import. Kept as a re-export rather than a
 * duplicate so the type lives in one place.
 */
export type { PluginPickerItem };
