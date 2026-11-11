import type React from 'react';
import type { ResumeSessionEntry } from '../app-state.js';
import { useWindowedPicker } from '../hooks/use-windowed-picker.js';
import { Box, Text } from '../ink.js';

interface ResumePickerProps {
  sessions: ResumeSessionEntry[];
  selected: number;
  busy: boolean;
  error?: string | undefined;
  hint?: string | undefined;
  /**
   * Measured vertical budget for the whole picker box (terminal rows minus
   * status bar, input, and margins — see `pickerMaxRows` in app-view.tsx).
   * When provided the window math uses it instead of the legacy
   * `rows - shellReservedRows` guess, which reserved less than the real
   * status bar + input bar chrome — the resume panel could then grow past
   * the terminal on ordinary session counts.
   */
  maxRows?: number | undefined;
}

/**
 * Interactive session-resume picker. Renders a scrollable list of recent
 * sessions with metadata (id, date, tokens, tools, outcome badge) so the user
 * can pick one to resume. The current session is grayed out and non-selectable.
 *
 * Windowed via {@link useWindowedPicker} with `rowSpan=3` — each session takes
 * three rows (title line, meta line, preview line). The window auto-recenters
 * on the focused session so 30+ entries stay navigable on a 24-row terminal.
 */
export function ResumePicker({
  sessions,
  selected,
  busy,
  error,
  hint,
  maxRows,
}: ResumePickerProps): React.ReactElement {
  const compact = maxRows !== undefined && maxRows < 12;
  // Each session occupies 3 visual rows (title + meta + preview). The window
  // is sized against the caller's measured `maxRows` budget when provided;
  // the legacy `rows - 10` guess under-reserved the real status bar + input
  // bar chrome, so the panel overflowed the terminal. `markerRows` = 2 scroll
  // markers + 1 conditional hint/error row — worst case, so the window never
  // overflows whether or not those rows actually render.
  const { start, end, hasAbove, hasBelow } = useWindowedPicker({
    total: sessions.length,
    selected,
    rowSpan: compact ? 1 : 3,
    chromeRows: 4,
    markerRows: 2 + Number(Boolean(error)) + Number(Boolean(hint)),
    maxRows,
  });
  const visibleSessions = sessions.slice(start, end);
  return (
    <Box flexDirection="column" borderStyle="round" borderColor="cyan" paddingX={1}>
      <Text color="cyan" bold>
        ━━ Resume Session ━━
      </Text>
      <Text dimColor wrap="truncate-end">
        {busy
          ? 'Resuming selected session…'
          : // Position and total, because the list is windowed: three rows per
            // session means most of it is off-screen at any moment, and without
            // a count a scrollable list of 200 is indistinguishable from the
            // page of 20 this picker used to be handed.
            compact
            ? '↑↓ · Enter select · Esc cancel'
            : `${sessions.length > 0 ? `${selected + 1}/${sessions.length} · ` : ''}↑/↓ navigate · Enter select · Esc cancel`}
      </Text>
      {error ? (
        <Text color="red" wrap="truncate-end">
          {error}
        </Text>
      ) : null}
      {sessions.length === 0 && !busy ? (
        <Text dimColor>No sessions found.</Text>
      ) : (
        <>
          {hasAbove ? <Text dimColor> … {start} more above</Text> : null}
          {visibleSessions.map((s, j) => {
            const i = start + j;
            const isCurrent = s.isCurrent;
            // Owned by another process right now. Rendered like `isCurrent` —
            // dimmed and labelled — because it is unselectable for the same
            // reason: you cannot resume a journal something else is writing.
            const live = s.live;
            const isSelected = i === selected;
            const date = (s.lastActivityAt ?? s.startedAt).slice(0, 16).replace('T', ' ');
            const displayName = s.name?.trim() || s.title || s.id;
            const contentPreview = s.lastUserMessage?.trim();
            const outcomeBadge =
              s.outcome === 'completed'
                ? '✓ '
                : s.outcome === 'aborted'
                  ? '⚠ '
                  : s.outcome === 'error'
                    ? '✗ '
                    : s.outcome === 'timeout'
                      ? '⏱ '
                      : '  ';
            const toolStr =
              s.toolCallCount > 0
                ? `${s.toolCallCount} tool${s.toolCallCount === 1 ? '' : 's'}`
                : '';
            const iterStr =
              s.iterationCount > 0
                ? `${s.iterationCount} iter${s.iterationCount === 1 ? '' : 's'}`
                : '';

            return (
              <Box key={s.id} flexDirection="column">
                <Text
                  wrap="truncate-end"
                  inverse={isSelected}
                  dimColor={(isCurrent ?? false) || live !== undefined}
                  {...(isSelected ? { color: isCurrent || live ? 'gray' : 'cyan' } : {})}
                >
                  {isSelected ? '› ' : '  '}
                  {s.treePrefix ? <Text dimColor>{s.treePrefix}</Text> : null}
                  {s.worktree ? (
                    <Text color="magenta">
                      [{s.worktree.name}
                      {s.worktree.branch && s.worktree.branch !== s.worktree.name
                        ? ` · ${s.worktree.branch}`
                        : ''}
                      ]{' '}
                    </Text>
                  ) : null}
                  <Text bold dimColor={(isCurrent ?? false) || live !== undefined}>
                    {displayName}
                  </Text>
                  {isCurrent ? <Text dimColor> (current)</Text> : null}
                  {!isCurrent && live ? (
                    <Text color="yellow">
                      {' '}
                      ● open in {live.clientType ?? 'another wstack'} (pid {live.pid})
                    </Text>
                  ) : null}
                  <Text dimColor>
                    {' '}
                    · {s.id} · {date}
                  </Text>
                </Text>
                {!compact ? (
                  <Text dimColor wrap="truncate-end">
                    {isSelected ? '   ' : '   '}
                    {outcomeBadge}
                    {s.tokenTotal.toLocaleString()} tok
                    {(s.messageCount ?? 0) > 0 ? ` · ${s.messageCount} msg` : ''}
                    {(s.branchCount ?? 0) > 1
                      ? ` · ⎇ ${s.branchCount} branches${s.activeBranchName ? ` (${s.activeBranchName})` : ''}`
                      : ''}
                    {toolStr ? ` · ${toolStr}` : ''}
                    {iterStr ? ` · ${iterStr}` : ''}
                    {s.toolErrorCount > 0 ? (
                      <Text color="yellow"> · {s.toolErrorCount} err</Text>
                    ) : null}
                  </Text>
                ) : null}
                {!compact ? (
                  <Text dimColor wrap="truncate-end">
                    {isSelected ? '   ' : '   '}
                    {(contentPreview ?? s.title).length > 72
                      ? `${(contentPreview ?? s.title).slice(0, 71)}…`
                      : (contentPreview ?? s.title)}
                  </Text>
                ) : null}
              </Box>
            );
          })}
          {hasBelow ? <Text dimColor> … {sessions.length - end} more below</Text> : null}
        </>
      )}
      {hint ? (
        <Text color="yellow" wrap="truncate-end">
          {hint}
        </Text>
      ) : null}
    </Box>
  );
}
