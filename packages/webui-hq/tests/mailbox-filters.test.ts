import { describe, expect, it } from 'vitest';
import type { MailboxLiveFilterState } from '../src/domain/mailbox-filters.js';
import { EMPTY_LIVE_FILTER_STATE, mailboxLiveFilterReducer } from '../src/domain/mailbox-filters.js';

describe('mailbox-filters reducer', () => {
  it('exhaustive default returns state unchanged for unknown action type', () => {
    // The default case uses a `never` assertion for compile-time
    // exhaustiveness checking. At runtime, an unrecognised action
    // (which should never happen with valid types) returns state unchanged.
    const state = mailboxLiveFilterReducer(
      EMPTY_LIVE_FILTER_STATE,
      // @ts-expect-error: testing runtime fallthrough for unknown action
      { type: 'unknown-action' },
    );
    expect(state).toBe(EMPTY_LIVE_FILTER_STATE);
  });

  it('returns initial state on clear-all action', () => {
    const dirtyState: MailboxLiveFilterState = {
      types: new Set(['note']),
      priorities: new Set(['high']),
      projectIds: new Set(['demo']),
      includeCompleted: false,
      query: 'search query',
    };
    const next = mailboxLiveFilterReducer(dirtyState, { type: 'clear-all' });
    expect(next).toEqual(EMPTY_LIVE_FILTER_STATE);
  });

  it('returns the canonical empty singleton on clear-all (reference equality)', () => {
    // clear-all should return the shared frozen singleton verbatim so
    // React's reference check can short-circuit a no-op re-render.
    const dirtyState: MailboxLiveFilterState = {
      types: new Set(['note']),
      priorities: new Set(['high']),
      projectIds: new Set(['demo']),
      includeCompleted: false,
      query: 'search query',
    };
    const next = mailboxLiveFilterReducer(dirtyState, { type: 'clear-all' });
    expect(next).toBe(EMPTY_LIVE_FILTER_STATE);
  });

  it('handles toggle-type action', () => {
    // Add a type
    let state = mailboxLiveFilterReducer(EMPTY_LIVE_FILTER_STATE, {
      type: 'toggle-type',
      value: 'note',
    });
    expect(state.types.has('note')).toBe(true);

    // Remove the type
    state = mailboxLiveFilterReducer(state, {
      type: 'toggle-type',
      value: 'note',
    });
    expect(state.types.has('note')).toBe(false);
  });

  it('handles toggle-priority action', () => {
    // Add priority
    let state = mailboxLiveFilterReducer(EMPTY_LIVE_FILTER_STATE, {
      type: 'toggle-priority',
      value: 'high',
    });
    expect(state.priorities.has('high')).toBe(true);

    // Remove priority
    state = mailboxLiveFilterReducer(state, {
      type: 'toggle-priority',
      value: 'high',
    });
    expect(state.priorities.has('high')).toBe(false);
  });

  it('handles toggle-project action', () => {
    // Add project
    let state = mailboxLiveFilterReducer(EMPTY_LIVE_FILTER_STATE, {
      type: 'toggle-project',
      value: 'my-project',
    });
    expect(state.projectIds.has('my-project')).toBe(true);

    // Remove project
    state = mailboxLiveFilterReducer(state, {
      type: 'toggle-project',
      value: 'my-project',
    });
    expect(state.projectIds.has('my-project')).toBe(false);
  });

  it('handles set-query action', () => {
    const state = mailboxLiveFilterReducer(EMPTY_LIVE_FILTER_STATE, {
      type: 'set-query',
      value: 'test query',
    });
    expect(state.query).toBe('test query');
  });

  it('handles set-include-completed action', () => {
    let state = mailboxLiveFilterReducer(EMPTY_LIVE_FILTER_STATE, {
      type: 'set-include-completed',
      value: false,
    });
    expect(state.includeCompleted).toBe(false);

    // Toggle back to true to exercise both directions.
    state = mailboxLiveFilterReducer(state, {
      type: 'set-include-completed',
      value: true,
    });
    expect(state.includeCompleted).toBe(true);
  });

  describe('immutability', () => {
    it('does not mutate the previous state when toggling a Set', () => {
      const before = EMPTY_LIVE_FILTER_STATE;
      const after = mailboxLiveFilterReducer(before, {
        type: 'toggle-type',
        value: 'note',
      });
      // A new state object is returned...
      expect(after).not.toBe(before);
      // ...the toggled Set is a fresh copy, not the shared instance...
      expect(after.types).not.toBe(before.types);
      // ...and the previous state (including the shared singleton's Set)
      // is left untouched, so later `clear-all`s stay clean.
      expect(before.types.has('note')).toBe(false);
      expect(before.types.size).toBe(0);
    });

    it('preserves unrelated slices by reference on a partial update', () => {
      const before = EMPTY_LIVE_FILTER_STATE;
      const after = mailboxLiveFilterReducer(before, {
        type: 'toggle-priority',
        value: 'high',
      });
      // Only `priorities` changed; the other Sets are carried over by
      // reference (spread), which keeps memoized selectors stable.
      expect(after.priorities).not.toBe(before.priorities);
      expect(after.types).toBe(before.types);
      expect(after.projectIds).toBe(before.projectIds);
    });

    it('does not leak Set mutations across reducer calls', () => {
      // Add then remove the same project; the intermediate state must not
      // have been mutated in place by the second dispatch.
      const added = mailboxLiveFilterReducer(EMPTY_LIVE_FILTER_STATE, {
        type: 'toggle-project',
        value: 'demo',
      });
      const removed = mailboxLiveFilterReducer(added, {
        type: 'toggle-project',
        value: 'demo',
      });
      expect(added.projectIds.has('demo')).toBe(true);
      expect(removed.projectIds.has('demo')).toBe(false);
      expect(removed.projectIds).not.toBe(added.projectIds);
    });
  });
});
