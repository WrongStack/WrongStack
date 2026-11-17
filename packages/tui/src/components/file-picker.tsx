import type React from 'react';
import { useActiveTheme } from '../hooks/use-active-theme.js';
import { useTerminalSize } from '../hooks/use-terminal-size.js';
import { useWindowedPicker } from '../hooks/use-windowed-picker.js';
import { Box, Text } from '../ink.js';
import { sanitizeTerminalText, truncateDisplayStart } from '../terminal-width.js';
import { theme } from '../theme.js';
import { CompactPicker } from './compact-picker.js';
import { pickerViewport } from './picker-viewport.js';

export interface FilePickerProps {
  query: string;
  matches: string[];
  selected: number;
  maxRows?: number | undefined;
  columns?: number | undefined;
}

export function FilePicker({
  query,
  matches,
  selected,
  maxRows,
  columns,
}: FilePickerProps): React.ReactElement {
  useActiveTheme();
  const terminal = useTerminalSize({ maxWidth: columns, allowZero: true });
  const viewport = pickerViewport(terminal, { columns, maxRows, reservedRows: 6 });
  const budget = viewport.rows;
  const minimal = budget < 6;
  const focus = Math.max(0, Math.min(selected, matches.length - 1));
  const { start, end } = useWindowedPicker({
    total: matches.length,
    selected: focus,
    maxRows: budget,
    chromeRows: minimal ? 3 : 4,
    minVisible: 1,
  });
  if (viewport.compact) {
    return (
      <CompactPicker
        label={matches[focus]}
        emptyLabel="no matches"
        position={matches.length ? `${focus + 1}/${matches.length}` : 'no matches'}
        columns={viewport.columns}
        rows={budget}
        context={`@${query || '…'}`}
        action="attach"
        preserveEnd
      />
    );
  }
  return (
    <Box
      flexDirection="column"
      width={viewport.columns}
      borderStyle="round"
      borderColor={theme.borderActive}
      paddingX={1}
    >
      <Text color={theme.textSecondary} wrap="truncate-end">
        {minimal ? 'Esc · ' : ''}@{query || '…'} ·{' '}
        {matches.length ? `${focus + 1}/${matches.length}` : 'no matches'}
      </Text>
      {matches.length === 0 ? (
        <Text color={theme.textSecondary} wrap="truncate-end">
          Try a different file name or path.
        </Text>
      ) : null}
      {matches.slice(start, end).map((path, index) => {
        const active = start + index === focus;
        // Keep the distinguishing filename, not just the common directory prefix.
        const label = truncateDisplayStart(
          sanitizeTerminalText(path).replace(/\n/g, ' '),
          Math.max(1, viewport.columns - 6),
        );
        const match = query ? label.toLowerCase().indexOf(query.toLowerCase()) : -1;
        return (
          <Text
            key={path}
            wrap="truncate-end"
            inverse={active}
            color={active ? theme.accent : theme.textPrimary}
          >
            {active ? '› ' : '  '}
            {match < 0 ? (
              label
            ) : (
              <>
                {label.slice(0, match)}
                <Text bold underline>
                  {label.slice(match, match + query.length)}
                </Text>
                {label.slice(match + query.length)}
              </>
            )}
          </Text>
        );
      })}
      {!minimal ? (
        <Text color={theme.textSecondary} wrap="truncate-end">
          ↑↓ · Enter attach · Esc cancel
        </Text>
      ) : null}
    </Box>
  );
}
