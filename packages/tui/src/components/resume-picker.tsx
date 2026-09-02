import { Box, Text } from '../ink.js';
import type React from 'react';
import type { ResumeSessionEntry } from '../app-state.js';
import { useWindowedPicker } from '../hooks/use-windowed-picker.js';

interface ResumePickerProps {
  sessions: ResumeSessionEntry[];
  selected: number;
  busy: boolean;
  error?: string | undefined;
  hint?: string | undefined;
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
}: ResumePickerProps): React.ReactElement {
  // Each session occupies 3 visual rows (title + meta + preview). Tell the
  // hook that so a 24-row terminal reserves enough chrome for the 4-row
  // picker shell + input bar / status bar outside it.
  const { start, end, hasAbove, hasBelow } = useWindowedPicker({
    total: sessions.length,
    selected,
    rowSpan: 3,
    chromeRows: 4,
  });
  const visibleSessions = sessions.slice(start, end);
  return (
    <Box flexDirection="column" borderStyle="round" borderColor="cyan" paddingX={1}>
      <Text color="cyan" bold>
        ━━ Resume Session ━━
      </Text>
      <Text dimColor>
        {busy
          ? 'Resuming selected session…'
          : // Position and total, because the list is windowed: three rows per
            // session means most of it is off-screen at any moment, and without
            // a count a scrollable list of 200 is indistinguishable from the
            // page of 20 this picker used to be handed.
            `${sessions.length > 0 ? `${selected + 1}/${sessions.length} · ` : ''}↑/↓ navigate · Enter select · Esc cancel`}
      </Text>
      {error ? <Text color="red">{error}</Text> : null}
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
                  inverse={isSelected}
                  dimColor={(isCurrent ?? false) || live !== undefined}
                  {...(isSelected ? { color: isCurrent || live ? 'gray' : 'cyan' } : {})}
                >
                  {isSelected ? '› ' : '  '}
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
                <Text dimColor>
                  {isSelected ? '   ' : '   '}
                  {outcomeBadge}
                  {s.tokenTotal.toLocaleString()} tok
                  {(s.messageCount ?? 0) > 0 ? ` · ${s.messageCount} msg` : ''}
                  {toolStr ? ` · ${toolStr}` : ''}
                  {iterStr ? ` · ${iterStr}` : ''}
                  {s.toolErrorCount > 0 ? (
                    <Text color="yellow"> · {s.toolErrorCount} err</Text>
                  ) : null}
                </Text>
                <Text dimColor>
                  {isSelected ? '   ' : '   '}
                  {(contentPreview ?? s.title).length > 72
                    ? `${(contentPreview ?? s.title).slice(0, 71)}…`
                    : (contentPreview ?? s.title)}
                </Text>
              </Box>
            );
          })}
          {hasBelow ? <Text dimColor> … {sessions.length - end} more below</Text> : null}
        </>
      )}
      {hint ? <Text color="yellow">{hint}</Text> : null}
    </Box>
  );
}
