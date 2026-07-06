import { Box, Text, useStdout } from '../ink.js';
import type React from 'react';

export interface HelpEntry {
  name: string;
  description: string;
  category: string;
  aliases?: string[] | undefined;
  argsHint?: string | undefined;
}

export interface HelpPanelProps {
  entries: HelpEntry[];
  filter: string;
  selected: number;
  hint?: string | undefined;
}

const CATEGORY_ORDER = ['Run', 'Session', 'Inspect', 'Agent', 'Config', 'App'];

type Row =
  | { type: 'header'; category: string }
  | { type: 'item'; entry: HelpEntry; index: number };

const CHROME_ROWS = 7;

function normalizeQuery(raw: string): string {
  return raw.trim().toLowerCase();
}

function buildRows(entries: HelpEntry[]): Row[] {
  const rows: Row[] = [];
  let lastCat = '';
  for (let i = 0; i < entries.length; i++) {
    const e = entries[i] as HelpEntry;
    const cat = e.category || 'App';
    if (cat !== lastCat) {
      lastCat = cat;
      rows.push({ type: 'header', category: cat });
    }
    rows.push({ type: 'item', entry: e, index: i });
  }
  return rows;
}

function windowRows(rows: Row[], focus: number, max: number) {
  if (rows.length <= max) {
    return { rows, start: 0, end: rows.length, contextHeader: null as string | null };
  }
  let start = focus - Math.floor(max / 2);
  if (start < 0) start = 0;
  let end = start + max;
  if (end > rows.length) {
    end = rows.length;
    start = end - max;
  }
  let contextHeader: string | null = null;
  if (start > 0) {
    const first = rows[start];
    if (first && first.type === 'item') {
      for (let i = start - 1; i >= 0; i--) {
        const r = rows[i];
        if (r && r.type === 'header') {
          contextHeader = r.category;
          break;
        }
      }
    }
  }
  return { rows: rows.slice(start, end), start, end, contextHeader };
}

export function HelpPanel({
  entries,
  filter,
  selected,
  hint,
}: HelpPanelProps): React.ReactElement {
  const { stdout } = useStdout();
  const termRows = stdout?.rows ?? 24;
  const maxVisible = Math.max(6, termRows - CHROME_ROWS);

  const query = normalizeQuery(filter);
  const filtered = query
    ? entries.filter(
        (e) =>
          e.name.toLowerCase().includes(query) ||
          e.description.toLowerCase().includes(query) ||
          e.category.toLowerCase().includes(query) ||
          (e.aliases ?? []).some((a) => a.toLowerCase().includes(query)),
      )
    : entries;

  // Sort filtered by category order then name
  filtered.sort((a, b) => {
    const ai = CATEGORY_ORDER.indexOf(a.category);
    const bi = CATEGORY_ORDER.indexOf(b.category);
    if (ai !== bi) return ai - bi;
    return a.name.localeCompare(b.name);
  });

  const rows = buildRows(filtered);
  const focus = Math.min(selected, Math.max(0, filtered.length - 1));

  // Find the row index in `rows` that corresponds to the flat selected index
  const selectedRowIdx = rows.findIndex((r) => r.type === 'item' && r.index === focus);
  const win = windowRows(rows, selectedRowIdx < 0 ? 0 : selectedRowIdx, maxVisible);
  const { rows: visible, start, end, contextHeader } = win;
  const hiddenAbove = start;
  const hiddenBelow = rows.length - end;

  const hasFilter = query.length > 0;

  return (
    <Box flexDirection="column" borderStyle="round" borderColor="cyan" paddingX={1}>
      <Text bold color="cyan">
        ━━ Help / Command Palette ━━
      </Text>
      <Text dimColor>
        {hasFilter
          ? `Filter: ${filter} (${filtered.length} match${filtered.length === 1 ? '' : 'es'})`
          : '↑/↓ navigate · Enter run · Tab fill · type to filter · Esc close'}
      </Text>
      <Box marginTop={1} flexDirection="column">
        {filtered.length === 0 ? (
          <Text dimColor>No commands match "{filter}".</Text>
        ) : (
          <>
            {hiddenAbove > 0 && !hasFilter ? (
              <Text dimColor>{`  ↑ ${hiddenAbove} more`}</Text>
            ) : null}
            {contextHeader && !hasFilter ? (
              <Text bold color="yellow" dimColor>
                {'  '}{contextHeader}
              </Text>
            ) : null}
            {visible.map((row) => {
              if (row.type === 'header') {
                return (
                  <Text key={`cat-${row.category}`} bold color="yellow" dimColor>
                    {'  '}{row.category}
                  </Text>
                );
              }
              const { entry, index } = row;
              const isSelected = index === focus;
              return (
                <Text
                  key={entry.name}
                  inverse={isSelected}
                  {...(isSelected ? { color: 'cyan' } : {})}
                  wrap="truncate-end"
                >
                  {isSelected ? '› ' : '  '}
                  <Text bold>/{entry.name}</Text>
                  {entry.aliases && entry.aliases.length > 0 ? (
                    <Text dimColor> ({entry.aliases.map((a) => `/${a}`).join(', ')})</Text>
                  ) : null}
                  <Text dimColor> — {entry.description}</Text>
                  {entry.argsHint ? <Text dimColor> {entry.argsHint}</Text> : null}
                </Text>
              );
            })}
            {hiddenBelow > 0 && !hasFilter ? (
              <Text dimColor>{`  ↓ ${hiddenBelow} more`}</Text>
            ) : null}
          </>
        )}
      </Box>
      {hint ? (
        <Box marginTop={1}>
          <Text dimColor>{hint}</Text>
        </Box>
      ) : null}
    </Box>
  );
}
