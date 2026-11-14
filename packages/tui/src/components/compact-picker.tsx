import type React from 'react';
import { Box, Text } from '../ink.js';
import {
  displayWidth,
  sanitizeTerminalText,
  truncateDisplay,
  truncateDisplayStart,
} from '../terminal-width.js';
import { theme } from '../theme.js';

interface CompactPickerProps {
  label: string | undefined;
  emptyLabel: string;
  position: string;
  columns: number;
  rows: number;
  context?: string | undefined;
  action?: 'run' | 'attach';
  preserveEnd?: boolean;
}

const oneLine = (value: string): string => sanitizeTerminalText(value).replace(/\n/g, ' ');

/** Short panes prioritize focus, then context, then measured, actionable controls. */
export function CompactPicker({
  label,
  emptyLabel,
  position,
  columns,
  rows,
  context,
  action,
  preserveEnd = false,
}: CompactPickerProps): React.ReactElement | null {
  if (rows <= 0 || columns <= 0) return null;
  const height = Math.min(3, rows);
  const selected = label !== undefined;
  const prefix = selected && columns >= 3 ? '› ' : '';
  const truncate = preserveEnd ? truncateDisplayStart : truncateDisplay;
  const text = oneLine(label ?? emptyLabel);
  const suffix = height === 1 ? ' · Esc' : '';
  const labelWidth = Math.max(0, columns - displayWidth(prefix + suffix));
  // Below ten columns a single row cannot meaningfully show focus AND an exit hint.
  const focus =
    height === 1 && columns < 10
      ? 'Esc'.slice(0, columns)
      : `${prefix}${truncate(text, labelWidth)}${suffix}`;
  const count = oneLine(position);
  const confirm = selected && action ? `Enter ${action}` : '';
  const completion = selected && action === 'run' ? 'Tab fill' : '';
  const controls = [
    [count, '↑↓', confirm, completion, 'Esc'],
    [count, '↑↓', confirm, 'Esc'],
    [count, confirm, 'Esc'],
    [confirm, 'Esc'],
    [count, '↑↓', 'Esc'],
    [count, 'Esc'],
    ['Esc'],
  ].map((parts) => parts.filter(Boolean).join(' · '));
  const footer = controls.find((line) => displayWidth(line) <= columns) ?? 'Esc'.slice(0, columns);
  return (
    <Box flexDirection="column" width={columns} height={height} flexShrink={0} overflowY="hidden">
      <Text
        bold
        inverse={selected}
        color={selected ? theme.accent : theme.textSecondary}
        wrap="truncate-end"
      >
        {focus}
      </Text>
      {height >= 3 ? (
        <Text color={theme.textSecondary} wrap="truncate-end">
          {truncateDisplay(oneLine(context ?? 'Type to filter'), columns)}
        </Text>
      ) : null}
      {height >= 2 ? (
        <Text color={theme.textSecondary} wrap="truncate-end">
          {footer}
        </Text>
      ) : null}
    </Box>
  );
}
