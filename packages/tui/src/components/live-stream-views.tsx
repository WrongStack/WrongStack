import type React from 'react';
import { useLiveStream } from '../live-stream-store.js';
import type { ScrollableHistoryProps } from './history/scroll-controller-types.js';
import { ScrollableHistory } from './scrollable-history.js';
import { StreamActivityLine } from './stream-activity-line.js';

/**
 * Subscribers to the live stream store. A stream flush re-renders these and
 * the leaves under them, not the App that mounts them.
 */

/** `ScrollableHistory` fed its live assistant and tool tails from the store. */
export function LiveScrollableHistory(
  props: Omit<ScrollableHistoryProps, 'toolStream' | 'streamingText'>,
): React.ReactElement {
  const streamingText = useLiveStream((live) => live.streamingText);
  const toolStream = useLiveStream((live) => live.toolStream);
  return <ScrollableHistory {...props} streamingText={streamingText} toolStream={toolStream} />;
}

/** The stream activity row, following the store's counters. */
export function LiveStreamActivityLine({
  width,
  running,
}: {
  width: number;
  running: boolean;
}): React.ReactElement | null {
  const activity = useLiveStream((live) => live.streamActivity);
  return <StreamActivityLine activity={activity} width={width} running={running} />;
}
