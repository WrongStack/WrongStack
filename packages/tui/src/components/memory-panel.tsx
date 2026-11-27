import type { MemoryEntry, MemoryScope } from '@wrongstack/contracts/types';
import type React from 'react';
import { useWindowedPicker } from '../hooks/use-windowed-picker.js';
import { Box, Text } from '../ink.js';
import { theme } from '../theme.js';

interface MemoryPanelProps {
  entries: MemoryEntry[];
  selected: number;
  filter: string;
  busy: boolean;
  hint?: string | undefined;
  maxRows?: number | undefined;
  columns?: number | undefined;
}

const SCOPE_SHORT: Record<MemoryScope, string> = {
  'project-agents': 'agents',
  'project-memory': 'proj',
  'user-memory': 'user',
};

function scopeColor(scope: MemoryScope): 'blue' | 'cyan' | 'magenta' {
  switch (scope) {
    case 'project-agents':
      return 'magenta';
    case 'project-memory':
      return 'cyan';
    case 'user-memory':
      return 'blue';
  }
}

/**
 * Browse-only interactive memory list. Opened by bare `/memory`; the text
 * subcommands (`remember`, `delete`, `--tag`, …) keep their canonical output.
 * Windowed like the other pickers so a short viewport never overflows.
 */
export function MemoryPanel({
  entries,
  selected,
  filter,
  busy,
  hint,
  maxRows,
  columns = 100,
}: MemoryPanelProps): React.ReactElement {
  const { start, end, hasAbove, hasBelow } = useWindowedPicker({
    total: entries.length,
    selected,
    maxRows,
    chromeRows: 4,
    markerRows: 2 + (hint ? 1 : 0),
  });
  const meta = `${entries.length} entr${entries.length === 1 ? 'y' : 'ies'}${busy ? ' · loading…' : ''}`;

  return (
    <Box flexDirection="column" borderStyle="round" borderColor={theme.brand} paddingX={1}>
      <Text color={theme.brand} bold wrap="truncate-end">
        ━━ Memory ━━ <Text dimColor>{meta}</Text>
      </Text>
      <Text dimColor wrap="truncate-end">
        {columns < 100
          ? '↑↓ move · type to filter · Esc close'
          : `filter: ${filter || '(none)'} · ↑/↓ move · type to filter · Backspace edit · Esc close`}
      </Text>
      {entries.length === 0 ? (
        <Text dimColor>{busy ? 'Loading memory…' : 'No memories match.'}</Text>
      ) : (
        entries.slice(start, end).map((entry, offset) => {
          const i = start + offset;
          const tags = entry.tags?.length ? `  #${entry.tags.join(' #')}` : '';
          return (
            <Text
              key={`${entry.scope}-${entry.ts}-${i}`}
              inverse={i === selected}
              wrap="truncate-end"
              {...(i === selected ? { color: theme.brand } : {})}
            >
              {i === selected ? '› ' : '  '}
              <Text color={scopeColor(entry.scope)}>[{SCOPE_SHORT[entry.scope]}]</Text>
              <Text> {entry.text}</Text>
              {tags ? <Text dimColor>{tags}</Text> : null}
            </Text>
          );
        })
      )}
      {hasAbove || hasBelow ? (
        <Text dimColor>{`${start + 1}–${end}/${entries.length}`}</Text>
      ) : null}
      {hint ? (
        <Text color={theme.warn} wrap="truncate-end">
          {hint}
        </Text>
      ) : null}
    </Box>
  );
}
