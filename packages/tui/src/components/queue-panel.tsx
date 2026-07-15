import type { ContentBlock } from '@wrongstack/core';
import { Box, Text, useInput } from '../ink.js';
import type React from 'react';
import { useEffect, useState } from 'react';
import { theme } from '../theme.js';
import { glyphs } from '../ui-glyphs.js';
import {
  EmptyPanelState,
  KeyCap,
  MonitorShell,
  panelWindow,
  truncatePanelText,
  useMonitorSize,
} from './monitor-shell.js';

export interface QueueItem {
  id: number;
  displayText: string;
  blocks: ContentBlock[];
}

/**
 * Compact queue panel. Shows pending messages with position numbers,
 * auto-truncated labels, and a "+N more" overflow indicator. Designed
 * to sit beside the chat area like the CompactTodosPanel.
 */
export function QueuePanel({ items }: { items: QueueItem[] }): React.ReactElement {
  const size = useMonitorSize();
  const [selected, setSelected] = useState(0);
  const maxVisible = Math.max(3, size.contentRows - 2);
  const window = panelWindow(items.length, selected, maxVisible);
  const visible = items.slice(window.start, window.end);
  const overflow = window.above + window.below;

  useEffect(() => {
    setSelected((value) => Math.min(value, Math.max(0, items.length - 1)));
  }, [items.length]);
  useInput((_input, key) => {
    if (key.upArrow) setSelected((value) => Math.max(0, value - 1));
    else if (key.downArrow) {
      setSelected((value) => Math.min(Math.max(0, items.length - 1), value + 1));
    }
  });

  return (
    <MonitorShell
      accent={theme.accent}
      icon={glyphs.queue}
      title="MESSAGE QUEUE"
      kicker={size.columns >= 88 ? 'next turns' : undefined}
      right={
        <Text color={items.length > 0 ? theme.accent : theme.textMuted} bold>
          {items.length} waiting
        </Text>
      }
      footer={
        <Box gap={2}>
          <KeyCap keyName="↑↓" label="inspect" color={theme.accent} />
          <KeyCap keyName="F7" label="close" color={theme.accent} />
          <Text color={theme.textMuted}>/queue clear · /queue remove &lt;n&gt;</Text>
        </Box>
      }
    >
      {items.length === 0 ? (
        <EmptyPanelState
          icon="◇"
          title="Queue is empty"
          detail="Messages added while the agent is busy will wait here."
          accent={theme.accent}
        />
      ) : (
        <Box flexDirection="column" marginTop={1}>
          {visible.map((item, i) => (
            <Box key={item.id} flexDirection="row" flexShrink={0} paddingX={1}>
              <Text color={window.start + i === selected ? theme.accent : theme.textMuted} bold>
                {window.start + i === selected ? '›' : ' '}{' '}
                {String(window.start + i + 1).padStart(2)}
              </Text>
              <Text color={theme.textMuted}> {window.start + i === 0 ? 'NEXT' : 'WAIT'}</Text>
              <Text color={window.start + i === selected ? theme.textPrimary : theme.textSecondary}>
                {'  '}
                {truncatePanelText(item.displayText, Math.max(12, size.contentWidth - 22))}
              </Text>
              <Box flexGrow={1} />
              {item.blocks.length > 1 ? (
                <Text color={theme.textMuted}>{item.blocks.length} blocks</Text>
              ) : null}
            </Box>
          ))}
          {overflow > 0 ? (
            <Text color={theme.textMuted}>
              {' '}
              {window.above > 0 ? `↑ ${window.above} earlier` : ''}
              {window.above > 0 && window.below > 0 ? ' · ' : ''}
              {window.below > 0 ? `↓ ${window.below} later` : ''}
            </Text>
          ) : null}
        </Box>
      )}
    </MonitorShell>
  );
}
