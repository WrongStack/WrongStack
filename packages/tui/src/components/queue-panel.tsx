import type React from 'react';
import { useCallback, useEffect, useState } from 'react';
import type { QueueItem } from '../app-state.js';
import { Box, Text, useInput } from '../ink.js';
import { theme } from '../theme.js';
import { glyphs } from '../ui-glyphs.js';
import {
  EmptyPanelState,
  KeyCap,
  MonitorShell,
  panelWindow,
  truncatePanelText,
  useMonitorSize,
  usePanelShortcutsEnabled,
} from './monitor-shell.js';

/**
 * Interactive queue panel. Shows pending messages with position numbers,
 * auto-truncated labels, selection cursor, and per-item action keys.
 */
export function QueuePanel({
  items,
  onDelete,
  onClear,
  onEdit,
  onToggleRefine,
}: {
  items: QueueItem[];
  onDelete?: ((position: number) => void) | undefined;
  onClear?: (() => void) | undefined;
  onEdit?: ((position: number) => void) | undefined;
  onToggleRefine?: ((position: number) => void) | undefined;
}): React.ReactElement {
  const size = useMonitorSize();
  const [selected, setSelected] = useState(0);
  const [confirmClear, setConfirmClear] = useState(false);
  const maxVisible = Math.max(3, size.contentRows - 2);
  const window = panelWindow(items.length, selected, maxVisible);
  const visible = items.slice(window.start, window.end);
  const overflow = window.above + window.below;

  useEffect(() => {
    setSelected((value) => Math.min(value, Math.max(0, items.length - 1)));
  }, [items.length]);

  useEffect(() => {
    if (confirmClear && items.length === 0) setConfirmClear(false);
  }, [items.length, confirmClear]);

  const shortcutsEnabled = usePanelShortcutsEnabled();
  const handler = useCallback(
    (_input: string, key: { upArrow: boolean; downArrow: boolean; return: boolean }) => {
      if (key.upArrow) setSelected((value) => Math.max(0, value - 1));
      else if (key.downArrow) {
        setSelected((value) => Math.min(Math.max(0, items.length - 1), value + 1));
      } else if (!shortcutsEnabled) {
        // Letter shortcuts (edit/delete/clear/refine) stay inert while the
        // composer holds a draft — the user is typing a message, not driving
        // the queue.
      } else if (_input === 'e' && items.length > 0) {
        setConfirmClear(false); // any non-cancel action disarms the confirm flow
        // 'e' for edit — restores selected item's text to the composer.
        onEdit?.(selected);
      } else if (_input === 'd' && items.length > 0) {
        setConfirmClear(false); // any non-cancel action disarms the confirm flow
        onDelete?.(selected);
      } else if (_input === 'c') {
        if (confirmClear && items.length > 0) {
          onClear?.();
          setConfirmClear(false);
        } else if (items.length > 0) {
          setConfirmClear(true);
        }
      } else if (_input === 'r' && items.length > 0) {
        setConfirmClear(false); // any non-cancel action disarms the confirm flow
        onToggleRefine?.(selected);
      } else if (_input === 'x' && confirmClear) {
        setConfirmClear(false);
      }
    },
    [
      items.length,
      selected,
      confirmClear,
      onDelete,
      onClear,
      onEdit,
      onToggleRefine,
      shortcutsEnabled,
    ],
  );
  useInput(handler);

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
          <KeyCap keyName="↑↓" label="sel" color={theme.accent} />
          <KeyCap keyName="d" label="del" color={theme.textMuted} />
          <KeyCap keyName="e" label="edit" color={theme.textMuted} />
          <KeyCap keyName="r" label="refine" color={theme.textMuted} />
          {items.length > 0 ? (
            <KeyCap
              keyName="c"
              label={confirmClear ? 'confirm' : 'clear'}
              color={confirmClear ? theme.warn : theme.textMuted}
            />
          ) : null}
          {confirmClear ? <Text color={theme.warn}> Clear all? (c=yes, x=cancel)</Text> : null}
          <Box flexGrow={1} />
          <KeyCap keyName="F7" label="close" color={theme.accent} />
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
          {visible.map((item, i) => {
            const idx = window.start + i;
            const isSelected = idx === selected;
            return (
              <Box key={item.id} flexDirection="row" flexShrink={0} paddingX={1}>
                <Text color={isSelected ? theme.accent : theme.textMuted} bold>
                  {isSelected ? '›' : ' '} {String(idx + 1).padStart(2)}
                </Text>
                <Text color={theme.textMuted}> {idx === 0 ? 'NEXT' : 'WAIT'}</Text>
                <Text color={isSelected ? theme.textPrimary : theme.textSecondary}>
                  {'  '}
                  {truncatePanelText(item.displayText, Math.max(12, size.contentWidth - 18))}
                </Text>
                {item.shouldRefine ? (
                  <Text color={theme.brandPrimary}> ✦</Text>
                ) : (
                  <Text color={theme.textMuted}> ·</Text>
                )}
                <Box flexGrow={1} />
                {item.blocks.length > 1 ? (
                  <Text color={theme.textMuted}>{item.blocks.length}B</Text>
                ) : null}
              </Box>
            );
          })}
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
