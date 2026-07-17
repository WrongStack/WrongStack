import { Box, type DOMElement, Text, measureElement, useStdout } from '../ink.js';
import type React from 'react';
import { useEffect, useLayoutEffect, useRef, useState, memo } from 'react';
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
import { computeWindow, EntryHeightCache } from '../height-cache.js';

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
  showModelReasoning,
}: ScrollableHistoryProps): React.ReactElement {
  const { stdout } = useStdout();
  const [termWidth, setTermWidth] = useState(
    maxWidth ? Math.min(stdout?.columns ?? 80, maxWidth) : stdout?.columns ?? 80,
  );
  useEffect(() => {
    const handleResize = () => {
      const raw = stdout?.columns ?? 80;
      setTermWidth(maxWidth ? Math.min(raw, maxWidth) : raw);
    };
    process.stdout.on('resize', handleResize);
    return () => {
      process.stdout.off('resize', handleResize);
    };
  }, [stdout, maxWidth]);

  const tail = streamingText ? tailForDisplay(streamingText, MAX_STREAM_DISPLAY_CHARS) : '';
  const toolTail = toolStream?.text
    ? tailForDisplay(toolStream.text, MAX_STREAM_DISPLAY_CHARS)
    : '';

  // Height cache for virtual-scroll windowing. Collects measured content
  // heights on every layout and drives per-entry window computation.
  const heightCacheRef = useRef<EntryHeightCache>(new EntryHeightCache());

  // Measure the content box height after each commit. Reports the cache's
  // total height (accurate for all entries, including off-screen ones) to
  // the parent for scroll-offset clamping. Also records each visible entry's
  // estimated height so computeWindow() can resolve scroll positions.
  const contentRef = useRef<DOMElement | null>(null);
  const lastReported = useRef(-1);
  useLayoutEffect(() => {
    const node = contentRef.current;
    if (!node) return;
    const { height } = measureElement(node);
    const cache = heightCacheRef.current;

    // Record per-entry height estimates from the visible content. When
    // windowing is active, only visible entries are measured; non-visible
    // entries retain their last-known estimate. When total height is
    // available from the cache, use it for onMeasure (accurate for all
    // entries). Otherwise fall back to the raw measured height.
    const cacheTotal = cache.totalHeight();
    if (entries.length > 0 && height > 0) {
      const visibleCount = Math.min(entries.length, Math.max(1, Math.round(height / 3)));
      const estimatedPerEntry = Math.max(1, Math.round(height / visibleCount));
      for (const entry of entries) {
        cache.record(entry.id, estimatedPerEntry);
      }
    }
    const reportedHeight = cacheTotal > 0 ? cacheTotal : height;
    if (reportedHeight !== lastReported.current) {
      lastReported.current = reportedHeight;
      onMeasure(reportedHeight);
    }
    // onMeasure is stable (dispatch from useReducer) and node is a ref.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [onMeasure, entries.length, viewportRows, termWidth]);

  // Use cache-based total when available, fall back to the parent's totalLines.
  const cacheTotal = heightCacheRef.current.totalHeight();
  const scrollbarTotal = cacheTotal > 0 ? cacheTotal : totalLines;

  const vp = Math.max(1, viewportRows);

  // ── Virtual window computation ──────────────────────────────────────
  // When the cache has data and content exceeds the viewport, compute
  // which entries to render and how tall the spacers should be.
  const windowed = cacheTotal > 0 && entries.length > 0 && cacheTotal > vp;
  const win = windowed
    ? computeWindow(cacheTotal, vp, scrollOffset, entries.length, heightCacheRef.current)
    : null;

  // Slice for rendering — either the virtual window or all entries when
  // the cache hasn't been populated yet (first render).
  const shownEntries = win && win.windowed
    ? entries.slice(win.startIdx, win.endIdx)
    : entries;

  // Previously-hidden count — only relevant when windowing is active and
  // some entries were omitted from the rendered slice.
  const hiddenCount = win && win.windowed
    ? Math.max(0, entries.length - (win.endIdx - win.startIdx))
    : 0;

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
          flexShrink={0}
        >
          {/* Spacer above visible entries — represents entries scrolled off
              the top of the viewport. Present only during virtual windowing. */}
          {win && win.windowed && win.spacerAbove > 0 ? (
            <Box height={win.spacerAbove} flexShrink={0} />
          ) : null}

          {/* Fallback hidden-count summary — shown when windowing omits
              off-screen entries from the rendered slice. */}
          {hiddenCount > 0 ? (
            <Box flexShrink={0}>
              <Text dimColor italic>
                {`  ↑ ${hiddenCount} earlier ${hiddenCount === 1 ? 'entry' : 'entries'} (scroll up to view)`}
              </Text>
            </Box>
          ) : null}

          {/* Visible entries */}
          {shownEntries.map((entry) => (
            <Box key={entry.id} marginBottom={entry.kind === 'turn-summary' ? 1 : 0} flexShrink={0}>
              <Entry entry={entry} termWidth={termWidth} setSuggestions={setSuggestions} autonomyMode={autonomyMode} todos={todos} showModelReasoning={showModelReasoning} />
            </Box>
          ))}

          {/* Spacer below visible entries — represents entries below the
              viewport (streaming tails sit below this spacer so they are
              always pinned to the bottom of the viewport). */}
          {win && win.windowed && win.spacerBelow > 0 ? (
            <Box height={win.spacerBelow} flexShrink={0} />
          ) : null}

          {/* Streaming tails — always at the bottom of the viewport.
              justifyContent="flex-end" on the parent pins the last child
              to the bottom edge, so these stay visible regardless of
              how far the user has scrolled up. */}
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
      <Scrollbar rows={vp} offset={Math.max(0, scrollOffset)} total={scrollbarTotal} />
    </Box>
  );
});

// Re-exported for convenience so app.tsx can import both from one module.
export type { HistoryEntry };
