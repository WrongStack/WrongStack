import { Box, Text, useInput } from '../ink.js';
import type React from 'react';
import { useEffect, useState } from 'react';
import { theme } from '../theme.js';
import type { GoalSummary } from '../app-state.js';
import { glyphs } from '../ui-glyphs.js';
import {
  EmptyPanelState,
  KeyCap,
  MonitorShell,
  panelWindow,
  truncatePanelText,
  useMonitorSize,
} from './monitor-shell.js';

export interface GoalPanelProps {
  goal: GoalSummary;
  /** Start the AutonomousCoordinator with the given goal text. */
  onCoordinatorStart?: ((goal: string) => void) | undefined;
  /** Stop the AutonomousCoordinator. */
  onCoordinatorStop?: (() => void) | undefined;
  /** Whether the coordinator is currently running. */
  coordinatorRunning?: boolean | undefined;
}

/**
 * Full-screen overlay showing the current goal, deliverables checklist,
 * and progress bar. Opened with F9.
 */
export function GoalPanel({
  goal,
  onCoordinatorStart,
  onCoordinatorStop,
  coordinatorRunning,
}: GoalPanelProps): React.ReactElement {
  const size = useMonitorSize();
  const [selectedDeliverable, setSelectedDeliverable] = useState(0);
  const deliverableCount = goal?.deliverables?.length ?? 0;
  useEffect(() => {
    setSelectedDeliverable((value) => Math.min(value, Math.max(0, deliverableCount - 1)));
  }, [deliverableCount]);
  // Keyboard shortcuts for coordinator control (called before early returns so hooks always fire)
  useInput((input, key) => {
    if (input === 'c' || input === 'C') {
      if (onCoordinatorStart && goal) {
        const goalText = goal.refinedGoal || goal.goal;
        onCoordinatorStart(goalText);
      }
    }
    if (input === 'S') {
      if (onCoordinatorStop) {
        onCoordinatorStop();
      }
    }
    if (key.upArrow) {
      setSelectedDeliverable((value) => Math.max(0, value - 1));
    } else if (key.downArrow) {
      setSelectedDeliverable((value) => Math.min(Math.max(0, deliverableCount - 1), value + 1));
    }
  });

  if (!goal) {
    return (
      <MonitorShell
        accent={theme.brand}
        icon={glyphs.goal}
        title="GOAL"
        kicker="mission control"
        right={
          <Text color={coordinatorRunning ? theme.success : theme.textMuted}>
            ● coordinator {coordinatorRunning ? 'running' : 'idle'}
          </Text>
        }
        footer={<KeyCap keyName="F9" label="close" color={theme.brand} />}
      >
        <EmptyPanelState
          icon="◇"
          title="No mission set"
          detail="Use /goal set <mission> to define the outcome."
          accent={theme.brand}
        />
      </MonitorShell>
    );
  }

  const displayGoal = goal.refinedGoal || goal.goal;
  const stateIcon =
    goal.goalState === 'active'
      ? '🔄'
      : goal.goalState === 'paused'
        ? '⏸'
        : goal.goalState === 'completed'
          ? '✅'
          : '⏹';

  const stateColor =
    goal.goalState === 'active'
      ? 'green'
      : goal.goalState === 'paused'
        ? 'yellow'
        : goal.goalState === 'completed'
          ? 'green'
          : 'red';
  const deliverables = goal.deliverables ?? [];
  const isDone = (text: string) => /^\[[x✓]\]|✅|\(done\)/i.test(text);
  const doneDeliverables = deliverables.filter(isDone).length;
  const deliverableLimit = Math.max(1, size.contentRows - 7);
  const deliverableWindow = panelWindow(deliverables.length, selectedDeliverable, deliverableLimit);
  const visibleDeliverables = deliverables.slice(deliverableWindow.start, deliverableWindow.end);
  const overflow = deliverableWindow.above + deliverableWindow.below;

  return (
    <MonitorShell
      accent={theme.brand}
      icon={glyphs.goal}
      title="GOAL"
      kicker={size.columns >= 90 ? 'mission control' : undefined}
      right={
        <Text>
          <Text color={stateColor} bold>
            {stateIcon} {goal.goalState.toUpperCase()}
          </Text>
          <Text color={coordinatorRunning ? theme.success : theme.textMuted}>
            {' '}
            ● coordinator {coordinatorRunning ? 'on' : 'off'}
          </Text>
        </Text>
      }
      footer={
        <Box gap={2}>
          {deliverables.length > 0 ? (
            <KeyCap keyName="↑↓" label="deliverable" color={theme.brand} />
          ) : null}
          {coordinatorRunning ? (
            <KeyCap keyName="S" label="stop coordinator" color={theme.error} />
          ) : (
            <KeyCap keyName="C" label="start coordinator" color={theme.success} />
          )}
          <KeyCap keyName="F9" label="close" color={theme.brand} />
        </Box>
      }
    >
      <Box flexDirection="column" marginTop={1} paddingX={1}>
        <Text color={theme.textMuted}>MISSION</Text>
        <Text color={theme.textPrimary} bold>
          {truncatePanelText(displayGoal, size.contentWidth - 2)}
        </Text>
      </Box>

      {goal.refinedGoal && goal.refinedGoal !== goal.goal && size.contentRows >= 12 ? (
        <Box paddingX={1}>
          <Text color={theme.textMuted}>
            original {truncatePanelText(goal.goal, size.contentWidth - 12)}
          </Text>
        </Box>
      ) : null}

      {typeof goal.progress === 'number' && (
        <Box flexDirection="column" marginTop={1}>
          {renderProgressBar(goal.progress, goal.progressTrend, size.columns >= 90 ? 20 : 12)}
          {goal.progressNote && (
            <Text color={theme.textMuted}>
              {' '}
              {truncatePanelText(goal.progressNote, size.contentWidth - 4)}
            </Text>
          )}
        </Box>
      )}

      {deliverables.length > 0 && (
        <Box flexDirection="column" marginTop={1}>
          <Text color={theme.textMuted} bold>
            DELIVERABLES {doneDeliverables}/{deliverables.length}
          </Text>
          {visibleDeliverables.map((d, i) => {
            const done = isDone(d);
            const absoluteIndex = deliverableWindow.start + i;
            const isSelected = absoluteIndex === selectedDeliverable;
            return (
              <Box key={absoluteIndex}>
                <Text color={isSelected ? theme.brand : theme.textMuted}>
                  {isSelected ? '› ' : '  '}
                </Text>
                <Text color={done ? theme.success : theme.textSecondary}>
                  {done ? '✓' : '○'} {truncatePanelText(d, size.contentWidth - 6)}
                </Text>
              </Box>
            );
          })}
          {overflow > 0 ? (
            <Text color={theme.textMuted}>
              {' '}
              {deliverableWindow.above > 0 ? `↑ ${deliverableWindow.above} earlier` : ''}
              {deliverableWindow.above > 0 && deliverableWindow.below > 0 ? ' · ' : ''}
              {deliverableWindow.below > 0 ? `↓ ${deliverableWindow.below} later` : ''}
            </Text>
          ) : null}
        </Box>
      )}

      <Box marginTop={1} gap={1}>
        <Text color={theme.textMuted}>
          ITERATIONS <Text color={theme.textSecondary}>{goal.iterations}</Text>
        </Text>
        {goal.lastTask ? (
          <Text color={theme.textMuted}>
            {' '}
            LAST{' '}
            <Text color={theme.textSecondary}>
              {truncatePanelText(goal.lastTask, Math.max(12, size.contentWidth - 32))}
            </Text>
          </Text>
        ) : null}
      </Box>
    </MonitorShell>
  );
}

function renderProgressBar(progress: number, trend?: string, width = 20): React.ReactElement {
  const pct = Math.min(100, Math.max(0, Math.round(progress)));
  const filled = Math.round((pct / 100) * width);
  const empty = width - filled;

  const trendIcon =
    trend === 'accelerating' ? ' 🚀' : trend === 'stalling' ? ' ⚠️' : trend === 'steady' ? ' ➡️' : '';

  return (
    <Box>
      <Text color={theme.textMuted}>PROGRESS </Text>
      <Text color={theme.success}>[{'█'.repeat(filled)}</Text>
      <Text color={theme.textMuted}>{'░'.repeat(empty)}]</Text>
      <Text color={theme.textPrimary} bold>
        {' '}
        {pct}%
      </Text>
      {trend && (
        <Text color={trend === 'stalling' ? theme.warn : theme.textMuted}>
          {trendIcon} {trend}
        </Text>
      )}
    </Box>
  );
}
