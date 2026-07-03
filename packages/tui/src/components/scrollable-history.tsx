import { Box, type DOMElement, Text, measureElement, useStdout } from '../ink.js';
import type React from 'react';
import { useLayoutEffect, useRef, memo } from 'react';
import { theme } from '../theme.js';
import {
  AssistantTail,
  Entry,
  type HistoryEntry,
  type HistoryProps,
  MAX_STREAM_DISPLAY_CHARS,
  ToolStreamBox,
  tailForDisplay,
} from './history.js';

/** Max history entries laid out in the managed viewport at once. Generous
 *  enough to cover a long session's in-app scrollback while bounding the
 *  per-frame Yoga layout cost. */
const MAX_MOUNTED = 500;

export interface ScrollableHistoryProps extends HistoryProps {
  /** Lines scrolled up from the bottom. 0 = pinned to the newest output. */
  scrollOffset: number;
  /** Height of the viewport in rows, computed by App from the bottom region. */
  viewportRows: number;
  /** Last measured total content height (rows). Drives the scrollbar thumb. */
  totalLines: number;
  /** Reports the measured total content height (rows) after every layout so
   *  App can clamp the scroll offset and drive the "N new lines" affordance. */
  onMeasure: (totalLines: number) => void;
  /** Optional cap on the width used for entry wrapping (right panel mode). */
  maxWidth?: number | undefined;
}

/**
 * Right-edge scrollbar for the managed viewport. A 1-column track with a thumb
 * sized + positioned from (scrollOffset, totalLines, viewportRows). Always
 * reserves its column so toggling scrollability doesn't reflow the content.
 */
/** Pure thumb geometry for the scrollbar: where the thumb starts and how many
 *  cells it spans, given the track height, scroll offset, and total content
 *  height. Exported for testing. */
export function scrollbarThumb(
  rows: number,
  offset: number,
  total: number,
): { top: number; size: number; scrollable: boolean } {
  const scrollable = total > rows;
  if (!scrollable) return { top: 0, size: rows, scrollable: false };
  // Visible window top in content-line space; 0 = oldest, total = newest.
  const windowTop = Math.max(0, total - rows - offset);
  const size = Math.max(1, Math.round((rows / total) * rows));
  const rawTop = Math.round((windowTop / total) * rows);
  const top = Math.max(0, Math.min(rawTop, rows - size));
  return { top, size, scrollable: true };
}

/** Inverse of {@link scrollbarThumb}: given a clicked/dragged 0-based cell on a
 *  track of `rows` height, return the scroll offset (rows up from the bottom)
 *  that lands the visible window there. Cell 0 (top) → oldest content (max
 *  offset); cell rows-1 (bottom) → newest (offset 0). Exported for testing and
 *  the TUI scrollbar mouse handler. */
export function scrollOffsetForTrackRow(rows: number, total: number, cell: number): number {
  if (total <= rows) return 0;
  const maxOffset = total - rows;
  const clampedCell = Math.max(0, Math.min(rows - 1, cell));
  const windowTop = Math.round((clampedCell / Math.max(1, rows - 1)) * maxOffset);
  return Math.max(0, Math.min(maxOffset, maxOffset - windowTop));
}

function Scrollbar({
  rows,
  offset,
  total,
}: { rows: number; offset: number; total: number }): React.ReactElement {
  const { top: thumbTop, size: thumbSize, scrollable } = scrollbarThumb(rows, offset, total);
  const cells: string[] = [];
  for (let i = 0; i < rows; i++) {
    cells.push(i >= thumbTop && i < thumbTop + thumbSize ? '█' : '│');
  }
  return (
    <Box flexDirection="column" marginLeft={1} flexShrink={0}>
      {cells.map((c, i) => (
        <Text
          key={i}
          {...(scrollable ? { color: theme.accent } : {})}
          dimColor={!scrollable || c === '│'}
        >
          {c}
        </Text>
      ))}
    </Box>
  );
}

/**
 * Mouse-mode replacement for {@link History}. Instead of streaming each entry
 * into the terminal's native scrollback via `<Static>`, it renders all entries
 * into a fixed-height, `overflowY:'hidden'` viewport that the app scrolls
 * itself. The terminal's wheel is captured by mouse mode, so scrolling MUST be
 * managed here.
 *
 * Mechanism (Ink-5 verified): the parent Box is height-bounded with
 * `justifyContent:'flex-end'`, so when content overflows, its BOTTOM aligns to
 * the viewport bottom — newest output visible, oldest clipped off the top. That
 * is the pinned (offset 0) state for free, with no height math. Scrolling up is
 * a single `marginBottom={scrollOffset}` on the content box: it pushes the
 * content up, dropping `scrollOffset` rows off the bottom of the clip and
 * revealing that many older rows at the top. Ink's output clipper slices the
 * over/underflowing child at both edges while preserving ANSI styling.
 *
 * Streaming tails (assistant + tool) are the last children of the content box,
 * so they participate in the scrolled content and auto-follow when pinned.
 *
 * Wrapped in `React.memo` so keystrokes in the input buffer don't
 * trigger a full managed-viewport re-layout. All props are primitives
 * or stable reducer references.
 */
export const ScrollableHistory = memo(function ScrollableHistory({
  entries,
  streamingText,
  toolStream,
  scrollOffset,
  viewportRows,
  totalLines,
  onMeasure,
  maxWidth,
  setSuggestions,
  autonomyMode,
  todos,
}: ScrollableHistoryProps): React.ReactElement {
  const { stdout } = useStdout();
  const rawWidth = stdout?.columns ?? 80;
  const termWidth = maxWidth ? Math.min(rawWidth, maxWidth) : rawWidth;

  const tail = streamingText ? tailForDisplay(streamingText, MAX_STREAM_DISPLAY_CHARS) : '';
  const toolTail = toolStream?.text
    ? tailForDisplay(toolStream.text, MAX_STREAM_DISPLAY_CHARS)
    : '';

  // Performance bound: the managed viewport re-lays-out every mounted entry
  // each frame (unlike the <Static> path, which prints once). Mounting only
  // the most recent MAX_MOUNTED keeps Yoga layout O(MAX_MOUNTED) regardless of
  // how long the session runs. Older entries stay in the reducer + on disk;
  // they're just not laid out. (True windowing — spacer boxes for measured
  // off-screen entries — is a later upgrade; this is the safe bound.)
  const hiddenCount = Math.max(0, entries.length - MAX_MOUNTED);
  const shown = hiddenCount > 0 ? entries.slice(-MAX_MOUNTED) : entries;

  // Measure the content box height after each commit and report it up only
  // when it changes. The content's own computed height does NOT depend on
  // viewportRows or marginBottom (margins/justify are layout-outside), so this
  // is stable — no measure → dispatch → re-measure feedback loop.
  const contentRef = useRef<DOMElement | null>(null);
  const lastReported = useRef(-1);
  useLayoutEffect(() => {
    const node = contentRef.current;
    if (!node) return;
    const { height } = measureElement(node);
    if (height !== lastReported.current) {
      lastReported.current = height;
      onMeasure(height);
    }
    // onMeasure is stable (dispatch from useReducer) and node is a ref.
  }, [onMeasure]);

  const vp = Math.max(1, viewportRows);
  return (
    <Box flexDirection="row">
      <Box
        flexDirection="column"
        flexGrow={1}
        height={vp}
        overflowY="hidden"
        justifyContent="flex-end"
      >
        <Box
          ref={contentRef}
          flexDirection="column"
          marginBottom={Math.max(0, scrollOffset)}
          flexShrink={0}
        >
          {hiddenCount > 0 ? (
            <Box flexShrink={0}>
              <Text dimColor italic>
                {`  ↑ ${hiddenCount} earlier ${hiddenCount === 1 ? 'entry' : 'entries'} (scroll lives in this session; full log on disk)`}
              </Text>
            </Box>
          ) : null}
          {shown.map((entry) => (
            <Box key={entry.id} marginBottom={entry.kind === 'turn-summary' ? 1 : 0} flexShrink={0}>
              <Entry entry={entry} termWidth={termWidth} setSuggestions={setSuggestions} autonomyMode={autonomyMode} todos={todos} />
            </Box>
          ))}
          {tail ? <AssistantTail text={tail} termWidth={termWidth} /> : null}
          {toolTail && toolStream ? (
            <ToolStreamBox
              name={toolStream.name}
              text={toolTail}
              startedAt={toolStream.startedAt}
              termWidth={termWidth}
            />
          ) : null}
        </Box>
      </Box>
      <Scrollbar rows={vp} offset={Math.max(0, scrollOffset)} total={totalLines} />
    </Box>
  );
});

// Re-exported for convenience so app.tsx can import both from one module.
export type { HistoryEntry };
