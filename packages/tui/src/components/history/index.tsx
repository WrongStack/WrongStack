import { Box, Static, useStdout } from '../../ink.js';
import type React from 'react';
import { memo, useEffect, useState } from 'react';
import { AssistantTail } from './assistant.js';
import { Entry } from './entry.js';
import { MAX_STREAM_DISPLAY_CHARS, tailForDisplay } from './utils.js';
import type { HistoryProps } from './types.js';

// ── Re-exports ──

export type { HistoryEntry, HistoryProps } from './types.js';
export type { BodySegment } from './types.js';
export { Banner } from './banner.js';
export {
  CodeBlock,
  DiffBlock,
  DiffFileBlock,
  type DiffFilePreview,
  type DiffLineKind,
  type DiffLineRow,
  type DiffPreview,
  type MultiDiffSummary,
  MULTI_DIFF_SUMMARY_THRESHOLD,
  extractDiffPreview,
  extractMultiFileDiffs,
  extractReplaceDiffs,
  formatDiffStats,
  formatMultiDiffSummary,
  parseUnifiedDiff,
  summarizeMultiFileDiffs,
} from './code-block.js';
export { Entry } from './entry.js';
export { MESSAGE_PANEL_BORDER_WIDTH, MESSAGE_PANEL_CHROME_WIDTH, MESSAGE_PANEL_MARGIN, AssistantBody, AssistantTail, assistantContentWidth, assistantTailRows, splitFencedBlocks } from './assistant.js';
export {
  shortenPath,
  previewArgs,
  previewOutput,
  fmtTok,
  fmtDuration,
  fmtBytes,
  truncMid,
  stringOf,
  numOf,
  tryParseJson,
  scanNumberedRange,
  countLines,
  firstNonEmpty,
  formatMatchHit,
  formatToolArgs,
  formatToolOutput,
  formatToolVisualOutput,
  type ToolVisualLine,
  type ToolVisualLineKind,
  ToolOutputLines,
  ToolStreamBox,
  streamBoxRows,
  MAX_STREAM_DISPLAY_CHARS,
  tailForDisplay,
} from './utils.js';

// ── History Component ──

/**
 * History component — renders committed entries via <Static> so they
 * flow into terminal scrollback, plus a live streaming assistant tail.
 *
 * Wrapped in `React.memo` so keystrokes in the input buffer (which
 * change `state.buffer`/`state.cursor` in the same reducer) don't
 * trigger an expensive full-history re-render. All props are either
 * primitives or stable reducer references, so default shallow
 * comparison is sufficient.
 */
export const History = memo(function History({ entries, generation, streamingText, toolStream, setSuggestions, autonomyMode, multiDiffSummaryThreshold, todos }: HistoryProps): React.ReactElement {
  const { stdout } = useStdout();
  const [termSize, setTermSize] = useState({
    columns: stdout?.columns ?? 80,
    rows: stdout?.rows ?? 24,
  });
  useEffect(() => {
    const handleResize = () => {
      setTermSize({ columns: stdout?.columns ?? 80, rows: stdout?.rows ?? 24 });
    };
    process.stdout.on('resize', handleResize);
    return () => {
      process.stdout.off('resize', handleResize);
    };
  }, [stdout]);
  const termWidth = termSize.columns;
  const tail = streamingText ? tailForDisplay(streamingText, MAX_STREAM_DISPLAY_CHARS) : '';

  // NOTE: the live tool-stream box (◆ <tool> ⏱ … + last N output lines) is
  // deliberately NOT rendered in inline mode. In a full terminal the live
  // region sits at the bottom edge, so every tool.progress re-render scrolls
  // the screen by a line and strands the box's top row (the "◆ bash ⏱ Xs"
  // header) permanently in native scrollback — the user sees the header
  // stacked dozens of times. Ink can't avoid this without owning the screen,
  // so the live tail belongs to the managed (alt-screen) ScrollableHistory
  // path only. Inline users still get a live "running: <tool> Xs" chip in the
  // status bar while it runs, and the full output as a committed entry when it
  // finishes — `toolStream` is intentionally unused here.
  void toolStream;

  return (
    <>
      <Static key={`${generation ?? 0}-w${termWidth}`} items={entries}>
        {(entry) => (
          <Box key={entry.id} marginBottom={entry.kind === 'turn-summary' ? 1 : 0}>
            <Entry entry={entry} termWidth={termWidth} setSuggestions={setSuggestions} autonomyMode={autonomyMode} multiDiffSummaryThreshold={multiDiffSummaryThreshold} todos={todos} />
          </Box>
        )}
      </Static>
      {/*
        flexGrow anchor — always present so Ink's layout engine has a live
        node at the history / bottom-area boundary. Without this, <Static>
        bypasses the virtual screen and when a tall overlay (SettingsPicker)
        unmounts the reclaimed space is not cleared, leaving ghost text.
      */}
      <Box flexGrow={1}>
        {tail ? <AssistantTail text={tail} termWidth={termWidth} /> : null}
      </Box>
    </>
  );
});
