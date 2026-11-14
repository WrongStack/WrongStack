import type React from 'react';
import wrapAnsi from 'wrap-ansi';
import { useActiveTheme } from '../hooks/use-active-theme.js';
import { useTerminalSize } from '../hooks/use-terminal-size.js';
import { Box, Text } from '../ink.js';
import { displayWidth, sanitizeTerminalText, truncateDisplay } from '../terminal-width.js';
import { theme } from '../theme.js';
import { commandListWindow } from './command-list-window.js';
import { CompactPicker } from './compact-picker.js';
import { pickerViewport } from './picker-viewport.js';

export interface HelpEntry {
  name: string;
  description: string;
  category: string;
  aliases?: string[] | undefined;
  argsHint?: string | undefined;
  help?: string | undefined;
}

export interface HelpPanelProps {
  entries: HelpEntry[];
  filter: string;
  selected: number;
  hint?: string | undefined;
  maxRows?: number | undefined;
  columns?: number | undefined;
  detailScroll?: number | undefined;
}

const CATEGORY_ORDER = ['Run', 'Session', 'Inspect', 'Agent', 'Config', 'App'];

function HelpDetail({
  entry,
  width,
  height,
  scroll,
}: {
  entry: HelpEntry | undefined;
  width: number;
  height: number;
  scroll: number;
}): React.ReactElement {
  if (!entry) return <Text color={theme.textSecondary}>Clear the filter to see all commands.</Text>;
  const text = entry.help || `Type /${entry.name} to run this command.`;
  // Scroll visual lines, not source lines: long paragraphs remain readable in a narrow pane.
  const lines = wrapAnsi(sanitizeTerminalText(text), Math.max(1, width), {
    hard: true,
    trim: false,
  }).split('\n');
  const capacity = Math.max(1, height - 4);
  const maxScroll = Math.max(0, lines.length - capacity);
  const offset = Math.max(0, Math.min(scroll, maxScroll));
  return (
    <Box flexDirection="column" width={width} height={height} overflowY="hidden" flexShrink={0}>
      <Text bold color={theme.accent} wrap="truncate-end">
        /{entry.name} [{entry.category || 'App'}]
        {entry.aliases?.length ? ` (${entry.aliases.map((a) => `/${a}`).join(', ')})` : ''}
      </Text>
      <Text wrap="truncate-end">
        <Text color={theme.success}>Usage: </Text>/{entry.name}
        {entry.argsHint ? ` ${entry.argsHint}` : ''}
      </Text>
      <Text bold wrap="truncate-end">
        {entry.description}
      </Text>
      <Box flexDirection="column" height={capacity} flexShrink={0}>
        {lines.slice(offset, offset + capacity).map((line, index) => (
          <Text key={offset + index} wrap="truncate-end" color={theme.textSecondary}>
            {line || ' '}
          </Text>
        ))}
      </Box>
      <Text color={theme.textSecondary} wrap="truncate-end">
        {maxScroll > 0
          ? `PgUp/PgDn · ${offset + 1}–${Math.min(lines.length, offset + capacity)}/${lines.length}`
          : ' '}
      </Text>
    </Box>
  );
}

export function HelpPanel({
  entries,
  filter,
  selected,
  hint,
  maxRows,
  columns,
  detailScroll = 0,
}: HelpPanelProps): React.ReactElement {
  useActiveTheme();
  const terminal = useTerminalSize({ maxWidth: columns, fallbackRows: 24, fallbackColumns: 90 });
  const viewport = pickerViewport(terminal, { columns, maxRows, reservedRows: 4, rowCap: 26 });
  const width = viewport.columns;
  const contentWidth = Math.max(0, width - 4);
  const panelHeight = viewport.rows;
  const minimal = panelHeight < 7;
  const bodyHeight = Math.max(1, panelHeight - (minimal ? 3 : 5));
  const split = width >= 76 && bodyHeight >= 5;
  const showDetail = !minimal && (split || bodyHeight >= 9);
  const listHeight = showDetail && !split ? Math.max(1, Math.floor(bodyHeight * 0.35)) : bodyHeight;
  const detailHeight = split ? bodyHeight : bodyHeight - listHeight - 1;
  const listWidth = split ? Math.min(30, Math.floor(contentWidth * 0.34)) : contentWidth;
  const detailWidth = split ? contentWidth - listWidth - 3 : contentWidth;
  const query = filter.trim().toLowerCase();
  const filtered = entries.filter(
    (entry) =>
      !query ||
      [entry.name, entry.description, entry.category, ...(entry.aliases ?? [])].some((value) =>
        value.toLowerCase().includes(query),
      ),
  );
  filtered.sort((a, b) => {
    const rank = (category: string): number => {
      const index = CATEGORY_ORDER.indexOf(category);
      return index < 0 ? CATEGORY_ORDER.length : index;
    };
    return rank(a.category) - rank(b.category) || a.name.localeCompare(b.name);
  });
  const window = commandListWindow(filtered, selected, listHeight);
  const entry = filtered[window.focus];
  if (viewport.compact) {
    return (
      <CompactPicker
        label={entry ? `/${entry.name}` : undefined}
        emptyLabel="No commands match"
        position={entry ? `${window.focus + 1}/${filtered.length}` : 'no matches'}
        columns={width}
        rows={panelHeight}
        context={hint || entry?.description}
      />
    );
  }
  const closeHint = 'Esc close';
  const navigation = showDetail
    ? [
        '↑/↓ list · PgUp/PgDn scroll detail · Esc close',
        '↑↓ list · PgUp/Dn help · Esc close',
        '↑↓ · PgUp/Dn · Esc close',
      ]
    : ['↑/↓ list · Esc close', '↑↓ · Esc close'];
  // Closing stays discoverable even when a status hint consumes the footer.
  const footer = hint
    ? `${truncateDisplay(sanitizeTerminalText(hint).replace(/\n/g, ' '), Math.max(0, contentWidth - displayWidth(closeHint) - 3))} · ${closeHint}`
    : (navigation.find((line) => displayWidth(line) <= contentWidth) ?? closeHint);
  return (
    <Box
      flexDirection="column"
      borderStyle="round"
      borderColor={theme.borderActive}
      paddingX={1}
      width={width}
      height={panelHeight}
      flexShrink={0}
      overflowY="hidden"
    >
      <Text bold color={theme.accent} wrap="truncate-end">
        {minimal ? 'Help · Esc' : width < 50 ? 'Help' : 'Help / Command Palette'}
        <Text color={theme.textSecondary}>
          {' '}
          · {filtered.length ? `${window.focus + 1}/${filtered.length}` : 'no matches'}
        </Text>
      </Text>
      {!minimal ? (
        <Text color={theme.textSecondary} wrap="truncate-end">
          {query
            ? `Filter: ${filter} (${filtered.length} match${filtered.length === 1 ? '' : 'es'})`
            : 'Type to filter commands…'}
        </Text>
      ) : null}
      <Box flexDirection={split ? 'row' : 'column'} height={bodyHeight} flexShrink={0}>
        <Box
          flexDirection="column"
          width={listWidth}
          height={listHeight}
          flexShrink={0}
          overflowY="hidden"
        >
          {filtered.length === 0 ? (
            <Text color={theme.textSecondary} wrap="truncate-end">
              No commands match "{filter}".
            </Text>
          ) : null}
          {window.rows.map((row, index) =>
            row.type === 'header' ? (
              <Text
                key={`category-${row.category}-${index}`}
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
                inverse={row.index === window.focus}
                color={row.index === window.focus ? theme.accent : theme.textPrimary}
                wrap="truncate-end"
              >
                {row.index === window.focus ? '› ' : '  '}
                <Text bold>/{row.item.name}</Text>
                {!split ? <Text> — {row.item.description}</Text> : null}
              </Text>
            ),
          )}
        </Box>
        {showDetail ? (
          <>
            {split ? (
              <Box width={1} marginX={1} flexDirection="column" flexShrink={0}>
                {Array.from({ length: bodyHeight }, (_, index) => (
                  <Text key={index} color={theme.borderSubtle}>
                    │
                  </Text>
                ))}
              </Box>
            ) : (
              <Text color={theme.borderSubtle} wrap="truncate-end">
                {'─'.repeat(contentWidth)}
              </Text>
            )}
            <HelpDetail
              entry={entry}
              width={detailWidth}
              height={detailHeight}
              scroll={detailScroll}
            />
          </>
        ) : null}
      </Box>
      {!minimal ? (
        <Text color={theme.textSecondary} wrap="truncate-end">
          {footer}
        </Text>
      ) : null}
    </Box>
  );
}
