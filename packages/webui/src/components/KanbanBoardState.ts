import type { KanbanBoard } from '@wrongstack/kanban';
import type { RunLink } from './KanbanRunControls.js';

interface FleetAgentLike {
  id: string;
  name: string;
  status: string;
  sessionId?: string | undefined;
}

export function collectActiveSessionIds(input: {
  sessionId: string | null;
  registrySessionIds: readonly string[];
  agents: Iterable<FleetAgentLike>;
}): string[] {
  const ids = new Set<string>();
  if (input.sessionId) ids.add(input.sessionId);
  for (const id of input.registrySessionIds) ids.add(id);
  for (const agent of input.agents) {
    if (agent.status === 'running' && agent.sessionId) ids.add(agent.sessionId);
  }
  return [...ids];
}

// The board-active predicate is shared with the kanban store (fallback
// totals) and lives in lib/ — re-exported here so existing component
// imports keep working.
export { isKanbanBoardActive } from '../lib/kanban-board-active.js';

export function runningBoardCostTotal(board: KanbanBoard | null): number {
  if (!board) return 0;
  return board.tasks
    .filter(
      (task) =>
        task.status === 'in_progress' ||
        task.assignment?.status === 'running' ||
        task.assignment?.status === 'queued',
    )
    .reduce((sum, task) => sum + (task.costCeilingUsd ?? 0), 0);
}

/** A kanban board that mirrors a live Goal/SDD run, detected from its tags. */
export function parseRunLink(
  board: { tags?: string[] | undefined } | null | undefined,
): RunLink | null {
  const tags = board?.tags ?? [];
  const engine = tags.includes('sdd') ? 'sdd' : tags.includes('goal') ? 'goal' : null;
  if (!engine) return null;
  const runId = tags.find((tag) => tag.startsWith('run:'))?.slice(4);
  return { engine, ...(runId ? { runId } : {}) };
}
