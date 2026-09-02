import { Box, Text, useStdout } from '../ink.js';
import type React from 'react';

export interface McpPickerItem {
  name: string;
  enabled: boolean;
  status: string;
  transport: string;
  description?: string | undefined;
  toolCount: number;
  lazy?: boolean | undefined;
}

interface McpPickerProps {
  items: McpPickerItem[];
  selected: number;
  busy?: boolean | undefined;
  hint?: string | undefined;
}

/**
 * Rows of terminal chrome around the visible item window: the picker's own
 * border/title/legend/scroll indicators (~9) plus the input box, statusline
 * and key-hint bar rendered below the picker (~8). Subtracted from
 * `stdout.rows` so the picker list never pushes the input area off-screen.
 */
const CHROME_ROWS = 17;

/** Colourise an MCP connection status string. */
function statusBadge(status: string, enabled: boolean): React.ReactElement {
  if (!enabled) return <Text dimColor>○ disabled</Text>;
  switch (status) {
    case 'connected':
      return <Text color="green">● connected</Text>;
    case 'connecting':
      return <Text color="cyan">◐ connecting</Text>;
    case 'reconnecting':
      return <Text color="cyan">◑ reconnecting</Text>;
    case 'disconnected':
      return <Text dimColor>○ disconnected</Text>;
    case 'failed':
      return <Text color="red">✗ failed</Text>;
    default:
      return <Text dimColor>{status}</Text>;
  }
}

export function McpPicker({
  items,
  selected,
  busy = false,
  hint,
}: McpPickerProps): React.ReactElement {
  const { stdout } = useStdout();
  const rows = stdout?.rows ?? 24;

  // Height-aware scrolling window centred on the selection.
  const maxVisible = Math.max(4, rows - CHROME_ROWS);
  const total = items.length;
  const windowStart =
    total <= maxVisible
      ? 0
      : Math.max(0, Math.min(selected - Math.floor(maxVisible / 2), total - maxVisible));
  const windowEnd = Math.min(windowStart + maxVisible, total);
  const above = windowStart;
  const below = total - windowEnd;

  return (
    <Box flexDirection="column" borderStyle="round" borderColor="cyan" paddingX={1}>
      <Text bold color="cyan">
        MCP Servers
      </Text>
      <Text dimColor>↑/↓ select · Enter/←/→ toggle enable · r restart · Esc close</Text>
      <Box marginTop={1} flexDirection="column">
        {items.length === 0 ? (
          <Text dimColor>{busy ? 'Loading servers…' : 'No MCP servers configured.'}</Text>
        ) : (
          <>
            {above > 0 ? <Text dimColor>{`  ↑ ${above} more`}</Text> : null}
            {items.slice(windowStart, windowEnd).map((item, i) => {
              const index = windowStart + i;
              const focused = index === selected;
              const marker = focused ? '›' : ' ';
              return (
                <Text key={item.name} color={focused ? 'cyan' : undefined} wrap="truncate-end">
                  {marker} {statusBadge(item.status, item.enabled)}{' '}
                  <Text bold>{item.name.padEnd(18)}</Text>
                  <Text dimColor>
                    {item.transport.padEnd(14)}
                    {item.toolCount > 0 ? `${item.toolCount} tools` : ''}
                    {item.lazy ? ' lazy' : ''}
                  </Text>
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
