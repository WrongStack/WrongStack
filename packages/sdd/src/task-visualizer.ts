import type { Specification, TaskGraph, TaskNode, TaskProgress } from '@wrongstack/contracts/types';
import { computeTaskProgress } from '@wrongstack/core/tasking';
import { expectDefined, truncate } from '@wrongstack/core/utils';

const STATUS_ICON: Record<TaskNode['status'], string> = {
  pending: '○',
  in_progress: '◐',
  blocked: '⊘',
  failed: '✗',
  review: '◑',
  completed: '●',
};

const PRIORITY_ICON: Record<TaskNode['priority'], string> = {
  critical: '🔴',
  high: '🟠',
  medium: '🟡',
  low: '🟢',
};

const TYPE_ICON: Record<TaskNode['type'], string> = {
  feature: '⚡',
  bugfix: '🐛',
  refactor: '♻️',
  docs: '📝',
  test: '🧪',
  chore: '🔧',
};

/**
 * Render a task graph as ASCII art for terminal display.
 */
export function renderTaskGraph(
  graph: TaskGraph,
  opts?: { compact?: boolean | undefined },
): string {
  const lines: string[] = [];
  const compact = opts?.compact ?? false;

  // Header
  lines.push(`╭─ Task Graph: ${graph.title} ─╮`);
  lines.push(
    `│ Spec: ${graph.specId.slice(0, 8)}... │ Nodes: ${graph.nodes.size} │ Edges: ${graph.edges.length} │`,
  );
  lines.push('╰' + '─'.repeat(Math.max(50, graph.title.length + 30)) + '╯');
  lines.push('');

  // Progress bar
  const progress = computeTaskProgress(graph);
  lines.push(renderProgress(progress));
  lines.push('');

  // Build adjacency for display. Canonical depends_on direction is
  // dependency (from) → dependent (to).
  const blockersMap = new Map<string, string[]>();
  const dependentsMap = new Map<string, string[]>();
  for (const edge of graph.edges) {
    if (edge.type === 'depends_on') {
      const blockers = blockersMap.get(edge.to) ?? [];
      blockers.push(edge.from);
      blockersMap.set(edge.to, blockers);
      if (graph.nodes.has(edge.to)) {
        const dependents = dependentsMap.get(edge.from) ?? [];
        dependents.push(edge.to);
        dependentsMap.set(edge.from, dependents);
      }
    }
  }

  // Render root nodes and their dependents
  const rendered = new Set<string>();
  const rootNodes = graph.rootNodes.filter((id) => graph.nodes.has(id));

  // If no root nodes, use all nodes
  const startNodes =
    rootNodes.length > 0
      ? rootNodes
      : Array.from(graph.nodes.keys()).filter((id) => {
          const blockers = blockersMap.get(id);
          return !blockers || blockers.length === 0;
        });

  for (const rootId of startNodes) {
    renderNode(graph, rootId, lines, rendered, blockersMap, dependentsMap, compact, '');
  }

  // Render any orphan nodes
  for (const [id] of graph.nodes) {
    if (!rendered.has(id)) {
      renderNode(graph, id, lines, rendered, blockersMap, dependentsMap, compact, '');
    }
  }

  // Legend
  lines.push('');
  lines.push('Legend: ● done ◐ in-progress ○ pending ⊗ blocked ✗ failed ◒ review');

  return lines.join('\n');
}

function renderNode(
  graph: TaskGraph,
  nodeId: string,
  lines: string[],
  rendered: Set<string>,
  blockersMap: Map<string, string[]>,
  dependentsMap: Map<string, string[]>,
  compact: boolean,
  prefix: string,
): void {
  if (rendered.has(nodeId)) return;
  rendered.add(nodeId);

  const node = expectDefined(graph.nodes.get(nodeId));

  const icon = STATUS_ICON[node.status];
  const prioIcon = PRIORITY_ICON[node.priority];
  const typeIcon = TYPE_ICON[node.type];
  const title = compact ? truncate(node.title, 40) : node.title;

  const blockedBy = blockersMap.get(nodeId) ?? [];
  const depsStr =
    blockedBy.length > 0
      ? ` ← [${blockedBy.map((d) => graph.nodes.get(d)?.title?.slice(0, 12) ?? '?').join(', ')}]`
      : '';

  lines.push(`${prefix}${icon} ${typeIcon} ${prioIcon} ${title}${depsStr}`);

  if (!compact && node.description) {
    const descLines = node.description.split('\n').slice(0, 3);
    for (const dl of descLines) {
      lines.push(`${prefix}  └ ${truncate(dl, 60)}`);
    }
  }

  // Render nodes that depend on this one
  const dependents = dependentsMap.get(nodeId) ?? [];

  for (const depId of dependents) {
    renderNode(graph, depId, lines, rendered, blockersMap, dependentsMap, compact, prefix + '  ');
  }
}

/**
 * Render a progress bar.
 */
export function renderProgress(progress: TaskProgress): string {
  const barWidth = 30;
  const filled = Math.round((progress.percentComplete / 100) * barWidth);
  const empty = barWidth - filled;
  const bar = '█'.repeat(filled) + '░'.repeat(empty);

  return [
    `Progress: [${bar}] ${progress.percentComplete}%`,
    `  ${progress.completed} done │ ${progress.inProgress} active │ ${progress.pending} pending │ ${progress.blocked} blocked │ ${progress.failed} failed`,
  ].join('\n');
}

/**
 * Render a compact task list (for quick status checks).
 */
export function renderTaskList(graph: TaskGraph): string {
  const lines: string[] = [];
  const nodes = Array.from(graph.nodes.values());

  // Group by status
  const groups: Record<TaskNode['status'], TaskNode[]> = {
    in_progress: [],
    pending: [],
    blocked: [],
    review: [],
    failed: [],
    completed: [],
  };

  for (const node of nodes) {
    groups[node.status].push(node);
  }

  for (const [status, group] of Object.entries(groups)) {
    if (group.length === 0) continue;
    const icon = STATUS_ICON[status as TaskNode['status']];
    lines.push(`${icon} ${status.toUpperCase()} (${group.length})`);
    for (const node of group) {
      const prio = PRIORITY_ICON[node.priority];
      const type = TYPE_ICON[node.type];
      lines.push(`  ${type} ${prio} ${node.title}`);
    }
    lines.push('');
  }

  return lines.join('\n');
}

/**
 * Render spec analysis summary.
 */
export function renderSpecAnalysis(
  spec: Specification,
  analysis: { completeness: number; gaps: string[]; risks: string[]; suggestions: string[] },
): string {
  const lines: string[] = [];

  lines.push(`╭─ Spec Analysis: ${spec.title} ─╮`);
  lines.push('');

  // Completeness
  const barWidth = 20;
  const filled = Math.round((analysis.completeness / 100) * barWidth);
  const bar = '█'.repeat(filled) + '░'.repeat(barWidth - filled);
  lines.push(`Completeness: [${bar}] ${analysis.completeness}%`);
  lines.push('');

  if (analysis.gaps.length > 0) {
    lines.push('⚠ Gaps:');
    for (const gap of analysis.gaps) {
      lines.push(`  • ${gap}`);
    }
    lines.push('');
  }

  if (analysis.risks.length > 0) {
    lines.push('🔴 Risks:');
    for (const risk of analysis.risks) {
      lines.push(`  • ${risk}`);
    }
    lines.push('');
  }

  if (analysis.suggestions.length > 0) {
    lines.push('💡 Suggestions:');
    for (const sug of analysis.suggestions) {
      lines.push(`  • ${sug}`);
    }
  }

  return lines.join('\n');
}
