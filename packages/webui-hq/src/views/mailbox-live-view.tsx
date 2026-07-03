/**
 * Live mailbox feed view (skeleton).
 *
 * Phase 3 skeleton: declares the `LiveMailboxView` React component
 * signature, wires it to the existing pure helpers
 * (`groupMailboxEvents` + `buildLiveFeedFromHq`), and renders a
 * minimal placeholder list. Phase 4+ will add the filter bar UI,
 * the virtualised scroll, and the new-event highlight.
 *
 * Keeping the view in its own file (vs. inside `mailbox.tsx`) means
 * the view-mode toggle in `mailbox.tsx` is a one-line import swap
 * when both views are wired up in Phase 5.
 */

import type { HqEventEnvelope, HqSnapshot } from '@wrongstack/core';
import type React from 'react';
import { useMemo, useReducer } from 'react';
import { useHqStore } from '../store.js';
import { EMPTY_LIVE_FILTER_STATE, mailboxLiveFilterReducer } from './mailbox-filters.js';
import { buildLiveFeedFromHq } from './mailbox-live.js';
import { MessageRow } from './mailbox-row.js';

export interface LiveMailboxViewProps {
  /** Optional injected snapshot for unit tests. */
  snapshot?: Pick<HqSnapshot, 'mailboxes'> | null | undefined;
  /** Optional injected event stream for unit tests. */
  events?: readonly HqEventEnvelope[] | undefined;
}

export function LiveMailboxView({
  snapshot: snapshotOverride,
  events: eventsOverride,
}: LiveMailboxViewProps = {}): React.ReactElement {
  // When called from the unified `mailbox.tsx` view, prefer the live
  // HQ store. When called from a unit test, the caller passes the
  // snapshot + events explicitly so we don't need a provider.
  const store = useHqStore();
  const snapshot = snapshotOverride !== undefined ? snapshotOverride : store.snapshot;
  const events = eventsOverride !== undefined ? eventsOverride : store.events;

  const [filters, dispatch] = useReducer(mailboxLiveFilterReducer, EMPTY_LIVE_FILTER_STATE);

  const feed = useMemo(
    () =>
      buildLiveFeedFromHq(snapshot ?? null, events, {
        types: Array.from(filters.types),
        priorities: Array.from(filters.priorities),
        projectIds: Array.from(filters.projectIds),
        includeCompleted: filters.includeCompleted,
        query: filters.query || undefined,
        limit: 500,
      }),
    [snapshot, events, filters],
  );

  // Skeleton render: just the row list. Phase 4 adds the filter bar
  // and the virtualised scroll. The "showing N of M" hint is
  // already wired because `feed.truncated` is the live signal.
  return (
    <div>
      <div className="hq-card-title">
        Live mailbox feed · {feed.returned} of {feed.totalMatched} message
        {feed.totalMatched === 1 ? '' : 's'}
        {feed.truncated ? ' · refined to fit' : ''}
      </div>
      {feed.entries.length === 0 ? (
        <div className="hq-empty">No mailbox activity matches the current filters.</div>
      ) : (
        <div className="hq-msg-list">
          {feed.entries.map((e) => (
            <MessageRow key={e.key} flat={e.flat} />
          ))}
        </div>
      )}
      {/* Filter controls land in Phase 4. The reducer wiring is
          already here so the next phase only has to add the JSX.
          The button below is a skeleton so the dispatch reference is
          live (and so users can see the toggle is wired). Phase 4 will
          replace it with the real filter bar. */}
      <div className="hq-card-title" style={{ display: 'flex', gap: 8 }}>
        <button
          type="button"
          className="hq-btn secondary"
          onClick={() => dispatch({ type: 'clear-all' })}
        >
          Clear filters (skeleton)
        </button>
      </div>
      <noscript>
        Filter controls require JavaScript. The skeleton above shows the full unfiltered timeline.
      </noscript>
    </div>
  );
}
