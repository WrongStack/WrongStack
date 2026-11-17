import type React from 'react';
import type { SlashCommandMatch } from '../app-state.js';
import { useActiveTheme } from '../hooks/use-active-theme.js';
import { useTerminalSize } from '../hooks/use-terminal-size.js';
import { Box, Text } from '../ink.js';
import { theme } from '../theme.js';
import { commandListWindow } from './command-list-window.js';
import { CompactPicker } from './compact-picker.js';
import { pickerViewport } from './picker-viewport.js';

interface SlashMenuProps {
  query: string;
  matches: SlashCommandMatch[];
  selected: number;
  maxRows?: number | undefined;
  columns?: number | undefined;
}

export function SlashMenu({
  query,
  matches,
  selected,
  maxRows,
  columns,
}: SlashMenuProps): React.ReactElement {
  useActiveTheme();
  const terminal = useTerminalSize({ maxWidth: columns, allowZero: true });
  const viewport = pickerViewport(terminal, { columns, maxRows, reservedRows: 6 });
  const budget = viewport.rows;
  const compact = budget < 12;
  const minimal = budget < 6;
  // Borders, title, optional subtitle and keyboard hint all share the same budget.
  const chrome = 3 + (minimal ? 0 : 1) + (compact ? 0 : 1);
  const visible = commandListWindow(matches, selected, Math.min(8, budget - chrome));
  const resultMeta = matches.length ? `${visible.focus + 1}/${matches.length}` : 'no matches';
  if (viewport.compact) {
    return (
      <CompactPicker
        label={matches[visible.focus]?.name}
        emptyLabel="No matching commands"
        position={resultMeta}
        columns={viewport.columns}
        rows={budget}
        context={matches[visible.focus]?.description}
        action="run"
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
      <Text bold color={theme.accent} wrap="truncate-end">
        {minimal ? 'Commands · Esc' : viewport.columns < 50 ? 'Commands' : 'Command palette'}{' '}
        <Text color={theme.textSecondary}>
          /{query} ({resultMeta})
        </Text>
      </Text>
      {!compact ? (
        <Text color={theme.textSecondary} wrap="truncate-end">
          Type to filter commands by name, alias, or description.
        </Text>
      ) : null}
      {visible.rows.map((row, index) =>
        row.type === 'header' ? (
          <Text
            key={`cat-${row.category}-${index}`}
            bold
            color={theme.brandAccent}
            wrap="truncate-end"
          >
            {' '}
            {row.category}
          </Text>
        ) : (
          <Text
            key={row.item.name}
            wrap="truncate-end"
            inverse={row.index === visible.focus}
            color={row.index === visible.focus ? theme.accent : theme.textPrimary}
          >
            {row.index === visible.focus ? '› ' : '  '}
            <Text bold>{row.item.name}</Text>
            {row.item.argsHint ? <Text> {row.item.argsHint}</Text> : null}
            {row.item.matchedAlias ? <Text> alias /{row.item.matchedAlias}</Text> : null}
            <Text color={row.index === visible.focus ? undefined : theme.textSecondary}>
              {' '}
              — {row.item.description}
            </Text>
          </Text>
        ),
      )}
      {matches.length === 0 ? (
        <Text color={theme.textSecondary} wrap="truncate-end">
          No matching commands · try another name or alias.
        </Text>
      ) : null}
      {!minimal ? (
        <Text color={theme.textSecondary} wrap="truncate-end">
          {viewport.columns < 50
            ? '↑↓ · Enter · Tab · Esc'
            : '↑↓ · Enter run · Tab fill · Esc close'}
        </Text>
      ) : null}
    </Box>
  );
}
