import type React from 'react';
import { memo, useRef } from 'react';
import { useTerminalSize } from '../../hooks/use-terminal-size.js';
import { Box, Static } from '../../ink.js';
import { Entry } from './entry.js';
import type { HistoryProps } from './types.js';

// ── Re-exports ──

export { AssistantBody, assistantContentWidth, MESSAGE_PANEL_BORDER_WIDTH, MESSAGE_PANEL_CHROME_WIDTH, splitFencedBlocks } from './assistant.js';;
export { Banner } from './banner.js';
export {
  CodeBlock,
  DiffBlock,
  DiffFileBlock,
  type DiffFilePreview,
  type DiffLineKind,
  type DiffLineRow,
  type DiffPreview,
  extractDiffPreview,
  extractMultiFileDiffs,
  extractReplaceDiffs,
  formatDiffStats,
  formatMultiDiffSummary,
  MULTI_DIFF_MAX_FILES,
  MULTI_DIFF_MAX_ROWS,
  MULTI_DIFF_SUMMARY_THRESHOLD,
  type MultiDiffSummary,
  parseUnifiedDiff,
  summarizeMultiFileDiffs,
} from './code-block.js';
export { Entry } from './entry.js';
export type { AutonomyAgentStatus, BodySegment, HistoryEntry, HistoryProps } from './types.js';
export { AssistantStreamBox, assistantStreamBoxHeight, countLines, firstNonEmpty, fmtBytes, fmtDuration, fmtTok, formatMatchHit, formatToolArgs, formatToolOutput, formatToolVisualOutput, MAX_STREAM_DISPLAY_CHARS, numOf, scanNumberedRange, shortenPath, streamBoxRows, stringOf, ToolOutputLines, ToolStreamBox, type ToolVisualLine, type ToolVisualLineKind, tailForDisplay, toolStreamBoxHeight, truncMid, tryParseJson } from './utils.js';

// ── History Component ──

/**
 * History component — renders committed entries via <Static> so they
 * flow into terminal scrollback.
 *
 * Wrapped in `React.memo` so keystrokes in the input buffer (which
 * change `state.buffer`/`state.cursor` in the same reducer) don't
 * trigger an expensive full-history re-render. All props are either
 * primitives or stable reducer references, so default shallow
 * comparison is sufficient.
 */
export const History = memo(function History({
  entries,
  generation,
  toolStream,
  setSuggestions,
  autonomyMode,
  multiDiffSummaryThreshold,
  todos,
  showModelReasoning,
  showSageMemoryInject,
}: HistoryProps): React.ReactElement {
  const termSize = useTerminalSize();
  const termWidth = termSize.columns;

  const presentationKey = `w${termWidth}-mr${showModelReasoning}`;
  const emissionRef = useRef<{
    generation: number;
    presentationKey: string;
    revision: number;
    ids: Set<number>;
    bannerSeen: boolean;
    omissionSeen: boolean;
  }>({
    generation: generation ?? 0,
    presentationKey,
    revision: 0,
    ids: new Set(),
    bannerSeen: false,
    omissionSeen: false,
  });
  if (emissionRef.current.generation !== (generation ?? 0)) {
    emissionRef.current = {
      generation: generation ?? 0,
      presentationKey,
      revision: 0,
      ids: new Set(),
      bannerSeen: false,
      omissionSeen: false,
    };
  } else if (emissionRef.current.presentationKey !== presentationKey) {
    // Committed transcript entries must be replayed at the new wrapping width or
    // reasoning visibility. Reset the per-emission dedup flags so the retained
    // transcript reflows once — including the FIRST banner (a resumed session's
    // banner reflows with the rest); the `bannerSeen` guard still collapses any
    // later duplicate banners to a single one within the replay.
    emissionRef.current.presentationKey = presentationKey;
    emissionRef.current.ids = new Set();
    emissionRef.current.bannerSeen = false;
    emissionRef.current.omissionSeen = false;
  }
  const pendingEntries: typeof entries = [];
  for (const entry of entries) {
    // Resumed transcripts can contain a historical banner as well as the
    // current session banner. Native scrollback should announce the session
    // once, so retain the first banner in each generation.
    if (entry.kind === 'banner' && emissionRef.current.bannerSeen) continue;
    // Retention replaces this exact negative-id info marker as the bounded
    // prefix moves. Native scrollback already contains the first marker.
    const isOmissionMarker =
      entry.id < 0 &&
      entry.kind === 'info' &&
      /^… \d+ earlier TUI entries omitted \(full session remains on disk\)\.$/.test(entry.text);
    if (isOmissionMarker && emissionRef.current.omissionSeen) continue;
    if (emissionRef.current.ids.has(entry.id)) continue;
    emissionRef.current.ids.add(entry.id);
    if (entry.kind === 'banner') emissionRef.current.bannerSeen = true;
    if (isOmissionMarker) emissionRef.current.omissionSeen = true;
    pendingEntries.push(entry);
  }
  if (pendingEntries.length > 0) emissionRef.current.revision++;
  // Bound the dedup set. `ids` remembers every entry ever emitted so it is not
  // re-written to native scrollback, but retention caps `entries` to ~400 — an
  // id no longer in `entries` has scrolled past retention and can never render
  // again, so it need not be remembered. Without this prune the set grows by one
  // number per message for the whole session (unbounded on 10h+ sessions). Only
  // runs when the set has outgrown the live window, and only deletes (never adds).
  if (emissionRef.current.ids.size > entries.length) {
    const liveIds = new Set<number>();
    for (const entry of entries) liveIds.add(entry.id);
    for (const id of emissionRef.current.ids) {
      if (!liveIds.has(id)) emissionRef.current.ids.delete(id);
    }
  }
  // Each revision remounts Static with only the new delta. Presentation changes
  // reset the emitted-id set above so the retained transcript is replayed once.
  const staticRevision = emissionRef.current.revision;
  const staticKey = `${generation ?? 0}-${staticRevision}-${presentationKey}`;
  const staticEntries = pendingEntries;

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
      <Static key={staticKey} items={staticEntries}>
        {(entry) => (
          <Box key={entry.id} marginBottom={entry.kind === 'turn-summary' ? 1 : 0}>
            <Entry
              entry={entry}
              termWidth={termWidth}
              termHeight={termSize.rows}
              setSuggestions={setSuggestions}
              autonomyMode={autonomyMode}
              multiDiffSummaryThreshold={multiDiffSummaryThreshold}
              todos={todos}
              showModelReasoning={showModelReasoning}
              showSageMemoryInject={showSageMemoryInject}
            />
          </Box>
        )}
      </Static>
      {/*
        flexGrow anchor — always present so Ink's layout engine has a live
        node at the history / bottom-area boundary. Without this, <Static>
        bypasses the virtual screen and when a tall overlay (SettingsPicker)
        unmounts the reclaimed space is not cleared, leaving ghost text.
      */}
      <Box flexGrow={1} />
    </>
  );
});
