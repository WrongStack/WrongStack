import type React from 'react';
import { Box, Text } from '../ink.js';

export interface PromptPickEntry {
  slug: string;
  title: string;
  description: string;
  category: string;
  source: string;
  content: string;
  favorite: boolean;
}

const MAX_VISIBLE = 12;

function getVisibleWindow(selected: number, total: number): { start: number; end: number } {
  const half = Math.floor(MAX_VISIBLE / 2);
  let start = selected - half;
  let end = start + MAX_VISIBLE;
  if (start < 0) {
    start = 0;
    end = Math.min(total, MAX_VISIBLE);
  }
  if (end > total) {
    end = total;
    start = Math.max(0, end - MAX_VISIBLE);
  }
  return { start, end };
}

/**
 * Apply the picker's category filter. catIndex 0 (= "all") returns everything;
 * "★ favorites" filters by the favorite flag; "🕘 recent" orders by the
 * recently-used slug list (most-recent first).
 */
export function filterPromptPicker(
  all: PromptPickEntry[],
  categories: string[],
  catIndex: number,
  recentSlugs: string[] = [],
): PromptPickEntry[] {
  const cat = categories[catIndex];
  if (!cat || cat === 'all') return all;
  if (cat === '★ favorites') return all.filter((e) => e.favorite);
  if (cat === '🕘 recent') {
    const bySlug = new Map(all.map((e) => [e.slug, e]));
    return recentSlugs.map((s) => bySlug.get(s)).filter((e): e is PromptPickEntry => Boolean(e));
  }
  return all.filter((e) => e.category === cat);
}

function glyph(source: string): string {
  return source === 'project' ? '📁' : source === 'user' ? '👤' : source === 'synced' ? '☁' : '📦';
}

export interface PromptPickerProps {
  /** Already-filtered entries for the active category. */
  entries: PromptPickEntry[];
  selected: number;
  category: string;
  total: number;
  columns?: number | undefined;
  maxRows?: number | undefined;
}

/**
 * Prompt library picker overlay (opened by a bare `/prompt` in the TUI).
 * Presentational only — navigation/category/selection state lives in the
 * reducer; Enter sets the input buffer to the chosen prompt's content (with
 * any `{{variables}}` left in place for the user to fill inline).
 */
export function PromptPicker({
  entries,
  selected,
  category,
  total,
  columns = 0,
  maxRows,
}: PromptPickerProps): React.ReactElement {
  const { start, end } = getVisibleWindow(selected, entries.length);
  const focused = entries[Math.max(0, Math.min(selected, entries.length - 1))];
  const longest = entries.reduce((value, entry) => Math.max(value, entry.title.length), 0);
  const listWidth = Math.max(36, Math.min(56, longest + 10));
  const split =
    columns >= listWidth + 43 && Boolean(focused) && (maxRows === undefined || maxRows >= 11);
  const list = (
    <Box
      flexDirection="column"
      borderStyle="round"
      borderColor="cyan"
      paddingX={1}
      {...(split ? { width: listWidth, flexShrink: 0 } : {})}
    >
      <Text color="cyan" bold>
        ━━ Prompt library · {category} ({entries.length}/{total}) ━━
      </Text>
      <Text dimColor>
        ↑/↓ navigate · ←/→ category · Enter insert · f favorite · e edit · Esc cancel
      </Text>
      {entries.length === 0 ? (
        <Text dimColor>No prompts in this category.</Text>
      ) : (
        entries.slice(start, end).map((e, i) => {
          const idx = start + i;
          const isSel = idx === selected;
          return (
            <Text key={e.slug} inverse={isSel} {...(isSel ? { color: 'cyan' } : {})}>
              {isSel ? '› ' : '  '}
              {glyph(e.source)} {e.favorite ? '★ ' : ''}
              <Text bold>{e.title}</Text>{' '}
              {split ? null : <Text dimColor>{e.description.slice(0, 52)}</Text>}
            </Text>
          );
        })
      )}
    </Box>
  );
  if (!split || !focused) return list;
  const contentLimit = Math.max(160, ((maxRows ?? 15) - 10) * 72);
  return (
    <Box flexDirection="row">
      {list}
      <Box flexDirection="column" borderStyle="round" borderColor="cyan" paddingX={1} flexGrow={1}>
        <Text color="cyan" bold wrap="truncate-end">
          {focused.title}
        </Text>
        <Text wrap="wrap">{focused.description || '(no description)'}</Text>
        <Text> </Text>
        <Text wrap="truncate-end">
          <Text dimColor>slug: </Text>
          {focused.slug}
        </Text>
        <Text wrap="truncate-end">
          <Text dimColor>category: </Text>
          {focused.category}
        </Text>
        <Text wrap="truncate-end">
          <Text dimColor>source: </Text>
          {focused.source}
        </Text>
        <Text wrap="truncate-end">
          <Text dimColor>favorite: </Text>
          {focused.favorite ? 'yes' : 'no'}
        </Text>
        <Text> </Text>
        <Text dimColor>preview</Text>
        <Text wrap="wrap">{truncate(focused.content, contentLimit)}</Text>
      </Box>
    </Box>
  );
}

function truncate(value: string, max: number): string {
  return value.length <= max ? value : `${value.slice(0, max - 1)}…`;
}
