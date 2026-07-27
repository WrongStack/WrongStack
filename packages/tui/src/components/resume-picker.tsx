import { Box, Text } from '../ink.js';
import type React from 'react';
import type { ResumeSessionEntry } from '../app-state.js';

export interface ResumePickerProps {
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
 */
export function ResumePicker({
  sessions,
  selected,
  busy,
  error,
  hint,
}: ResumePickerProps): React.ReactElement {
  return (
    <Box flexDirection="column" borderStyle="round" borderColor="cyan" paddingX={1}>
      <Text color="cyan" bold>
        ━━ Resume Session ━━
      </Text>
      <Text dimColor>
        {busy ? 'Resuming selected session…' : '↑/↓ navigate · Enter select · Esc cancel'}
      </Text>
      {error ? <Text color="red">{error}</Text> : null}
      {sessions.length === 0 && !busy ? (
        <Text dimColor>No sessions found.</Text>
      ) : (
        sessions.map((s, i) => {
          const isCurrent = s.isCurrent;
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
                dimColor={isCurrent ?? false}
                {...(isSelected ? { color: isCurrent ? 'gray' : 'cyan' } : {})}
              >
                {isSelected ? '› ' : '  '}
                <Text bold dimColor={isCurrent ?? false}>{displayName}</Text>
                {isCurrent ? <Text dimColor> (current)</Text> : null}
                <Text dimColor> · {s.id} · {date}</Text>
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
        })
      )}
      {hint ? <Text color="yellow">{hint}</Text> : null}
    </Box>
  );
}
