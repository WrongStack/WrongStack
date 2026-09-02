/**
 * Live feed filter state + reducer for the Mailbox live-feed view.
 *
 * Declares the `MailboxLiveFilterState` shape, the action union, and the pure
 * reducer. Kept here — separate from the React component — so the reducer
 * logic can be unit-tested without jsdom, mirroring the pattern set by
 * `mailbox-grouping.test.ts`. Consumed by `mailbox-live-view.tsx`.
 */
import type { HqMailboxMessageType, HqMailboxPriority } from '@wrongstack/core/hq';

export interface MailboxLiveFilterState {
  /** Selected message types. Empty = all types. */
  readonly types: ReadonlySet<HqMailboxMessageType>;
  /** Selected priority levels. Empty = all priorities. */
  readonly priorities: ReadonlySet<HqMailboxPriority>;
  /** Selected project ids. Empty = all projects. */
  readonly projectIds: ReadonlySet<string>;
  /** When false, completed messages are hidden. */
  includeCompleted: boolean;
  /** Free-text search (subject/from/to/bodyPreview). */
  query: string;
}

export const EMPTY_LIVE_FILTER_STATE: MailboxLiveFilterState = Object.freeze({
  types: new Set<HqMailboxMessageType>(),
  priorities: new Set<HqMailboxPriority>(),
  projectIds: new Set<string>(),
  includeCompleted: true,
  query: '',
});

/**
 * Action union for the live-feed filter reducer. Each action is a
 * minimal descriptor — the reducer copies the relevant Set rather
 * than mutating in place so React's reference-equality check fires
 * correctly on a state change.
 */
export type MailboxLiveFilterAction =
  | { type: 'toggle-type'; value: HqMailboxMessageType }
  | { type: 'toggle-priority'; value: HqMailboxPriority }
  | { type: 'toggle-project'; value: string }
  | { type: 'set-query'; value: string }
  | { type: 'set-include-completed'; value: boolean }
  | { type: 'clear-all' };

/**
 * Pure reducer. Each Set-backed field is copied (not mutated) so React's
 * reference-equality check fires correctly on a state change.
 */
export function mailboxLiveFilterReducer(
  state: MailboxLiveFilterState,
  action: MailboxLiveFilterAction,
): MailboxLiveFilterState {
  switch (action.type) {
    case 'toggle-type': {
      const next = new Set(state.types);
      if (next.has(action.value)) next.delete(action.value);
      else next.add(action.value);
      return { ...state, types: next };
    }
    case 'toggle-priority': {
      const next = new Set(state.priorities);
      if (next.has(action.value)) next.delete(action.value);
      else next.add(action.value);
      return { ...state, priorities: next };
    }
    case 'toggle-project': {
      const next = new Set(state.projectIds);
      if (next.has(action.value)) next.delete(action.value);
      else next.add(action.value);
      return { ...state, projectIds: next };
    }
    case 'set-query':
      return { ...state, query: action.value };
    case 'set-include-completed':
      return { ...state, includeCompleted: action.value };
    case 'clear-all':
      return EMPTY_LIVE_FILTER_STATE;
    default: {
      // Exhaustiveness — adding a new action without updating the
      // reducer is a compile-time error.
      const _exhaustive: never = action;
      return state;
    }
  }
}
