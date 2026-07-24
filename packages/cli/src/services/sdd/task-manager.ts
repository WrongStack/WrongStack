import { expectDefined } from '@wrongstack/core/utils';
import type { TaskProgress } from '@wrongstack/core/types';
import { DefaultTaskStore, renderProgress, TaskTracker } from '@wrongstack/sdd';
import { sddState } from './state.js';

export type { TaskProgress };
export { renderProgress };

/**
 * Format elapsed milliseconds as a human-readable string.
 */
export function formatElapsed(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  const remS = s % 60;
  if (m < 60) return remS > 0 ? `${m}m ${remS}s` : `${m}m`;
  const h = Math.floor(m / 60);
  const remM = m % 60;
  return `${h}h ${remM}m`;
}

function addTaskToTracker(tracker: TaskTracker, task: Record<string, unknown>): void {
  tracker.addNode({
    title: String(task.title),
    description: String(task.description ?? ''),
    type: (['feature', 'bugfix', 'refactor', 'docs', 'test', 'chore'].includes(String(task.type))
      ? String(task.type)
      : 'feature') as 'feature' | 'bugfix' | 'refactor' | 'docs' | 'test' | 'chore',
    priority: (['critical', 'high', 'medium', 'low'].includes(String(task.priority))
      ? String(task.priority)
      : 'medium') as 'critical' | 'high' | 'medium' | 'low',
    status: 'pending',
    estimateHours: Number(task.estimateHours) || 2,
    tags: Array.isArray(task.tags) ? task.tags.map(String) : [],
  });
}

export async function trySaveTasksFromAIOutput(aiOutput: string): Promise<boolean> {
  const builder = sddState.getBuilder();
  if (!builder) return false;
  const session = builder.getSession();
  if (!session.spec) return false;

  const json = builder.extractJSONArray(aiOutput);
  if (!json) return false;

  let tasks: Array<Record<string, unknown>>;
  try {
    tasks = JSON.parse(json);
  } catch {
    return false;
  }
  if (!Array.isArray(tasks) || tasks.length === 0) return false;

  const validTasks = tasks.filter(
    (t) => t && typeof t === 'object' && typeof t.title === 'string' && t.title.length > 0,
  );
  if (validTasks.length === 0) return false;

  const existingTracker = sddState.getTaskTracker();
  if (existingTracker) {
    for (const task of validTasks) addTaskToTracker(existingTracker, task);
    return true;
  }

  const store = new DefaultTaskStore();
  const tracker = new TaskTracker({ store });
  const graph = await tracker.createGraph(session.spec.id, session.spec.title);
  for (const task of validTasks) addTaskToTracker(tracker, task);
  sddState.setTaskStore(store);
  sddState.setTaskTracker(tracker);
  sddState.setTaskGraphId(graph.id);
  builder.setTaskGraphId(graph.id);
  return true;
}

export function getTaskProgress(): TaskProgress | null {
  const tracker = sddState.getTaskTracker();
  if (!tracker) return null;
  return tracker.getProgress();
}

export function getCurrentTask(): {
  id: string;
  title: string;
  description: string;
  priority: string;
  estimateHours: number;
  tags: string[];
  startedAt: number | undefined;
} | null {
  const tracker = sddState.getTaskTracker();
  if (!tracker) return null;
  const nodes = tracker.getAllNodes({ status: ['in_progress'] });
  if (nodes.length === 0) return null;
  const n = expectDefined(nodes[0]);
  return {
    id: n.id,
    title: n.title,
    description: n.description,
    priority: n.priority,
    estimateHours: n.estimateHours ?? 0,
    tags: n.tags ?? [],
    startedAt: n.startedAt,
  };
}

export function advanceToNextTask(): boolean {
  const tracker = sddState.getTaskTracker();
  if (!tracker) return false;
  const pending = tracker.getAllNodes({ status: ['pending'] });
  for (const n of pending) {
    if (tracker.canStart(n.id)) {
      tracker.updateNodeStatus(n.id, 'in_progress');
      return true;
    }
  }
  return false;
}

export function getTaskListText(): string | null {
  const tracker = sddState.getTaskTracker();
  if (!tracker) return null;
  const nodes = tracker.getAllNodes();
  if (nodes.length === 0) return null;
  return nodes
    .map((n, i) => {
      const status = n.status === 'completed' ? '✅' : n.status === 'in_progress' ? '🔄' : '⏳';
      return `${i + 1}. ${status} [${n.priority}] ${n.title}`;
    })
    .join('\n');
}

export function renderTaskListWithProgress(): string | null {
  const tracker = sddState.getTaskTracker();
  if (!tracker) return null;
  const nodes = tracker.getAllNodes();
  if (nodes.length === 0) return null;

  const progress = tracker.getProgress();
  const phase = sddState.getPhase();
  const phaseLabel: Record<string, string> = {
    questioning: '❓ Questioning',
    spec_review: '📋 Spec Review',
    implementation: '🏗️ Implementation',
    task_review: '📝 Task Review',
    executing: '⚡ Executing',
    done: '✅ Done',
  };
  const lines = [
    `**${phaseLabel[phase ?? ''] ?? phase} — Task Status**`,
    '',
    renderProgress(progress),
    '',
  ];

  const sorted = [...nodes].sort((a, b) => {
    const order: Record<string, number> = {
      in_progress: 0,
      pending: 1,
      review: 2,
      blocked: 3,
      failed: 4,
      completed: 5,
    };
    return (order[a.status] ?? 6) - (order[b.status] ?? 6);
  });
  for (let i = 0; i < sorted.length; i++) {
    const n = expectDefined(sorted[i]);
    const status =
      n.status === 'completed'
        ? '✅'
        : n.status === 'in_progress'
          ? '🔄'
          : n.status === 'failed'
            ? '❌'
            : n.status === 'blocked'
              ? '🚫'
              : n.status === 'review'
                ? '👁'
                : '⏳';
    const title = n.title.length > 50 ? n.title.slice(0, 49) + '…' : n.title;
    let elapsed = '';
    if (n.status === 'in_progress' && n.startedAt)
      elapsed = ` · ${formatElapsed(Date.now() - n.startedAt)}`;
    lines.push(`${i + 1}. ${status} ${title}${elapsed}`);
  }
  return lines.join('\n');
}

export function getCurrentExecutingContext(): string | null {
  const tracker = sddState.getTaskTracker();
  if (!tracker) return null;
  const nodes = tracker.getAllNodes({ status: ['in_progress'] });
  if (nodes.length === 0) return null;
  const n = expectDefined(nodes[0]);
  const elapsed = n.startedAt ? ` · elapsed: ${formatElapsed(Date.now() - n.startedAt)}` : '';
  const progress = tracker.getProgress();
  return [
    `**NOW EXECUTING:** "${n.title}"${elapsed}`,
    `Description: ${n.description.split('\n')[0] ?? '(none)'}`,
    `Priority: ${n.priority} · Est: ${n.estimateHours ?? 0}h · Tags: ${(n.tags ?? []).join(', ') || 'none'}`,
    `Progress: ${progress.completed}/${progress.total} tasks (${progress.percentComplete}%)`,
  ].join('\n');
}

/**
 * Resolve a `/sdd done|skip|fail|review <N|title>` argument to a single task
 * node. Tries a 1-based index into the given (already filtered/sorted) node
 * list first, then a bidirectional case-insensitive title-substring match.
 * Centralizes the matching the four mutation subcommands used to duplicate.
 */
export function matchTaskNode<T extends { id: string; title: string }>(
  nodes: T[],
  query: string,
): T | null {
  const trimmed = query.trim();
  if (!trimmed) return null;
  const num = Number(trimmed);
  if (!Number.isNaN(num) && num >= 1 && num <= nodes.length) {
    return nodes[num - 1] ?? null;
  }
  const q = trimmed.toLowerCase();
  return (
    nodes.find((n) => n.title.toLowerCase().includes(q) || q.includes(n.title.toLowerCase())) ??
    null
  );
}

export function markTaskCompleted(taskTitle: string): boolean {
  const tracker = sddState.getTaskTracker();
  if (!tracker) return false;
  const nodes = tracker.getAllNodes({ status: ['pending', 'in_progress'] });
  const match = nodes.find(
    (n) =>
      n.title.toLowerCase().includes(taskTitle.toLowerCase()) ||
      taskTitle.toLowerCase().includes(n.title.toLowerCase()),
  );
  if (!match) return false;
  tracker.updateNodeStatus(match.id, 'completed');
  return true;
}

export function getTaskGraphId(): string | null {
  return sddState.getTaskGraphId();
}
export function getTaskTrackerExport(): TaskTracker | null {
  return sddState.getTaskTracker();
}
