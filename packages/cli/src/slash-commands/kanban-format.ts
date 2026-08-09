import { color } from '@wrongstack/core/utils';
import {
  areDependenciesMet,
  findBlockedTasks,
  type KanbanBoard,
  type KanbanBoardSummary,
  type KanbanOrchestrationSnapshot,
  type KanbanTask,
} from '@wrongstack/kanban';

export const HEADING = (s: string) => color.bold(s);
export const LABEL = (s: string) => color.cyan(s);
const VALUE = (s: string) => s;
export const DIM = (s: string) => color.dim(s);
const TAG_CRITICAL = (s: string) => color.bold(color.red(s));
const TAG_HIGH = (s: string) => color.yellow(s);
const TAG_MEDIUM = (s: string) => s;
const TAG_LOW = (s: string) => color.dim(s);
const STATUS_BADGE: Record<string, (s: string) => string> = {
  pending: (s) => color.dim(s),
  in_progress: (s) => color.blue(s),
  blocked: (s) => color.red(s),
  completed: (s) => color.green(s),
  failed: (s) => color.bold(color.red(s)),
};

function fmtPriority(p: string): string {
  const map: Record<string, (s: string) => string> = {
    critical: TAG_CRITICAL,
    high: TAG_HIGH,
    medium: TAG_MEDIUM,
    low: TAG_LOW,
  };
  return (map[p] ?? TAG_MEDIUM)(p.toUpperCase());
}

function fmtStatus(s: string): string {
  return (STATUS_BADGE[s] ?? ((x: string) => x))(s.replace('_', ' '));
}

function fmtTimestamp(iso: string | undefined): string {
  if (!iso) return DIM('never');
  const d = new Date(iso);
  return d.toLocaleString();
}

export function fmtAge(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

export function formatBoardList(boards: KanbanBoardSummary[]): string {
  if (!boards.length) return DIM('No kanban boards yet. Use /kanban create <title> to start one.');
  const lines: string[] = [HEADING(`Kanban Boards (${boards.length})`), ''];
  for (const b of boards) {
    const pct = b.taskCount > 0 ? Math.round((b.completedTaskCount / b.taskCount) * 100) : 0;
    const progress = b.taskCount > 0 ? ` ${pct}% done` : ' empty';
    lines.push(
      `  ${LABEL(b.id.slice(0, 8))}  ${VALUE(b.title)}  ${DIM(`${b.columnCount} cols · ${b.taskCount} tasks${progress}`)}`,
    );
  }
  return lines.join('\n');
}

export function formatBoardDetail(board: KanbanBoard): string {
  const lines: string[] = [];
  lines.push(HEADING(`📋 ${board.title}`));
  if (board.description) lines.push(DIM(board.description));
  lines.push('');
  lines.push(`  ${LABEL('ID')}:      ${board.id}`);
  lines.push(`  ${LABEL('Created')}: ${fmtTimestamp(board.createdAt)}`);
  lines.push(`  ${LABEL('Updated')}: ${fmtTimestamp(board.updatedAt)}`);
  if (board.tags?.length) lines.push(`  ${LABEL('Tags')}:    ${board.tags.join(', ')}`);
  lines.push('');

  for (const col of board.columns) {
    const colTasks = board.tasks
      .filter((t) => t.columnId === col.id)
      .sort((a, b) => a.order - b.order);

    const wip =
      col.wipLimit && col.wipLimit > 0 ? DIM(` [${colTasks.length}/${col.wipLimit}]`) : '';
    lines.push(HEADING(`  ${col.title}${wip}`));
    if (col.description) lines.push(`   ${DIM(col.description)}`);

    if (!colTasks.length) {
      lines.push(`   ${DIM('— empty —')}`);
    } else {
      for (const task of colTasks) {
        const depMarker = task.dependsOn?.length ? DIM(` ⛓️${task.dependsOn.length}`) : '';
        const chainMarker = task.chain ? DIM(` #${task.chain.order + 1}`) : '';
        const agentMarker = task.assignedAgent ? DIM(` 👤${task.assignedAgent}`) : '';
        if (task.status === 'completed') {
          lines.push(`   ✅ ${task.title}${agentMarker}${depMarker}${chainMarker}`);
        } else if (task.status === 'blocked') {
          lines.push(`   🚫 ${task.title}${agentMarker}${depMarker}${chainMarker}`);
        } else if (task.status === 'in_progress') {
          lines.push(`   🔄 ${task.title}${agentMarker}${depMarker}${chainMarker}`);
        } else {
          lines.push(`   ○ ${task.title}${agentMarker}${depMarker}${chainMarker}`);
        }
        lines.push(
          `      ${DIM(task.id.slice(0, 8))} ${fmtPriority(task.priority)} ${fmtStatus(task.status)}`,
        );
      }
    }
    lines.push('');
  }

  return lines.join('\n');
}

export function formatTaskDetail(board: KanbanBoard, task: KanbanTask): string {
  const lines: string[] = [];
  lines.push(HEADING(`📌 ${task.title}`));
  lines.push(`  ${LABEL('ID')}:       ${task.id}`);
  lines.push(`  ${LABEL('Status')}:   ${fmtStatus(task.status)}`);
  lines.push(`  ${LABEL('Priority')}: ${fmtPriority(task.priority)}`);
  if (task.description) lines.push(`  ${LABEL('Desc')}:    ${task.description}`);

  const col = board.columns.find((c) => c.id === task.columnId);
  lines.push(`  ${LABEL('Column')}:   ${col?.title ?? task.columnId}`);

  if (task.assignedAgent) lines.push(`  ${LABEL('Agent')}:    ${task.assignedAgent}`);
  if (task.assignee) lines.push(`  ${LABEL('Assignee')}: ${task.assignee}`);

  if (task.chain) {
    lines.push(`  ${LABEL('Chain')}:   ${task.chain.chainId} #${task.chain.order + 1}`);
    if (task.chain.previousTaskId)
      lines.push(`  ${LABEL('Prev')}:    ${task.chain.previousTaskId}`);
    if (task.chain.nextTaskId) lines.push(`  ${LABEL('Next')}:    ${task.chain.nextTaskId}`);
  }

  if (task.parentTaskId) lines.push(`  ${LABEL('Parent')}:  ${task.parentTaskId}`);
  if (task.childTaskIds?.length)
    lines.push(`  ${LABEL('Children')}: ${task.childTaskIds.join(', ')}`);
  if (task.mergedIntoTaskId) lines.push(`  ${LABEL('Merged into')}: ${task.mergedIntoTaskId}`);
  if (task.mergedFromTaskIds?.length) {
    lines.push(`  ${LABEL('Merged from')}: ${task.mergedFromTaskIds.join(', ')}`);
  }

  if (task.dependsOn?.length) {
    const depNames = task.dependsOn
      .map((depId: string) => {
        const dep = board.tasks.find((t) => t.id === depId);
        return dep ? `${dep.title} (${dep.status})` : depId;
      })
      .join(', ');
    lines.push(`  ${LABEL('Depends on')}: ${depNames}`);
    lines.push(
      `  ${LABEL('Met?')}:     ${areDependenciesMet(board, task.id) ? color.green('Yes') : color.red('No')}`,
    );
  }

  const blocked = findBlockedTasks(board, task.id);
  if (blocked.length) {
    lines.push(`  ${LABEL('Blocks')}:    ${blocked.map((t) => t.title).join(', ')}`);
  }

  if (task.successCriteria?.length) {
    lines.push('');
    lines.push(HEADING('  Success Criteria:'));
    for (const check of task.successCriteria) {
      const icon =
        check.status === 'passed'
          ? '✅'
          : check.status === 'failed'
            ? '❌'
            : check.status === 'skipped'
              ? '⏭️'
              : '⬜';
      lines.push(`   ${icon} ${check.description}`);
      if (check.checkedBy)
        lines.push(
          `       by ${check.checkedBy} ${check.checkedAt ? fmtAge(check.checkedAt) : ''}`,
        );
    }
  }

  if (task.goalMetrics?.length) {
    lines.push('');
    lines.push(HEADING('  Goal Metrics:'));
    for (const metric of task.goalMetrics) {
      const target =
        metric.target !== undefined
          ? ` / ${metric.target}${metric.unit ? ` ${metric.unit}` : ''}`
          : '';
      lines.push(`   ${metric.name}: ${metric.current ?? '—'}${target} ${DIM(metric.status)}`);
      if (metric.notes) lines.push(`      ${DIM(metric.notes)}`);
    }
  }

  if (task.estimatedHours || task.actualHours) {
    lines.push('');
    lines.push(
      `  ${LABEL('Est.')} ${task.estimatedHours ?? '—'}h  Actual: ${task.actualHours ?? '—'}h`,
    );
  }

  if (task.links?.length) {
    lines.push('');
    lines.push(HEADING('  Links:'));
    for (const link of task.links) {
      lines.push(`   🔗 ${link.title ?? link.url} ${DIM(`(${link.type})`)}`);
    }
  }

  if (task.notes?.length) {
    lines.push('');
    lines.push(HEADING('  Notes:'));
    for (const note of task.notes) {
      lines.push(`   💬 ${note.author}: ${note.content} ${DIM(fmtAge(note.createdAt))}`);
    }
  }

  lines.push('');
  lines.push(`  ${LABEL('Created')}: ${fmtTimestamp(task.createdAt)}`);
  lines.push(`  ${LABEL('Updated')}: ${fmtTimestamp(task.updatedAt)}`);

  return lines.join('\n');
}

export function formatDependencyChain(board: KanbanBoard, taskId: string, depth = 0): string {
  const task = board.tasks.find((t) => t.id === taskId || t.id.startsWith(taskId));
  if (!task) return `  ${DIM('Task not found')}`;

  const prefix = '  '.repeat(depth);
  const statusIcon =
    task.status === 'completed'
      ? '✅'
      : task.status === 'blocked'
        ? '🚫'
        : task.status === 'in_progress'
          ? '🔄'
          : '○';
  const lines: string[] = [`${prefix}${statusIcon} ${task.title} ${DIM(`[${task.status}]`)}`];

  if (task.dependsOn?.length) {
    for (const depId of task.dependsOn) {
      lines.push(formatDependencyChain(board, depId, depth + 1));
    }
  }

  return lines.join('\n');
}

export function formatReadyTasks(
  results: Array<{ board: KanbanBoardSummary; task: KanbanTask }>,
): string {
  if (!results.length) return DIM('No ready kanban tasks.');
  const lines = [HEADING(`Ready Tasks (${results.length})`), ''];
  for (const result of results) {
    const task = result.task;
    const routing =
      task.assignment?.provider || task.assignment?.model
        ? ` ${DIM(`[${[task.assignment?.provider, task.assignment?.model].filter(Boolean).join('/')}]`)}`
        : '';
    const chain = task.chain ? ` ${DIM(`#${task.chain.order + 1}`)}` : '';
    lines.push(
      `  ${LABEL(result.board.id.slice(0, 8))}:${DIM(task.id.slice(0, 8))} ${task.title}${routing}${chain}`,
    );
  }
  return lines.join('\n');
}

export function formatKanbanSnapshot(snapshot: KanbanOrchestrationSnapshot): string {
  const lines = [
    HEADING('Kanban Snapshot'),
    '',
    `  ${LABEL('Boards')}:    ${snapshot.boards.length}`,
    `  ${LABEL('Ready')}:     ${snapshot.ready.length}`,
    `  ${LABEL('Queued')}:    ${snapshot.queued.length}`,
    `  ${LABEL('Running')}:   ${snapshot.running.length}`,
    `  ${LABEL('Blocked')}:   ${snapshot.blocked.length}`,
    `  ${LABEL('Review')}:    ${snapshot.review.length}`,
    `  ${LABEL('Failed')}:    ${snapshot.failed.length}`,
    `  ${LABEL('Completed')}: ${snapshot.completed.length}`,
  ];
  if (snapshot.ready.length) {
    lines.push('', HEADING('Next Ready:'));
    for (const result of snapshot.ready.slice(0, 8)) {
      lines.push(
        `  ${result.board.id.slice(0, 8)}:${result.task.id.slice(0, 8)} ${result.task.title}`,
      );
    }
  }
  return lines.join('\n');
}

export function formatTaskChain(tasks: KanbanTask[]): string {
  if (!tasks.length) return DIM('No tasks in chain.');
  return [
    HEADING(`Task Chain (${tasks[0]?.chain?.chainId ?? 'unknown'})`),
    '',
    ...tasks.map((task, index) => {
      const dep = task.dependsOn?.includes(tasks[index - 1]?.id ?? '') ? DIM(' dep') : '';
      return `  ${index + 1}. ${task.title} ${DIM(task.id.slice(0, 8))} ${fmtStatus(task.status)}${dep}`;
    }),
  ].join('\n');
}
