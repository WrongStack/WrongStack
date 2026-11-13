import { number, record, rows, text } from '../session-coercion';
import { MAX_CONFIRM_QUEUE, type SessionState } from '../session-state';
import type { FrameReducer, FrameReducerTable } from './types';

/**
 * Drops approval prompts when the connection ends. The server re-sends every
 * still-pending `tool.confirm_needed` to each new socket, so the live ones
 * come back immediately after a reconnect while prompts the server already
 * resolved or timed out no longer linger on screen.
 *
 * Input requests are kept: the server does not re-send them, so clearing one
 * would lose a question that is still waiting; a stale one can be cancelled.
 */
export function dropConnectionScopedPrompts(state: SessionState): SessionState {
  if (!state.confirm && !state.confirmQueue.length) return state;
  return { ...state, confirm: null, confirmQueue: [] };
}

export function resolveConfirmation(state: SessionState, id: string): SessionState {
  return state.confirm?.id === id
    ? {
        ...state,
        confirm: state.confirmQueue[0] ?? null,
        confirmQueue: state.confirmQueue.slice(1),
      }
    : { ...state, confirmQueue: state.confirmQueue.filter((c) => c.id !== id) };
}

/** The first approval is shown; concurrent ones queue in arrival order. */
const confirmNeeded: FrameReducer = (state, p) => {
  const confirm = {
    id: text(p.id),
    tool: text(p.toolName),
    input: JSON.stringify(p.input, null, 2) ?? '',
    deadlineAt: number(p.deadlineAt),
  };
  if (!confirm.id) return state;
  if (!state.confirm || state.confirm.id === confirm.id) return { ...state, confirm };
  return {
    ...state,
    confirmQueue: [...state.confirmQueue.filter((c) => c.id !== confirm.id), confirm].slice(
      -MAX_CONFIRM_QUEUE,
    ),
  };
};

const inputRequested: FrameReducer = (state, p) => {
  const r = record(p.request);
  if (!text(r.id) || state.inputs.some((i) => i.id === r.id)) return state;
  const questions = rows(r.tabs)
    .flatMap((tab) => rows(tab.questions))
    .map((q) => ({
      id: text(q.id),
      prompt: text(q.prompt),
      kind: text(q.kind),
      required: q.required === true,
      allowCustom: q.allowCustomResponse !== false || q.kind === 'text',
      options: rows(q.options).map((o) => ({ id: text(o.id), label: text(o.label) })),
    }));
  return {
    ...state,
    inputs: [...state.inputs, { id: text(r.id), title: text(r.title), questions }],
  };
};

/** Tool approvals and structured user-input questions. */
export const interactionReducers: FrameReducerTable = {
  'tool.confirm_needed': confirmNeeded,
  'tool.confirm_resolved': (state, p) => resolveConfirmation(state, text(p.id)),
  'user.input_requested': inputRequested,
  'user.input_resolved': (state, p) => ({
    ...state,
    inputs: state.inputs.filter((r) => r.id !== p.requestId),
  }),
};
