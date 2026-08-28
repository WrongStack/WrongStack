import type React from 'react';
import { useWindowedPicker } from '../hooks/use-windowed-picker.js';
import { Box, Text } from '../ink.js';
import { theme } from '../theme.js';
import type { ResourceMenuItem, ResourceMenuSnapshot } from '../ui-contracts.js';

interface ResourceMenuProps {
  snapshot: ResourceMenuSnapshot;
  selected: number;
  hint?: string | undefined;
  confirming?: string | undefined;
  filter?: string | undefined;
  filtering?: boolean | undefined;
  columns?: number | undefined;
  maxRows?: number | undefined;
}

/** Reusable two-pane browser for operational state exposed by slash commands. */
export function ResourceMenu({
  snapshot,
  selected,
  hint,
  confirming,
  filter = '',
  filtering = false,
  columns = 0,
  maxRows,
}: ResourceMenuProps): React.ReactElement {
  const items = filterResourceMenuItems(snapshot, filter);
  const longest = items.reduce((value, item) => Math.max(value, Array.from(item.label).length), 0);
  const listWidth = Math.max(30, Math.min(54, longest + 9));
  const split = columns >= listWidth + 43 && items.length > 0;
  const { start, end, hasAbove, hasBelow } = useWindowedPicker({
    total: items.length,
    selected,
    chromeRows: 4,
    markerRows: 3,
    maxRows,
  });
  const safeSelected = Math.max(0, Math.min(selected, items.length - 1));
  const focused = items[safeSelected];
  const visible = items.slice(start, end);
  const nameWidth = Math.max(1, listWidth - 9);

  const list = (
    <Box
      flexDirection="column"
      borderStyle="round"
      borderColor={theme.accent}
      paddingX={1}
      {...(split ? { width: listWidth, flexShrink: 0 } : {})}
    >
      <Text color={theme.accent} bold>
        ━━ {snapshot.title} {filter ? `· ${items.length}/${snapshot.items.length}` : ''} ━━
      </Text>
      <Text color={theme.textMuted}>
        {filtering
          ? `filter: ${filter || 'type to search'} · Enter done · Esc clear`
          : '↑/↓ inspect · / filter · action key/Enter · Esc close'}
      </Text>
      {hasAbove ? <Text color={theme.textMuted}> … {start} more above</Text> : null}
      {visible.map((item, offset) => {
        const index = start + offset;
        const active = index === safeSelected;
        const color = statusColor(item.status);
        return (
          <Text key={item.id} inverse={active} {...(active ? { color: theme.accent } : {})}>
            {active ? '› ' : '  '}
            <Text color={active ? undefined : color}>{statusGlyph(item.status)} </Text>
            <Text bold>{truncate(item.label, nameWidth).padEnd(nameWidth)}</Text>
            {!split && item.summary ? <Text dimColor> {truncate(item.summary, 48)}</Text> : null}
          </Text>
        );
      })}
      {hasBelow ? <Text color={theme.textMuted}> … {items.length - end} more below</Text> : null}
      {items.length === 0 ? (
        <Text color={theme.textMuted}>
          {filter ? `No matches for “${filter}”.` : (snapshot.emptyText ?? 'Nothing to show.')}
        </Text>
      ) : null}
      {confirming ? <Text color={theme.warn}>Run {confirming}? y confirm · n cancel</Text> : null}
      {!confirming && hint ? <Text color={theme.warn}>{hint}</Text> : null}
    </Box>
  );

  if (!split || !focused) return list;
  return (
    <Box flexDirection="row">
      {list}
      <ResourceDetail item={focused} subtitle={snapshot.subtitle} maxRows={maxRows} />
    </Box>
  );
}

export function filterResourceMenuItems(
  snapshot: ResourceMenuSnapshot,
  filter: string,
): ResourceMenuItem[] {
  const query = filter.trim().toLowerCase();
  if (!query) return snapshot.items;
  return snapshot.items.filter((item) =>
    [
      item.label,
      item.summary ?? '',
      item.body ?? '',
      ...item.details.flatMap((detail) => [detail.label, detail.value]),
    ].some((value) => value.toLowerCase().includes(query)),
  );
}

function ResourceDetail({
  item,
  subtitle,
  maxRows,
}: {
  item: ResourceMenuItem;
  subtitle?: string | undefined;
  maxRows?: number | undefined;
}): React.ReactElement {
  const bodyLimit = Math.max(120, ((maxRows ?? 16) - item.details.length - 7) * 72);
  return (
    <Box
      flexDirection="column"
      borderStyle="round"
      borderColor={theme.accent}
      paddingX={1}
      flexGrow={1}
    >
      <Text color={theme.accent} bold wrap="truncate-end">
        {item.label}
      </Text>
      {subtitle ? <Text color={theme.textMuted}>{subtitle}</Text> : null}
      {item.summary ? <Text wrap="wrap">{item.summary}</Text> : null}
      {item.details.map((detail) => (
        <Text key={`${detail.label}:${detail.value}`} wrap="truncate-end">
          <Text color={theme.textMuted}>{detail.label}: </Text>
          {detail.value}
        </Text>
      ))}
      {item.body ? (
        <>
          <Text> </Text>
          <Text wrap="wrap">{truncate(item.body, bodyLimit)}</Text>
        </>
      ) : null}
      {item.actions && item.actions.length > 0 ? (
        <>
          <Text> </Text>
          <Text color={theme.textMuted} wrap="wrap">
            {item.actions.map((action) => `${action.key} ${action.label}`).join(' · ')}
          </Text>
        </>
      ) : null}
    </Box>
  );
}

function statusGlyph(status: ResourceMenuItem['status']): string {
  if (status === 'good') return '●';
  if (status === 'warn') return '▲';
  if (status === 'bad') return '×';
  return '○';
}

function statusColor(status: ResourceMenuItem['status']): string {
  if (status === 'good') return theme.success;
  if (status === 'warn') return theme.warn;
  if (status === 'bad') return theme.error;
  return theme.textMuted;
}

function truncate(value: string, max: number): string {
  if (value.length <= max) return value;
  return `${value.slice(0, Math.max(0, max - 1))}…`;
}
