import { getBoard, type KanbanBoard, type KanbanTask, listBoards } from '@wrongstack/kanban';
import type React from 'react';
import { useEffect, useMemo, useState } from 'react';
import type { GoalSummary } from '../app-state.js';
import { Box, Text, useInput } from '../ink.js';
import { theme } from '../theme.js';
import { glyphs } from '../ui-glyphs.js';
import { usePanelShortcutsEnabled } from './monitor-shell.js';
import { fmtPct } from './status-bar-format.js';

interface GoalKanbanPanelProps {
  projectRoot: string;
  goal: GoalSummary | null;
  onClose: () => void;
}

/**
 * Goal Kanban panel — a visual progress board shown when a goal is active
 * and an autonomy engine is running. Displays the goal-linked kanban board
 * tasks in columns (Backlog → In Progress → Done) with live auto-refresh.
 */
export function GoalKanbanPanel({
  projectRoot,
  goal,
  onClose,
}: GoalKanbanPanelProps): React.ReactElement {
  const [board, setBoard] = useState<KanbanBoard | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Load the goal-linked kanban board
  const loadBoard = async (quiet = false) => {
    if (!projectRoot) return;
    if (!quiet) setLoading(true);
    setError(null);
    try {
      // Find the goal board by exact tag match
      const goalTag = buildGoalTag(goal);
      const boards = await listBoards(projectRoot);
      // Match using exact normalized tag equality — never substring match,
      // which would select the wrong board when goal-tag prefixes overlap
      // (e.g. "goal:auth" vs "goal:authentication").
      const matched = boards.find((b) => b.tags?.some((t) => normalizeTag(t) === goalTag));
      // Fallback: pick any board with "🎯" in title
      const fallback = !matched
        ? boards.find((b) => b.title.includes('🎯') || b.title.includes('Goal'))
        : undefined;
      const target = matched ?? fallback ?? null;
      if (target) {
        const loaded = await getBoard(projectRoot, target.id);
        setBoard(loaded);
      } else {
        setBoard(null);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setBoard(null);
    } finally {
      if (!quiet) setLoading(false);
    }
  };

  // Initial load
  useEffect(() => {
    void loadBoard();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectRoot, goal?.goal]);

  // Auto-refresh every 2s so the kanban stays live during autonomy runs
  useEffect(() => {
    const interval = setInterval(() => {
      void loadBoard(true);
    }, 2_000);
    return () => clearInterval(interval);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectRoot, board?.id]);

  const sortedColumns = useMemo(
    () => [...(board?.columns ?? [])].sort((a, b) => a.order - b.order),
    [board],
  );

  const displayGoal = (goal?.refinedGoal || goal?.goal || '').replace(/\s+/g, ' ').trim();

  const shortcutsEnabled = usePanelShortcutsEnabled();
  useInput((_input, key) => {
    if (key.escape || (shortcutsEnabled && _input === 'q')) {
      onClose();
    }
  });

  return (
    <Box
      flexDirection="column"
      borderStyle="round"
      borderColor={theme.brand}
      paddingX={1}
      paddingY={0}
    >
      {/* ── Header ── */}
      <Box flexDirection="row" gap={1} marginBottom={1}>
        <Text bold color={theme.brand}>
          {glyphs.goal} GOAL KANBAN
        </Text>
        <Text color={theme.textMuted}>|</Text>
        <Text color={theme.textPrimary} bold wrap="truncate">
          {truncateText(displayGoal, 50)}
        </Text>
        {board ? (
          <>
            <Text color={theme.textMuted}>|</Text>
            <Text color={theme.textMuted}>
              {board.tasks.length} task{board.tasks.length !== 1 ? 's' : ''}
            </Text>
          </>
        ) : null}
        <Text color={theme.textMuted}>| Esc/q close</Text>
      </Box>

      {/* ── Goal progress header ── */}
      {renderGoalProgressHeader(goal)}

      {/* ── Content ── */}
      {loading ? (
        <Text color={theme.textMuted}>Loading goal kanban…</Text>
      ) : error ? (
        <Text color={theme.error}>Error: {error}</Text>
      ) : !board ? (
        <Box flexDirection="column">
          <Text color={theme.textMuted}>
            {goal?.goal
              ? 'Goal kanban board not yet created. Run /goal set to create one.'
              : 'No goal set. Use /goal set <mission> first.'}
          </Text>
          <Text color={theme.textMuted} dimColor>
            The goal kanban auto-creates when you set a goal with deliverables.
          </Text>
        </Box>
      ) : sortedColumns.length === 0 ? (
        <Text color={theme.textMuted}>Board has no columns yet.</Text>
      ) : (
        <Box flexDirection="row" gap={1}>
          {sortedColumns.slice(0, 5).map((column) => {
            const colTasks = board.tasks
              .filter((t) => t.columnId === column.id)
              .sort((a, b) => a.order - b.order);
            return (
              <Box
                key={column.id}
                flexDirection="column"
                width={Math.max(20, Math.floor((80 - sortedColumns.length) / sortedColumns.length))}
                borderStyle="single"
                borderColor={theme.textMuted}
                paddingX={1}
              >
                <Text bold color={columnColor(column.title)} wrap="truncate">
                  {columnIcon(column.title)} {column.title}{' '}
                  <Text color={theme.textMuted}>({colTasks.length})</Text>
                </Text>
                {colTasks.length === 0 ? (
                  <Text color={theme.textMuted} dimColor>
                    {' '}
                    —
                  </Text>
                ) : (
                  colTasks.slice(0, 12).map((task) => <TaskCard key={task.id} task={task} />)
                )}
                {colTasks.length > 12 ? (
                  <Text color={theme.textMuted} dimColor>
                    {' '}
                    … {colTasks.length - 12} more
                  </Text>
                ) : null}
              </Box>
            );
          })}
        </Box>
      )}

      {/* ── Footer — live status ── */}
      {board && !loading ? <Box marginTop={1}>{renderBoardSummary(board, goal)}</Box> : null}
    </Box>
  );
}

// ── Sub-components ────────────────────────────────────────────────────────

function TaskCard({ task }: { task: KanbanTask }): React.ReactElement {
  const icon =
    task.status === 'completed'
      ? '✅'
      : task.status === 'blocked'
        ? '🚫'
        : task.status === 'in_progress'
          ? '🔄'
          : task.status === 'failed'
            ? '❌'
            : task.status === 'review'
              ? '👁'
              : '○';

  const color_ =
    task.status === 'completed'
      ? theme.success
      : task.status === 'blocked'
        ? theme.error
        : task.status === 'in_progress'
          ? theme.accent
          : theme.textSecondary;

  return (
    <Box>
      <Text color={color_} wrap="truncate">
        {' '}
        {icon} {task.title}
      </Text>
      {task.assignedAgent ? (
        <Text color={theme.textMuted} dimColor>
          {' '}
          @{task.assignedAgent}
        </Text>
      ) : null}
    </Box>
  );
}

function renderGoalProgressHeader(goal: GoalSummary): React.ReactElement | null {
  if (!goal) return null;
  const displayGoal = (goal.refinedGoal || goal.goal || '').replace(/\s+/g, ' ').trim();
  if (!displayGoal) return null;

  const deliverables = goal.deliverables ?? [];
  const doneDeliverables = deliverables.filter((d) => /^\[[x✓]\]|✅|\(done\)/i.test(d)).length;
  const pct =
    typeof goal.progress === 'number'
      ? goal.progress
      : deliverables.length > 0
        ? Math.round((doneDeliverables / deliverables.length) * 100)
        : 0;

  const barWidth = 20;
  const filled = Math.round((pct / 100) * barWidth);
  const empty = barWidth - filled;

  const trendIcon =
    goal.progressTrend === 'accelerating'
      ? '🚀'
      : goal.progressTrend === 'stalling'
        ? '⚠️'
        : goal.progressTrend === 'steady'
          ? '➡️'
          : '';

  return (
    <Box marginBottom={1} flexDirection="column">
      <Box flexDirection="row" gap={1}>
        <Text color={theme.textMuted}>PROGRESS</Text>
        <Text color={theme.success}>[{'█'.repeat(filled)}</Text>
        <Text color={theme.textMuted}>{'░'.repeat(empty)}]</Text>
        <Text color={theme.textPrimary} bold>
          {fmtPct(pct)}
        </Text>
        {trendIcon ? <Text color={theme.textMuted}>{trendIcon}</Text> : null}
        <Text color={theme.textMuted}>
          | {doneDeliverables}/{deliverables.length} deliverables
        </Text>
        <Text color={theme.textMuted}>
          | {goal.iterations} iteration{goal.iterations !== 1 ? 's' : ''}
        </Text>
      </Box>
      {goal.progressNote ? (
        <Text color={theme.textMuted} dimColor>
          {' '}
          {goal.progressNote}
        </Text>
      ) : null}
    </Box>
  );
}

function renderBoardSummary(board: KanbanBoard, _goal: GoalSummary): React.ReactElement | null {
  const done = board.tasks.filter((t) => t.status === 'completed').length;
  const inProgress = board.tasks.filter((t) => t.status === 'in_progress').length;
  const blocked = board.tasks.filter((t) => t.status === 'blocked').length;
  const pending = board.tasks.length - done - inProgress - blocked;

  const summaryParts = [`📊 ${board.title.replace(/^🎯\s*/, '')}`];
  if (pending > 0) summaryParts.push(`❍ ${pending} pending`);
  if (inProgress > 0) summaryParts.push(`🔄 ${inProgress} active`);
  if (blocked > 0) summaryParts.push(`🚫 ${blocked} blocked`);
  if (done > 0) summaryParts.push(`✅ ${done} done`);

  return (
    <Box flexDirection="row" gap={1}>
      <Text color={theme.textMuted} dimColor>
        {summaryParts.join(' · ')}
      </Text>
    </Box>
  );
}

// ── Helpers ───────────────────────────────────────────────────────────────

function truncateText(text: string, max: number): string {
  if (text.length <= max) return text;
  return text.slice(0, Math.max(0, max - 1)) + '…';
}

function columnColor(title: string): string {
  const low = title.toLowerCase();
  if (low.includes('done') || low.includes('complete') || low.includes('finished')) return 'green';
  if (low.includes('progress') || low.includes('doing') || low.includes('working')) return 'cyan';
  if (low.includes('backlog') || low.includes('todo') || low.includes('open')) return 'yellow';
  if (low.includes('review') || low.includes('test')) return 'magenta';
  if (low.includes('block') || low.includes('wait')) return 'red';
  return 'white';
}

function columnIcon(title: string): string {
  const low = title.toLowerCase();
  if (low.includes('done') || low.includes('complete') || low.includes('finished')) return '✅';
  if (low.includes('progress') || low.includes('doing') || low.includes('working')) return '🔄';
  if (low.includes('backlog') || low.includes('todo') || low.includes('open')) return '📋';
  if (low.includes('review') || low.includes('test')) return '👁';
  if (low.includes('block') || low.includes('wait')) return '⏸';
  return '○';
}

function buildGoalTag(goal: GoalSummary | null): string {
  const text = (goal?.refinedGoal || goal?.goal || '')
    .replace(/\s+/g, '-')
    .slice(0, 24)
    .toLowerCase();
  return `goal:${text}`;
}

/** Normalize a kanban tag for precise equality comparison. Strips any
 *  extraneous prefix/suffix whitespace and lowercases. */
function normalizeTag(tag: string): string {
  return tag.trim().toLowerCase();
}
