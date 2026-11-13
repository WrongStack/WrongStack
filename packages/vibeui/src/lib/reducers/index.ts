import { agentReducers } from './agents';
import { fileReducers } from './files';
import { interactionReducers } from './interactions';
import { noticeReducers } from './notices';
import { providerReducers } from './provider';
import { runtimeReducers } from './runtime';
import { sessionListReducers } from './sessions';
import type { FrameReducerTable } from './types';
import { workItemReducers } from './work-items';

export { replayAgentSessions } from './agents';
export { dropConnectionScopedPrompts, resolveConfirmation } from './interactions';
export { type FrameReducer, type FrameReducerTable, frameReducer } from './types';

const GROUPS: readonly FrameReducerTable[] = [
  fileReducers,
  sessionListReducers,
  providerReducers,
  runtimeReducers,
  workItemReducers,
  agentReducers,
  interactionReducers,
  noticeReducers,
];

/** Merges the per-area tables; a frame type owned by two areas is a programming error. */
export function mergeFrameReducers(groups: readonly FrameReducerTable[]): FrameReducerTable {
  const merged: Record<string, FrameReducerTable[string]> = {};
  for (const group of groups)
    for (const [type, reducer] of Object.entries(group)) {
      if (Object.hasOwn(merged, type)) throw new Error(`Duplicate frame reducer: ${type}`);
      merged[type] = reducer;
    }
  return Object.freeze(merged);
}

/** Every frame type handled after the session/chat/tool projections. */
export const FRAME_REDUCERS: FrameReducerTable = mergeFrameReducers(GROUPS);
