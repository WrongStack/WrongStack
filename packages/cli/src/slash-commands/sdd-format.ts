import type { Specification, TaskGraph, TaskNode, TaskProgress } from '@wrongstack/core/types';
import type { AISpecPhase, CriticalPathAnalysis, SpecIndexEntry } from '@wrongstack/sdd';

type FormatElapsed = (ms: number) => string;

export function taskStatusIcon(status: TaskNode['status']): string {
  return status === 'completed'
    ? '✅'
    : status === 'in_progress'
      ? '🔄'
      : status === 'failed'
        ? '❌'
        : status === 'blocked'
          ? '🚫'
          : status === 'review'
            ? '👁'
            : '⏳';
}

export function sortTasksForSddDisplay(nodes: readonly TaskNode[]): TaskNode[] {
  const order: Record<string, number> = {
    in_progress: 0,
    pending: 1,
    review: 2,
    blocked: 3,
    failed: 4,
    completed: 5,
  };
  return [...nodes].sort((a, b) => (order[a.status] ?? 6) - (order[b.status] ?? 6));
}

export function formatSpecList(entries: readonly SpecIndexEntry[]): string {
  const lines = entries.map((e, i) => {
    const status = e.status === 'draft' ? '📝' : e.status === 'approved' ? '✅' : '📋';
    return `${i + 1}. ${status} ${e.title} (${e.version}) — ${e.id.slice(0, 8)}...`;
  });

  return `Saved Specs:\n${lines.join('\n')}`;
}

export function formatCurrentSpec(spec: Specification): string {
  const lines = [
    `═══ Current Spec ═══`,
    '',
    `Title: ${spec.title}`,
    `Version: ${spec.version}`,
    `Status: ${spec.status}`,
    '',
    '## Overview',
    spec.overview,
  ];

  if (spec.requirements.length > 0) {
    lines.push('', `## Requirements (${spec.requirements.length})`);
    for (const r of spec.requirements) {
      const ac = r.acceptanceCriteria.length > 0 ? ` → ${r.acceptanceCriteria.join(', ')}` : '';
      lines.push(`  [${r.priority}] ${r.description}${ac}`);
    }
  }

  return lines.join('\n');
}

export function formatTaskListView(
  nodes: readonly TaskNode[],
  progress: TaskProgress,
  phase: string,
  renderProgress: (progress: TaskProgress) => string,
  formatElapsed: FormatElapsed,
): string {
  const phaseLabel: Record<string, string> = {
    questioning: '❓ Questioning',
    spec_review: '📋 Spec Review',
    implementation: '🏗️ Implementation',
    task_review: '📝 Task Review',
    executing: '⚡ Executing',
    done: '✅ Done',
  };

  const lines = [
    `╭─── ${phaseLabel[phase] ?? phase} ───────────────────────────╮`,
    '',
    renderProgress(progress),
    '',
    `  #    Status  Priority  Task`,
    `  ${'─'.repeat(49)}`,
  ];

  for (let i = 0; i < nodes.length; i++) {
    const n = nodes[i];
    if (!n) continue;
    const num = `${i + 1}`.padStart(3);
    const prio = n.priority.slice(0, 4).padEnd(5);
    const title = n.title.length > 36 ? n.title.slice(0, 35) + '…' : n.title;
    const elapsed =
      n.status === 'in_progress' && n.startedAt
        ? ` (${formatElapsed(Date.now() - n.startedAt)})`
        : '';
    lines.push(`  ${num}  ${taskStatusIcon(n.status)}     ${prio}   ${title}${elapsed}`);
    if (n.description && n.status !== 'completed') {
      const first = n.description.split('\n')[0] ?? '';
      const truncated = first.length > 42 ? first.slice(0, 41) + '…' : first;
      lines.push(`        ↳ ${truncated}`);
    }
  }

  lines.push('');
  lines.push(`  Commands: /sdd done <N> · /sdd skip <N> · /sdd fail <N> · /sdd review <N>`);
  lines.push(`             /sdd next · /sdd status · /sdd edit <N> · /sdd approve`);
  lines.push(`╰${'─'.repeat(54)}╯`);

  return lines.join('\n');
}

export function formatBlockedTasks(
  blocked: readonly TaskNode[],
  tracker: {
    getBlockers(id: string): string[];
    getNode(id: string): TaskNode | undefined;
  },
): string {
  return [
    `🚫 ${blocked.length} task(s) blocked — waiting on dependencies:`,
    ...blocked.map((b, i) => {
      const blockers = tracker.getBlockers(b.id);
      const blockerNames = blockers.map((id) => tracker.getNode(id)?.title ?? '?').join(', ');
      return `  ${i + 1}. ${b.title} (blocked by: ${blockerNames})`;
    }),
  ].join('\n');
}

export function formatNextTaskView(
  next: TaskNode,
  progress: TaskProgress,
  tracker: {
    getBlockers(id: string): string[];
    getNode(id: string): TaskNode | undefined;
  },
  formatElapsed: FormatElapsed,
): string {
  const blockers = tracker.getBlockers(next.id);
  const blockedBy = blockers
    .filter((id) => tracker.getNode(id)?.status !== 'completed')
    .map((id) => tracker.getNode(id)?.title ?? '?')
    .join(', ');

  const lines = [
    `╭─── NEXT TASK ───────────────────────────────────────────╮`,
    '',
    `  🔄 ${next.title}`,
  ];

  if (next.description) {
    const first = next.description.split('\n')[0] ?? '';
    lines.push(`     ↳ ${first}`);
  }

  const taskElapsed = next.startedAt ? ` ⏱ ${formatElapsed(Date.now() - next.startedAt)}` : '';
  lines.push(
    `  Priority: ${next.priority}  |  Est: ${next.estimateHours}h  |  Tags: ${(next.tags ?? []).join(', ') || 'none'}${taskElapsed}`,
  );

  if (blockedBy) {
    lines.push(`  Blocked by: ${blockedBy}`);
  }

  lines.push('');
  lines.push(
    `  ── Progress: ${progress.completed}/${progress.total} (${progress.percentComplete}%) ──`,
  );
  lines.push('');
  lines.push(`  Run /sdd done <task title or number> when done.`);
  lines.push(`╰${'─'.repeat(55)}╯`);

  return lines.join('\n');
}

export function formatSddStatusView(
  session: {
    id: string;
    title: string;
    phase: AISpecPhase;
    questionCount: number;
    spec?: Specification | undefined;
  },
  progress: TaskProgress | null,
  taskTracker: {
    getAllNodes(filter?: { status?: TaskNode['status'][] }): TaskNode[];
    canStart(id: string): boolean;
  } | null,
  sessionElapsed: number,
  phaseElapsed: number,
  renderProgress: (progress: TaskProgress) => string,
  formatElapsed: FormatElapsed,
): string {
  const phaseEmoji: Record<AISpecPhase, string> = {
    questioning: '❓',
    spec_review: '📋',
    implementation: '🏗️',
    task_review: '📝',
    executing: '⚡',
    done: '✅',
  };
  const phaseLabel: Record<AISpecPhase, string> = {
    questioning: 'Questioning',
    spec_review: 'Spec Review',
    implementation: 'Implementation',
    task_review: 'Task Review',
    executing: 'Executing',
    done: 'Done',
  };

  const lines = [
    `╭─── SDD: ${session.title} ────────────────────────────────╮`,
    '',
    `  ${phaseEmoji[session.phase]} Phase: ${phaseLabel[session.phase]}  ⏱ ${formatElapsed(phaseElapsed)}`,
    `  ⏱ Session: ${formatElapsed(sessionElapsed)}  |  ❝ Questions: ${session.questionCount}`,
  ];

  if (session.spec) {
    lines.push('');
    lines.push(`  📋 Spec: ${session.spec.title}`);
    lines.push(`     ${session.spec.requirements.length} requirements`);
    for (const r of session.spec.requirements.slice(0, 4)) {
      lines.push(
        `     • [${r.priority}] ${r.description.length > 42 ? r.description.slice(0, 41) + '…' : r.description}`,
      );
    }
    if (session.spec.requirements.length > 4) {
      lines.push(`     + ${session.spec.requirements.length - 4} more requirements`);
    }
  }

  if (progress && progress.total > 0) {
    lines.push('');
    lines.push(renderProgress(progress));
    lines.push(`  Task breakdown:`);
    if (progress.inProgress > 0) lines.push(`    🔄 ${progress.inProgress} in progress`);
    if (progress.pending > 0) lines.push(`    ⏳ ${progress.pending} pending`);
    if (progress.blocked > 0) lines.push(`    🚫 ${progress.blocked} blocked`);
    if (progress.failed > 0) lines.push(`    ❌ ${progress.failed} failed`);
    if (progress.review > 0) lines.push(`    👁 ${progress.review} in review`);

    if (taskTracker) {
      const nextTasks = taskTracker
        .getAllNodes({ status: ['pending', 'in_progress'] })
        .filter((n) => n.status === 'pending' && taskTracker.canStart(n.id))
        .slice(0, 3);
      if (nextTasks.length > 0) {
        lines.push('');
        lines.push(`  Up next:`);
        nextTasks.forEach((t, i) => {
          lines.push(`    ${i + 1}. ${t.title}`);
        });
      }
    }

    lines.push('');
    lines.push(`  Commands: /sdd tasks · /sdd next · /sdd approve · /sdd cancel`);
  } else {
    lines.push('');
    lines.push(`  Commands: /sdd plan · /sdd approve · /sdd cancel`);
  }

  lines.push(`╰${'─'.repeat(56)}╯`);
  lines.push('');
  const sessionLeaf = session.id.split('/').pop() ?? session.id;
  lines.push(`  Session ID: ${sessionLeaf.slice(0, 12)}…`);

  return lines.join('\n');
}

export function formatGraphListFallback(
  nodes: readonly TaskNode[],
  progress: TaskProgress,
  renderProgress: (progress: TaskProgress) => string,
): string {
  const lines = [renderProgress(progress), ''];
  for (let i = 0; i < nodes.length; i++) {
    const n = nodes[i];
    if (!n) continue;
    lines.push(`${i + 1}. ${taskStatusIcon(n.status)} [${n.priority}] ${n.title}`);
  }
  return lines.join('\n');
}

export function formatCriticalPathAnalysis(
  graph: TaskGraph,
  analysis: CriticalPathAnalysis,
): string {
  const lines = [
    `╭─── Critical Path Analysis ───────────────────────────────╮`,
    '',
    `  Critical path length: ${analysis.criticalPath.length} tasks`,
    `  Estimated total time: ${analysis.totalHours}h`,
    '',
  ];

  if (analysis.criticalPath.length > 0) {
    lines.push(`  🔴 Critical path:`);
    analysis.criticalPath.forEach((taskId, i) => {
      const node = graph.nodes.get(taskId);
      if (node) {
        lines.push(`    ${i + 1}. ${node.title} [${node.priority}] — ${node.estimateHours}h`);
      }
    });
  }

  if (analysis.bottlenecks.length > 0) {
    lines.push('');
    lines.push(`  🚫 Bottlenecks (blocking most downstream):`);
    for (const bt of analysis.bottlenecks) {
      const node = graph.nodes.get(bt.taskId);
      if (node) {
        lines.push(`    • ${node.title} (blocks ${bt.blockedCount} task(s))`);
      }
    }
  }

  if (analysis.parallelGroups.length > 0) {
    lines.push('');
    lines.push(`  ⚡ Parallel groups (can run concurrently):`);
    analysis.parallelGroups.forEach((group, i) => {
      const names = group.map((id) => graph.nodes.get(id)?.title ?? '?').join(' | ');
      lines.push(`    Group ${i + 1}: ${names}`);
    });
  }

  if (analysis.readyTasks.length > 0) {
    lines.push('');
    lines.push(`  ✅ Ready to start now:`);
    for (const taskId of analysis.readyTasks) {
      const node = graph.nodes.get(taskId);
      if (node) {
        lines.push(`    • ${node.title}`);
      }
    }
  }

  lines.push(`╰${'─'.repeat(55)}╯`);
  return lines.join('\n');
}
