/** F11 — project-level AutonomousCoordinator monitor. */
import { Box, Text, useInput } from '../ink.js';
import { useEffect, useState } from 'react';
import type React from 'react';
import type { State } from '../app.js';
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

export interface CoordinatorPanelProps {
  coordinator: State['coordinator'];
  /** 1s clock tick so elapsed times stay live. */
  nowTick: number;
  /** Called when the user presses Esc or q to close the panel. */
  onClose: () => void;
}

const KIND_COLOR: Record<string, string> = {
  goal: theme.accent,
  task: theme.warn,
  knowledge: theme.success,
  consensus: theme.brand,
  deadlock: theme.error,
};

const GOAL_VISUAL: Record<string, { icon: string; color: string }> = {
  active: { icon: '▶', color: theme.success },
  paused: { icon: 'Ⅱ', color: theme.warn },
  completed: { icon: '✓', color: theme.success },
  failed: { icon: '✗', color: theme.error },
};

const TASK_VISUAL: Record<string, { icon: string; color: string }> = {
  pending: { icon: '○', color: theme.textMuted },
  running: { icon: '▶', color: theme.warn },
  done: { icon: '✓', color: theme.success },
  failed: { icon: '✗', color: theme.error },
};

function fmtElapsed(at: number, nowTick: number): string {
  const seconds = Math.max(0, Math.floor((nowTick - at) / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  return `${Math.floor(minutes / 60)}h`;
}

export function CoordinatorPanel({
  coordinator,
  nowTick,
  onClose,
}: CoordinatorPanelProps): React.ReactElement {
  const size = useMonitorSize();
  const [selectedGoal, setSelectedGoal] = useState(0);
  const { goals, timeline, knowledgeCount, healthy } = coordinator;

  useEffect(() => {
    setSelectedGoal((value) => Math.min(value, Math.max(0, goals.length - 1)));
  }, [goals.length]);

  useInput((input, key) => {
    if (input === 'q' || input === 'Q' || key.escape) onClose();
    else if (key.upArrow) setSelectedGoal((value) => Math.max(0, value - 1));
    else if (key.downArrow) {
      setSelectedGoal((value) => Math.min(Math.max(0, goals.length - 1), value + 1));
    }
  });

  const selected = goals[selectedGoal];
  const taskLimit = Math.max(1, Math.min(5, Math.floor(size.contentRows * 0.35)));
  const visibleTasks = selected?.tasks.slice(0, taskLimit) ?? [];
  const goalLimit = Math.max(1, Math.min(5, size.contentRows - taskLimit - 7));
  const goalWindow = panelWindow(goals.length, selectedGoal, goalLimit);
  const visibleGoals = goals.slice(goalWindow.start, goalWindow.end);
  const timelineLimit = Math.max(
    0,
    Math.min(5, size.contentRows - visibleGoals.length - visibleTasks.length - 7),
  );
  const visibleTimeline = timeline.slice(0, timelineLimit);
  const activeGoals = goals.filter((goal) => goal.status === 'active').length;
  const runningTasks = goals.reduce(
    (sum, goal) => sum + goal.tasks.filter((task) => task.status === 'running').length,
    0,
  );

  return (
    <MonitorShell
      accent={theme.accent}
      icon={glyphs.auto}
      title="COORDINATOR"
      kicker={size.columns >= 90 ? 'cross-session control' : undefined}
      right={
        <Text>
          <Text color={healthy ? theme.success : theme.error} bold>
            ● {healthy ? 'CONNECTED' : 'OFFLINE'}
          </Text>
          <Text color={theme.textMuted}>
            {' '}
            {activeGoals} goals · {runningTasks} running
          </Text>
        </Text>
      }
      footer={
        <Box gap={2}>
          <KeyCap keyName="↑↓" label="inspect goal" color={theme.accent} />
          <KeyCap keyName="F11/Q" label="close" color={theme.error} />
          <Text color={theme.textMuted}>{knowledgeCount} shared facts</Text>
        </Box>
      }
    >
      {goals.length === 0 ? (
        <EmptyPanelState
          icon="◇"
          title="No coordinated goals"
          detail="Cross-session goals and their dependency work will appear here."
          accent={theme.accent}
        />
      ) : (
        <Box flexDirection="column" marginTop={1}>
          <Text color={theme.textMuted} bold>
            GOALS {goals.length}
          </Text>
          {goalWindow.above > 0 ? (
            <Text color={theme.textMuted}> ↑ {goalWindow.above} goals</Text>
          ) : null}
          {visibleGoals.map((goal, localIndex) => {
            const absoluteIndex = goalWindow.start + localIndex;
            const isSelected = absoluteIndex === selectedGoal;
            const visual = GOAL_VISUAL[goal.status] ?? { icon: '?', color: theme.textMuted };
            const done = goal.tasks.filter((task) => task.status === 'done').length;
            const ratio =
              typeof goal.progress === 'number'
                ? Math.max(0, Math.min(1, goal.progress > 1 ? goal.progress / 100 : goal.progress))
                : goal.tasks.length > 0
                  ? done / goal.tasks.length
                  : 0;
            return (
              <Box key={goal.id}>
                <Text color={isSelected ? theme.accent : theme.textMuted}>
                  {isSelected ? '› ' : '  '}
                </Text>
                <Text color={visual.color} bold>
                  {visual.icon}{' '}
                </Text>
                <Text
                  color={isSelected ? theme.textPrimary : theme.textSecondary}
                  bold={isSelected}
                >
                  {truncatePanelText(
                    goal.title || '(unnamed goal)',
                    Math.max(14, size.contentWidth - 38),
                  )}
                </Text>
                <Box flexGrow={1} />
                <Text color={visual.color}>[{renderProgress(ratio, 8)}]</Text>
                <Text color={theme.textMuted}>
                  {' '}
                  {done}/{goal.tasks.length}
                </Text>
              </Box>
            );
          })}
          {goalWindow.below > 0 ? (
            <Text color={theme.textMuted}> ↓ {goalWindow.below} goals</Text>
          ) : null}
        </Box>
      )}

      {selected && selected.tasks.length > 0 ? (
        <Box flexDirection="column" marginTop={1} paddingX={1}>
          <Text color={theme.textMuted} bold>
            TASKS {visibleTasks.length}/{selected.tasks.length}
          </Text>
          {visibleTasks.map((task) => {
            const visual = TASK_VISUAL[task.status] ?? { icon: '?', color: theme.textMuted };
            return (
              <Box key={task.id}>
                <Text color={visual.color}>{visual.icon} </Text>
                <Text color={task.status === 'done' ? theme.textMuted : theme.textSecondary}>
                  {truncatePanelText(task.title, Math.max(14, size.contentWidth - 28))}
                </Text>
                <Box flexGrow={1} />
                {task.assignedTo ? (
                  <Text color={theme.accent}>{truncatePanelText(task.assignedTo, 18)}</Text>
                ) : null}
              </Box>
            );
          })}
          {selected.tasks.length > visibleTasks.length ? (
            <Text color={theme.textMuted}>
              {' '}
              +{selected.tasks.length - visibleTasks.length} more tasks
            </Text>
          ) : null}
        </Box>
      ) : null}

      {visibleTimeline.length > 0 ? (
        <Box flexDirection="column" marginTop={1}>
          <Text color={theme.textMuted} bold>
            RECENT ACTIVITY
          </Text>
          {visibleTimeline.map((entry, index) => (
            <Box key={`${entry.at}-${index}`}>
              <Text color={KIND_COLOR[entry.kind] ?? theme.textMuted}>{entry.icon} </Text>
              <Text color={theme.textMuted}>
                {truncatePanelText(entry.text, Math.max(12, size.contentWidth - 12))}
              </Text>
              <Box flexGrow={1} />
              <Text color={theme.textMuted}>{fmtElapsed(entry.at, nowTick)}</Text>
            </Box>
          ))}
        </Box>
      ) : null}
    </MonitorShell>
  );
}
