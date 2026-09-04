import type {
  TaskPriority,
  TaskStatus,
  TaskType,
  TaskProgress as TaskGraphProgress,
} from '../types/task-graph.js';
import { color } from './color.js';

// Re-export graph types for convenience
export type { TaskStatus, TaskPriority, TaskType };

// ---------------------------------------------------------------------------
// Session-level task item — mirrors TaskNode but with string timestamps
// for JSON serialization and a flat-list structure (no graph edges).
// ---------------------------------------------------------------------------

export interface TaskItem {
  id: string;
  title: string;
  description?: string | undefined;
  type: TaskType;
  priority: TaskPriority;
  status: TaskStatus;
  /** IDs of tasks this one depends on. */
  dependsOn?: string[] | undefined;
  /** Agent/subagent name assigned to this task. */
  assignee?: string | undefined;
  estimateHours?: number | undefined;
  tags?: string[] | undefined;
  createdAt: string;
  updatedAt: string;
}

// ---------------------------------------------------------------------------
// Progress (re-export computeTaskItemProgress adapted for TaskItem[])
// ---------------------------------------------------------------------------

export function computeTaskItemProgress(tasks: TaskItem[]): TaskGraphProgress {
  if (!Array.isArray(tasks)) {
    return {
      total: 0,
      pending: 0,
      inProgress: 0,
      blocked: 0,
      failed: 0,
      review: 0,
      completed: 0,
      percentComplete: 0,
      estimatedHours: 0,
      actualHours: 0,
    };
  }
  let completed = 0;
  let pending = 0;
  let inProgress = 0;
  let blocked = 0;
  let failed = 0;
  let review = 0;
  let estimatedHours = 0;
  const actualHours = 0;
  for (const t of tasks) {
    switch (t.status) {
      case 'completed':
        completed++;
        break;
      case 'pending':
        pending++;
        break;
      case 'in_progress':
        inProgress++;
        break;
      case 'blocked':
        blocked++;
        break;
      case 'failed':
        failed++;
        break;
      case 'review':
        review++;
        break;
    }
    estimatedHours += t.estimateHours ?? 0;
  }
  return {
    total: tasks.length,
    pending,
    inProgress,
    blocked,
    failed,
    review,
    completed,
    percentComplete: tasks.length > 0 ? Math.round((completed / tasks.length) * 100) : 0,
    estimatedHours,
    actualHours,
  };
}

// ---------------------------------------------------------------------------
// Icons
// ---------------------------------------------------------------------------

const STATUS_ICON: Record<TaskStatus, string> = {
  pending: '○',
  in_progress: '◐',
  blocked: '⊘',
  failed: '✗',
  review: '◑',
  completed: '●',
};

const PRIORITY_ICON: Record<TaskPriority, string> = {
  critical: '🔴',
  high: '🟠',
  medium: '🟡',
  low: '🟢',
};

const TYPE_ICON: Record<TaskType, string> = {
  feature: '⚡',
  bugfix: '🐛',
  refactor: '♻️',
  docs: '📝',
  test: '🧪',
  chore: '🔧',
};

// ---------------------------------------------------------------------------
// Formatting
// ---------------------------------------------------------------------------

export function formatTaskProgress(tasks: TaskItem[]): string {
  if (!Array.isArray(tasks) || tasks.length === 0) return 'No tasks.';
  const p = computeTaskItemProgress(tasks);
  if (p.total === 0) return 'No tasks.';
  const barWidth = 24;
  const filled = Math.round((p.percentComplete / 100) * barWidth);
  const empty = barWidth - filled;
  const bar = '█'.repeat(filled) + '░'.repeat(empty);
  return [
    `${color.bold('Tasks')} [${bar}] ${p.percentComplete}%`,
    `  ${color.green('●')} ${p.completed} done │ ${color.yellow('◐')} ${p.inProgress} active │ ${color.dim('○')} ${p.pending} pending │ ⊘ ${p.blocked} blocked │ ✗ ${p.failed} failed`,
    p.estimatedHours > 0 ? `  ${color.dim(`est. ${p.estimatedHours}h`)}` : '',
  ]
    .filter(Boolean)
    .join('\n');
}

export function formatTaskList(tasks: TaskItem[]): string {
  if (!Array.isArray(tasks) || tasks.length === 0) return 'No tasks.';

  // Group by status
  const order: TaskStatus[] = [
    'in_progress',
    'blocked',
    'review',
    'pending',
    'failed',
    'completed',
  ];
  const groups = new Map<TaskStatus, TaskItem[]>();
  for (const t of tasks) {
    const list = groups.get(t.status) ?? [];
    list.push(t);
    groups.set(t.status, list);
  }

  const lines: string[] = [];
  lines.push(color.dim(`Tasks (${tasks.length} total):`));

  for (const status of order) {
    const group = groups.get(status);
    if (!group || group.length === 0) continue;
    const icon = STATUS_ICON[status];
    lines.push(`  ${icon} ${status.toUpperCase()} (${group.length})`);
    for (const t of group) {
      const prio = PRIORITY_ICON[t.priority];
      const type = TYPE_ICON[t.type];
      const deps =
        t.dependsOn && t.dependsOn.length > 0
          ? ` ${color.dim('←')} ${color.dim(t.dependsOn.map((d) => d.slice(0, 8)).join(', '))}`
          : '';
      const who = t.assignee ? ` ${color.dim(`@${t.assignee}`)}` : '';
      const hrs = t.estimateHours ? ` ${color.dim(`${t.estimateHours}h`)}` : '';
      lines.push(`    ${type} ${prio} ${t.title}${deps}${who}${hrs}`);
    }
  }

  return lines.join('\n');
}
