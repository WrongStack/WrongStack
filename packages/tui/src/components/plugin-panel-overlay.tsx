import type { PluginUiTone, PluginViewNode } from '@wrongstack/contracts/types';
import type {
  PluginUiRegistry,
  RegisteredPluginPanel,
  RegisteredPluginStatusChip,
} from '@wrongstack/core/plugin';
import { sanitizeTerminalText, toErrorMessage } from '@wrongstack/core/utils';
import type React from 'react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { Box, Text, useInput } from '../ink.js';
import { displayWidth } from '../terminal-width.js';
import { useMonitorSize } from './monitor-shell.js';

function toneColor(tone?: PluginUiTone): string | undefined {
  switch (tone) {
    case 'accent':
      return 'cyan';
    case 'info':
      return 'blue';
    case 'success':
      return 'green';
    case 'warning':
      return 'yellow';
    case 'danger':
      return 'red';
    case 'neutral':
      return 'gray';
    default:
      return undefined;
  }
}

export interface PluginViewNodeViewProps {
  node: PluginViewNode;
}

/**
 * Host-neutral Ink renderer for declarative `PluginViewNode` trees (`api.ui.registerPanel`).
 */
export function PluginViewNodeView({ node }: PluginViewNodeViewProps): React.ReactElement {
  switch (node.kind) {
    case 'text': {
      const color = toneColor(node.tone);
      return (
        <Text
          wrap="wrap"
          bold={node.bold ?? false}
          dimColor={node.dim ?? node.tone === 'neutral'}
          {...(color ? { color } : {})}
        >
          {sanitizeTerminalText(node.text)}
        </Text>
      );
    }
    case 'kv': {
      if (node.items.length === 0) {
        return <Text dimColor>(no entries)</Text>;
      }
      const keyWidth = Math.min(
        26,
        node.items.reduce((max, item) => Math.max(max, sanitizeTerminalText(item.label).length), 0),
      );
      return (
        <Box flexDirection="column">
          {node.items.map((item, idx) => {
            const color = toneColor(item.tone);
            return (
              <Text key={`kv-${idx}-${item.label}`} wrap="truncate-end">
                <Text dimColor>{`${sanitizeTerminalText(item.label)}:`}</Text>
                {' '.repeat(Math.max(1, keyWidth - sanitizeTerminalText(item.label).length + 1))}
                <Text {...(color ? { color } : {})}>{sanitizeTerminalText(item.value)}</Text>
              </Text>
            );
          })}
        </Box>
      );
    }
    case 'table': {
      if (node.columns.length === 0) {
        return <Text dimColor>(empty table)</Text>;
      }
      const cols = node.columns.map((c) => sanitizeTerminalText(c));
      const rows = node.rows
        .slice(0, node.maxRows ?? 50)
        .map((r) => cols.map((_, idx) => sanitizeTerminalText(r[idx] ?? '')));
      const widths = cols.map((col, idx) =>
        Math.min(
          32,
          rows.reduce((max, row) => Math.max(max, (row[idx] ?? '').length), col.length),
        ),
      );
      return (
        <Box flexDirection="column">
          <Text bold wrap="truncate-end">
            {cols.map((col, idx) => col.padEnd(widths[idx]!)).join('  ')}
          </Text>
          <Text dimColor wrap="truncate-end">
            {widths.map((w) => '─'.repeat(Math.max(1, w))).join('  ')}
          </Text>
          {rows.map((row, rowIdx) => (
            <Text key={`row-${rowIdx}`} wrap="truncate-end">
              {row
                .map((cell, colIdx) => cell.slice(0, widths[colIdx]!).padEnd(widths[colIdx]!))
                .join('  ')}
            </Text>
          ))}
        </Box>
      );
    }
    case 'badges': {
      if (node.badges.length === 0) {
        return <Text dimColor>(no badges)</Text>;
      }
      return (
        <Box flexDirection="row" flexWrap="wrap">
          {node.badges.map((badge, idx) => {
            const color = toneColor(badge.tone);
            return (
              <Text key={`badge-${idx}-${badge.label}`} {...(color ? { color } : {})}>
                {idx > 0 ? ' ' : ''}[{sanitizeTerminalText(badge.label)}]
              </Text>
            );
          })}
        </Box>
      );
    }
    case 'progress': {
      const ratio =
        node.total > 0 && Number.isFinite(node.current)
          ? Math.max(0, Math.min(1, node.current / node.total))
          : 0;
      const barWidth = 16;
      const filled = Math.round(ratio * barWidth);
      const bar = `${'█'.repeat(filled)}${'░'.repeat(barWidth - filled)}`;
      const color = toneColor(node.tone) ?? 'cyan';
      return (
        <Text wrap="truncate-end">
          {sanitizeTerminalText(node.label)}: <Text color={color}>{bar}</Text>{' '}
          {Math.round(ratio * 100)}% ({node.current}/{node.total})
        </Text>
      );
    }
    case 'code': {
      const lines = sanitizeTerminalText(node.content)
        .split('\n')
        .slice(0, node.maxLines ?? 120)
        .join('\n');
      return (
        <Box flexDirection="column" paddingLeft={1}>
          {node.language ? <Text dimColor>── {sanitizeTerminalText(node.language)} ──</Text> : null}
          <Text>{lines}</Text>
        </Box>
      );
    }
    case 'markdown': {
      return <Text wrap="wrap">{sanitizeTerminalText(node.content)}</Text>;
    }
    case 'log': {
      if (node.lines.length === 0) {
        return <Text dimColor>(no log entries)</Text>;
      }
      return (
        <Box flexDirection="column">
          {node.lines.map((entry, idx) => {
            const color = toneColor(entry.level);
            return (
              <Text key={`log-${idx}`} wrap="truncate-end">
                {entry.ts ? <Text dimColor>{sanitizeTerminalText(entry.ts)} </Text> : null}
                <Text {...(color ? { color } : {})}>{sanitizeTerminalText(entry.text)}</Text>
              </Text>
            );
          })}
        </Box>
      );
    }
    case 'stack': {
      const gap = Math.max(0, Math.min(2, node.gap ?? 0));
      return (
        <Box flexDirection={node.direction === 'horizontal' ? 'row' : 'column'} gap={gap}>
          {node.children.map((child, idx) => (
            <PluginViewNodeView key={`stack-${idx}`} node={child} />
          ))}
        </Box>
      );
    }
  }
}

export interface PluginStatusStripProps {
  chips: readonly RegisteredPluginStatusChip[];
  /** Maximum column budget allocated to plugin chips (typically 30% of terminal width). */
  maxColumns: number;
}

/**
 * Compact width-bounded status strip for plugin `api.ui.registerStatusChip` entries.
 */
export function PluginStatusStrip({
  chips,
  maxColumns,
}: PluginStatusStripProps): React.ReactElement | null {
  if (chips.length === 0 || maxColumns < 8) return null;

  const visible: Array<{ chip: RegisteredPluginStatusChip; formatted: string }> = [];
  let usedCols = 0;

  for (let i = 0; i < chips.length; i += 1) {
    const chip = chips[i]!;
    const rawLabel = `${chip.icon ? `${chip.icon} ` : ''}${chip.text}`;
    const formatted = sanitizeTerminalText(rawLabel).slice(0, 28);
    const sepCols = visible.length > 0 ? 3 : 0;
    const reserveOverflow = i < chips.length - 1 ? 6 : 0;
    const itemCols = displayWidth(formatted);
    if (visible.length > 0 && usedCols + sepCols + itemCols + reserveOverflow > maxColumns) {
      break;
    }
    visible.push({ chip, formatted });
    usedCols += sepCols + itemCols;
  }

  const overflowCount = chips.length - visible.length;

  return (
    <Box flexDirection="row">
      {visible.map(({ chip, formatted }, idx) => {
        const color = toneColor(chip.tone);
        return (
          <Text key={chip.qualifiedId} wrap="truncate-end">
            {idx > 0 ? <Text dimColor> · </Text> : null}
            <Text dimColor={chip.tone === 'neutral'} {...(color ? { color } : {})}>
              {formatted}
            </Text>
          </Text>
        );
      })}
      {overflowCount > 0 ? <Text dimColor> · +{overflowCount}</Text> : null}
    </Box>
  );
}

export interface PluginPanelOverlayProps {
  registry: PluginUiRegistry;
  initialPanelId?: string | undefined;
  onClose: () => void;
}

/**
 * Interactive TUI overlay for `api.ui.registerPanel` surfaces (`/panel`).
 * Supports switching across panels (`←`/`→` or `Tab`), triggering scoped panel
 * actions via their single-key shortcuts, manual refresh (`r`), and `Esc` close.
 */
export function PluginPanelOverlay({
  registry,
  initialPanelId,
  onClose,
}: PluginPanelOverlayProps): React.ReactElement {
  const size = useMonitorSize();
  const [revision, setRevision] = useState(0);
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [renderedNode, setRenderedNode] = useState<PluginViewNode | null>(null);
  const [busy, setBusy] = useState(false);
  const [statusNote, setStatusNote] = useState<string | null>(null);
  const busyRef = useRef(false);

  useEffect(() => {
    return registry.subscribe(() => {
      setRevision((r) => r + 1);
    });
  }, [registry]);

  const panels: readonly RegisteredPluginPanel[] = registry.listPanels();

  useEffect(() => {
    if (!initialPanelId || panels.length === 0) return;
    const idx = panels.findIndex(
      (p) => p.qualifiedId === initialPanelId || p.id === initialPanelId,
    );
    if (idx >= 0) setSelectedIndex(idx);
  }, [initialPanelId, panels]);

  const clampedIndex = panels.length === 0 ? 0 : Math.min(selectedIndex, panels.length - 1);
  const activePanel = panels[clampedIndex];

  useEffect(() => {
    void revision;
    if (!activePanel) {
      setRenderedNode(null);
      return undefined;
    }
    let cancelled = false;
    void activePanel
      .render()
      .then((node) => {
        if (!cancelled) setRenderedNode(node);
      })
      .catch((err: unknown) => {
        if (!cancelled) {
          setRenderedNode({
            kind: 'text',
            text: `Panel render error: ${toErrorMessage(err)}`,
            tone: 'danger',
          });
        }
      });
    return () => {
      cancelled = true;
    };
  }, [activePanel, revision]);

  const triggerAction = useCallback(
    async (actionId: string, label: string) => {
      if (!activePanel?.onAction || busyRef.current) return;
      busyRef.current = true;
      setBusy(true);
      setStatusNote(null);
      try {
        await activePanel.onAction(actionId);
        setStatusNote(`✓ ${label}`);
        setRevision((r) => r + 1);
      } catch (err) {
        setStatusNote(`✗ ${toErrorMessage(err)}`);
      } finally {
        busyRef.current = false;
        setBusy(false);
      }
    },
    [activePanel],
  );

  useInput((input, key) => {
    if (key.ctrl || key.meta) return;
    if (key.escape) {
      onClose();
      return;
    }
    if (panels.length > 1 && (key.tab || key.rightArrow)) {
      setSelectedIndex((prev) => (prev + 1) % panels.length);
      setStatusNote(null);
      return;
    }
    if (panels.length > 1 && key.leftArrow) {
      setSelectedIndex((prev) => (prev - 1 + panels.length) % panels.length);
      setStatusNote(null);
      return;
    }
    if (input === 'r') {
      setRevision((r) => r + 1);
      setStatusNote('Refreshed.');
      return;
    }
    if (activePanel?.actions && activePanel.onAction && input.length === 1) {
      const matched = activePanel.actions.find((a) => a.shortcut === input);
      if (matched) {
        void triggerAction(matched.id, matched.label);
        return;
      }
    }
    if (input === 'q') {
      onClose();
    }
  });

  const maxWidth = Math.max(40, size.columns - 2);

  return (
    <Box
      flexDirection="column"
      borderStyle="round"
      borderColor="cyan"
      paddingX={1}
      width={maxWidth}
    >
      <Text bold color="cyan" wrap="truncate-end">
        ━━ Plugin Panels ({panels.length}) ━━
      </Text>
      <Text dimColor wrap="truncate-end">
        {panels.length > 1 ? '←/→ or Tab switch panel · ' : ''}r refresh · Esc close
      </Text>
      {panels.length === 0 ? (
        <Text dimColor>No declarative plugin UI panels are currently registered.</Text>
      ) : activePanel ? (
        <Box flexDirection="column" marginTop={0}>
          <Text wrap="truncate-end">
            {panels.map((p, idx) => (
              <Text
                key={p.qualifiedId}
                bold={idx === clampedIndex}
                color={idx === clampedIndex ? 'cyan' : undefined}
                dimColor={idx !== clampedIndex}
              >
                {idx > 0 ? '  │  ' : ''}
                {idx === clampedIndex ? '● ' : '○ '}
                {p.title} ({p.owner})
              </Text>
            ))}
          </Text>
          <Box flexDirection="column" marginTop={1}>
            {renderedNode ? <PluginViewNodeView node={renderedNode} /> : null}
          </Box>
          {activePanel.actions.length > 0 ? (
            <Text dimColor wrap="truncate-end">
              Actions:{' '}
              {activePanel.actions
                .map((a) => `${a.shortcut ? `[${a.shortcut}] ` : ''}${a.label}`)
                .join('  ·  ')}
            </Text>
          ) : null}
        </Box>
      ) : null}
      {busy ? <Text color="yellow">Running panel action…</Text> : null}
      {statusNote ? (
        <Text color={statusNote.startsWith('✗') ? 'red' : 'green'} wrap="truncate-end">
          {statusNote}
        </Text>
      ) : null}
    </Box>
  );
}
