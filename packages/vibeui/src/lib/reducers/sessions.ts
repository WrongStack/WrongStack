import { rows, text } from '../session-coercion';
import type { FrameReducerTable } from './types';

/** Session history and agent modes. */
export const sessionListReducers: FrameReducerTable = {
  'sessions.list': (state, p) => ({
    ...state,
    sessions: rows(p.sessions)
      .filter((s) => text(s.id))
      .map((s) => ({
        id: text(s.id),
        title: text(s.name) || text(s.title) || 'Untitled session',
        startedAt: text(s.startedAt),
      })),
  }),
  'modes.list': (state, p) => ({
    ...state,
    mode: text(p.activeId) || state.mode,
    modes: rows(p.modes)
      .filter((m) => text(m.id))
      .map((m) => ({
        id: text(m.id),
        name: text(m.name) || text(m.id),
        description: text(m.description),
      })),
  }),
  'mode.switched': (state, p) => ({ ...state, mode: text(p.id) || text(p.mode) || state.mode }),
};
