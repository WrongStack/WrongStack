import {
  type ProtocolEnvelope,
  projectChatMessage,
  projectSessionMessage,
  projectToolMessage,
  reduceStreamActivity,
} from '@wrongstack/webui-protocol';
import { FRAME_REDUCERS, frameReducer } from './reducers';
import { liveEntryId, reduceChat } from './reducers/chat';
import { reduceSessionStart } from './reducers/session-start';
import { reduceTool } from './reducers/tools';
import { contentText, record, rows, text } from './session-coercion';
import type { SessionState } from './session-state';

export { dropConnectionScopedPrompts, resolveConfirmation } from './reducers';
export {
  type AgentEntry,
  type ChatEntry,
  type Confirmation,
  type InputQuestion,
  type InputRequest,
  initialState,
  type SessionState,
  type ToolEntry,
} from './session-state';
export { contentText, record, rows, text };

/**
 * All views derive from the canonical wire projections, including historical
 * tool ordering. Order matters: the foreign-session guard, stream activity,
 * then the session → chat → tool projections, then per-frame-type reducers
 * (`./reducers`). Each step either returns the next state or falls through.
 */
export function reduceFrame(state: SessionState, frame: ProtocolEnvelope): SessionState {
  const p = record(frame.payload);
  if (
    frame.type !== 'session.start' &&
    typeof p.sessionId === 'string' &&
    state.id &&
    p.sessionId !== state.id
  )
    return state;
  const streamActivity = reduceStreamActivity(state.streamActivity ?? null, frame);
  if (streamActivity !== state.streamActivity) state = { ...state, streamActivity };
  const session = projectSessionMessage(frame);
  if (session?.id) return reduceSessionStart(state, session, p);
  const chat = projectChatMessage(frame);
  // Allocated for every non-session frame (not only chat ones) to keep ids stable.
  const id = liveEntryId(frame.type);
  const chatState = reduceChat(state, chat, p.phase, id);
  if (chatState) return chatState;
  const tool = projectToolMessage(frame);
  if (tool) return reduceTool(state, tool);
  const reducer = frameReducer(FRAME_REDUCERS, frame.type);
  if (reducer) return reducer(state, p, frame);
  // An `error` outside a run phase refused another request; the run goes on.
  return chat?.kind === 'error' ? { ...state, notice: chat.message } : state;
}

export function draftKey(sessionId: string): string {
  return `wrongstack.vibeui.draft.v1:${sessionId}`;
}

export function composeMessage(draft: string, references: string[]): string {
  return [draft.trim(), ...[...new Set(references)].map((path) => `@${path}`)]
    .filter(Boolean)
    .join('\n');
}
