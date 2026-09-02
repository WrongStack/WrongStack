import type { Action } from './app-action-type.js';
import type { State } from './app-state.js';
// Reducer — pure state transformation. Types are in app-state.ts.
// This file has NO React or Ink dependencies.
import { reduceFleetState } from './reducers/fleet.js';
import { isActivityAction, reduceActivity } from './reducers/activity.js';
import { isDialogAction, reduceDialogs } from './reducers/dialogs.js';
import { isComposerAction, reduceComposer } from './reducers/composer.js';
import { isConversationAction, reduceConversation } from './reducers/conversation.js';
import { isPanelPickerAction, reducePanelPickers } from './reducers/panel-pickers.js';
import { isSettingsPanelAction, reduceSettingsPanel } from './reducers/settings-panel.js';
import { isSettingsValueAction, reduceSettingsValues } from './reducers/settings-values.js';
import { isWorkspacePanelAction, reduceWorkspacePanels } from './reducers/workspace-panels.js';

// Re-export types from app-state.ts for backward compatibility.
export type {
  DraftEntry,
  FleetEntry,
  GoalSummary,
  QueueItem,
  ResumeSessionEntry,
  Settings,
  SlashCommandMatch,
  State,
} from './app-state.js';
export type { Action } from './app-action-type.js';
// Re-export extracted functions for backward compatibility.
// Tests may import directly from app-reducer.js rather than reducers/helpers.js.
export { firstSelectable, pruneToolInput, skipDivider } from './reducers/helpers.js';

export function reducer(state: State, action: Action): State {
  if (isWorkspacePanelAction(action)) return reduceWorkspacePanels(state, action);
  if (isActivityAction(action)) return reduceActivity(state, action);
  if (isDialogAction(action)) return reduceDialogs(state, action);
  if (isComposerAction(action)) return reduceComposer(state, action);
  if (isConversationAction(action)) return reduceConversation(state, action);
  if (isPanelPickerAction(action)) return reducePanelPickers(state, action);
  if (isSettingsPanelAction(action)) return reduceSettingsPanel(state, action);
  if (isSettingsValueAction(action)) return reduceSettingsValues(state, action);

  switch (action.type) {
    // fleetBatch runs below (cannot be extracted because it needs the reducer ref).
    // --- Fleet & leader (delegated to reducers/fleet.ts) ---
    case 'fleetSeed':
    case 'fleetSpawn':
    case 'fleetToolStart':
    case 'fleetToolEnd':
    case 'fleetStart':
    case 'fleetDelta':
    case 'fleetMessage':
    case 'fleetTool':
    case 'fleetUsage':
    case 'fleetDone':
    case 'fleetRemove':
    case 'fleetBudgetWarning':
    case 'fleetBudgetExtended':
    case 'fleetCtxPct':
    case 'fleetCost':
    case 'fleetConcurrency':
    case 'leaderIterStart':
    case 'leaderIterEnd':
    case 'leaderToolStart':
    case 'leaderToolEnd':
    case 'leaderCtxPct':
    case 'setFleetChat': {
      const fleetResult = reduceFleetState(state, action);
      if (fleetResult) return fleetResult;
      return state;
    }
    case 'fleetBatch':
      // Fold each batched action through the reducer; one new state, one render.
      return action.actions.reduce((s, a) => reducer(s, a), state);
    default: {
      // Exhaustiveness check: if Action adds a new variant without a matching
      // case, TypeScript will error here instead of silently returning undefined.
      void (action satisfies never);
      return state;
    }
  }
}
