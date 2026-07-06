import { Box, Text, useStdout } from '../ink.js';
import type React from 'react';

export interface PluginPickerItem {
  name: string;
  enabled: boolean;
  risk: 'low' | 'medium' | 'high';
  summary: string;
  /**
   * When false the row is locked: the picker renders a 🔒 marker and ignores
   * Enter/←/→ on it. The current built-in audit list is fully toggleable, but
   * the component keeps this marker for future or externally supplied locked
   * rows.
   */
  lockable?: boolean | undefined;
}

export interface PluginPickerProps {
  items: PluginPickerItem[];
  selected: number;
  busy?: boolean | undefined;
  hint?: string | undefined;
}

/**
 * Rows of terminal chrome around the visible item window: the picker's own
 * border/title/legend/scroll indicators (~9) plus the input box, statusline
 * and key-hint bar rendered below the picker (~8). Subtracted from
 * `stdout.rows` so the plugin list never pushes the input area off-screen.
 */
const CHROME_ROWS = 17;

export function PluginPicker({
  items,
  selected,
  busy = false,
  hint,
}: PluginPickerProps): React.ReactElement {
  const { stdout } = useStdout();
  const rows = stdout?.rows ?? 24;

  // Height-aware scrolling window centred on the selection — small terminals
  // get a short window with ↑/↓ overflow indicators instead of an overflowing
  // (and Ink-clipped) full list.
  const maxVisible = Math.max(4, rows - CHROME_ROWS);
  const total = items.length;
  const windowStart =
    total <= maxVisible
      ? 0
      : Math.max(0, Math.min(selected - Math.floor(maxVisible / 2), total - maxVisible));
  const windowEnd = Math.min(windowStart + maxVisible, total);
  const above = windowStart;
  const below = total - windowEnd;
  const hasLockedRows = items.some((item) => item.lockable === false);

  return (
    <Box flexDirection="column" borderStyle="round" borderColor="cyan" paddingX={1}>
      <Text bold color="cyan">
        Plugin menu
      </Text>
      <Text dimColor>
        ↑/↓ select · Enter/←/→ toggle{hasLockedRows ? ' · 🔒 = locked' : ''} · Esc close
      </Text>
      <Box marginTop={1} flexDirection="column">
        {items.length === 0 ? (
          <Text dimColor>{busy ? 'Loading plugins…' : 'No plugins available.'}</Text>
        ) : (
          <>
            {above > 0 ? <Text dimColor>{`  ↑ ${above} more`}</Text> : null}
            {items.slice(windowStart, windowEnd).map((item, i) => {
              const index = windowStart + i;
              const focused = index === selected;
              const marker = focused ? '›' : ' ';
              const isLocked = item.lockable === false;
              const state = item.enabled ? '● on ' : '○ off';
              const color = item.enabled ? 'green' : 'gray';
              // The 🔒 lives in its own column after the name (not inside the
              // on/off column) so the state column stays uniform. The emoji
              // occupies 2 cells, so the unlocked filler is 2 spaces.
              const lock = isLocked ? '🔒' : '  ';
              return (
                <Text key={item.name} color={focused ? 'cyan' : undefined} wrap="truncate-end">
                  {marker} <Text color={color}>{state}</Text> {item.name.padEnd(18)}{' '}
                  <Text color={isLocked ? 'yellow' : undefined}>{lock}</Text>{' '}
                  <Text dimColor>risk={item.risk.padEnd(6)}</Text> {item.summary}
                </Text>
              );
            })}
            {below > 0 ? <Text dimColor>{`  ↓ ${below} more`}</Text> : null}
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
