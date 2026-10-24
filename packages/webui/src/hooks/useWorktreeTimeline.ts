import {
  projectWorktreeTimeline,
  type WorktreeTimeline,
} from '@wrongstack/contracts/types/worktree-timeline';
import { useEffect, useMemo, useState } from 'react';
import { useWorktreeStore } from '@/stores';

/** Repaint cadence while a worktree is live (open segments grow with time). */
const LIVE_TICK_MS = 1000;

/**
 * The worktree timeline for `sessionId` (all sessions when undefined),
 * projected from the store's lifecycle log by the shared core projector.
 * Ticks only while something is live, so an idle view never repaints.
 */
export function useWorktreeTimeline(sessionId: string | undefined): WorktreeTimeline {
  const events = useWorktreeStore((s) => s.timelineEvents);
  const [now, setNow] = useState(() => Date.now());

  const timeline = useMemo(
    () => projectWorktreeTimeline(events, { now, sessionId }),
    [events, now, sessionId],
  );
  const live = timeline.counts.live > 0;

  useEffect(() => {
    // Re-anchor on new events even when idle, so a just-finished lane ends at
    // its real time instead of the last tick.
    setNow(Date.now());
  }, [events]);

  useEffect(() => {
    if (!live) return;
    const id = setInterval(() => setNow(Date.now()), LIVE_TICK_MS);
    return () => clearInterval(id);
  }, [live]);

  return timeline;
}
