import type { Action } from '../app-action-type.js';
import type { State } from '../app-state.js';

type MessageJumpAction = Extract<Action, { type: 'messageJump' }>;

/**
 * Alt+↑ / Alt+↓: step through the user's own messages in the transcript.
 * The first Alt+↑ lands on the newest one; further steps stop at either end.
 * `seq` increments on every step so the view scrolls even when the target
 * entry is the same one (the user may have scrolled away since).
 */
export function reduceMessageJump(state: State, action: MessageJumpAction): State {
  const userIds = state.entries.filter((e) => e.kind === 'user').map((e) => e.id);
  if (userIds.length === 0) return state;
  const current = state.messageJump.entryId;
  const at = current === null ? -1 : userIds.indexOf(current);
  const dir = Number.isFinite(action.direction) ? Math.trunc(action.direction) : 0;
  let next: number;
  if (at === -1) next = dir < 0 ? userIds.length - 1 : 0;
  else next = Math.min(userIds.length - 1, Math.max(0, at + dir));
  return {
    ...state,
    messageJump: { entryId: userIds[next] ?? null, seq: state.messageJump.seq + 1 },
    // The status bar cuts a hint to 44, 18 or 9 columns: the action goes first.
    hint: 'Enter rewind/fork · Esc done · Alt+↑↓ move',
  };
}

/** Drop the marked message (Esc, or any key that goes on to the composer). */
export function clearMessageJump(state: State): State {
  if (state.messageJump.entryId === null) return state;
  return { ...state, messageJump: { entryId: null, seq: state.messageJump.seq }, hint: '' };
}
