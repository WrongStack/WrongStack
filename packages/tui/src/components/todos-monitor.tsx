import type { TodoItem } from '@wrongstack/core';
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
import { renderProgress } from './status-bar.js';

/**
 * Full-screen Todos monitor overlay (F6 to open, F6 to close).
 * Surfaces the live agent.ctx.todos board — compact status-bar chips
 * aren't enough when the board has 10+ items. Mirrors the bordered-
 * panel look of the fleet/agents/worktree monitors so it sits naturally
 * in the bottom region.
 */
export function TodosMonitor({ todos }: { todos: TodoItem[] }): React.ReactElement {
  const size = useMonitorSize();
  const [selected, setSelected] = useState(0);

  const done = todos.filter((t) => t.status === 'completed').length;
  const inProgress = todos.filter((t) => t.status === 'in_progress').length;
  const pending = todos.filter((t) => t.status === 'pending').length;

  const twoCols = size.columns >= 104;
  const colWidth = twoCols ? Math.floor((size.contentWidth - 3) / 2) : size.contentWidth;
  const ordered = [...todos].sort((a, b) => {
    const rank = (status: TodoItem['status']) =>
      status === 'in_progress' ? 0 : status === 'pending' ? 1 : 2;
    return rank(a.status) - rank(b.status);
  });
  const rowsPerColumn = Math.max(2, size.contentRows - 3);
  const capacity = rowsPerColumn * (twoCols ? 2 : 1);
  const window = panelWindow(ordered.length, selected, capacity);
  const visible = ordered.slice(window.start, window.end);
  const overflow = window.above + window.below;
  const mid = twoCols ? Math.ceil(visible.length / 2) : visible.length;

  useEffect(() => {
    setSelected((value) => Math.min(value, Math.max(0, ordered.length - 1)));
  }, [ordered.length]);
  useInput((_input, key) => {
    if (key.upArrow) setSelected((value) => Math.max(0, value - 1));
    else if (key.downArrow) {
      setSelected((value) => Math.min(Math.max(0, ordered.length - 1), value + 1));
    }
  });

  /** Render a single todo row with marker + label. */
  const renderRow = (t: TodoItem, idx: number): React.ReactElement => {
    const isSelected = window.start + idx === selected;
    const marker = isSelected ? '› ' : '  ';
    const num = String(todos.indexOf(t) + 1).padStart(2);
    const label = t.status === 'in_progress' && t.activeForm ? t.activeForm : t.content;
    const display = truncatePanelText(label, Math.max(8, colWidth - 9));

    if (t.status === 'completed') {
      return (
        <Text key={`${t.id}-${idx}`} color={theme.textMuted}>
          <Text color={isSelected ? theme.warn : theme.textMuted}>{marker}</Text>
          <Text color={theme.textMuted}>{num}.</Text> <Text color={theme.success}>[x]</Text>{' '}
          {display}
        </Text>
      );
    }
    if (t.status === 'in_progress') {
      return (
        <Text key={t.id}>
          <Text color={isSelected ? theme.warn : theme.textMuted}>{marker}</Text>
          <Text color={theme.textMuted}>{num}.</Text>{' '}
          <Text color={theme.warn} bold>
            [~]
          </Text>{' '}
          <Text color={theme.warn}>{display}</Text>
        </Text>
      );
    }
    // pending
    return (
      <Text key={t.id}>
        <Text color={isSelected ? theme.warn : theme.textMuted}>{marker}</Text>
        <Text color={theme.textMuted}>{num}.</Text> <Text color={theme.textMuted}>[ ]</Text>{' '}
        <Text color={theme.textSecondary}>{display}</Text>
      </Text>
    );
  };

  return (
    <MonitorShell
      accent={theme.warn}
      icon={glyphs.task}
      title="TODOS"
      kicker={size.columns >= 90 ? 'execution board' : undefined}
      right={
        <Text>
          <Text color={theme.warn}>↻ {inProgress}</Text>
          <Text color={theme.textMuted}> □ {pending}</Text>
          <Text color={theme.success}> ✓ {done}</Text>
        </Text>
      }
      footer={
        <Box gap={2}>
          <KeyCap keyName="↑↓" label="inspect" color={theme.warn} />
          <KeyCap keyName="F6" label="close" color={theme.warn} />
          {overflow > 0 ? (
            <Text color={theme.textMuted}>
              {window.above > 0 ? `↑${window.above} ` : ''}
              {window.below > 0 ? `↓${window.below}` : ''}
            </Text>
          ) : null}
        </Box>
      }
    >
      <Box marginTop={1} gap={1}>
        <Text color={theme.textMuted}>PROGRESS</Text>
        <Text color={done === todos.length && todos.length > 0 ? theme.success : theme.warn}>
          [
          {renderProgress(todos.length > 0 ? done / todos.length : 0, size.columns >= 90 ? 18 : 10)}
          ]
        </Text>
        <Text color={theme.textSecondary}>
          {done}/{todos.length}
        </Text>
      </Box>

      {todos.length === 0 ? (
        <EmptyPanelState
          icon="◇"
          title="Board is clear"
          detail="Todos will appear as the agent plans work."
          accent={theme.warn}
        />
      ) : twoCols ? (
        <Box flexDirection="row" gap={3} marginTop={1}>
          <Box flexDirection="column" width={colWidth}>
            {visible.slice(0, mid).map((t, i) => renderRow(t, i))}
          </Box>
          <Box flexDirection="column" width={colWidth}>
            {visible.slice(mid).map((t, i) => renderRow(t, mid + i))}
          </Box>
        </Box>
      ) : (
        <Box flexDirection="column" marginTop={1}>
          {visible.map(renderRow)}
        </Box>
      )}
    </MonitorShell>
  );
}
