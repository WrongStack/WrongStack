import type { EventBus } from '@wrongstack/contracts/kernel/events';
import { WorktreeManager } from '@wrongstack/core/worktree';
import type { PhaseGraph } from './types.js';

/** Each goal integrates its phases into its own branch, never another goal's tree. */
export async function prepareGoalWorkspace(
  projectRoot: string,
  graph: PhaseGraph,
  events?: EventBus,
): Promise<string> {
  const manager = new WorktreeManager({ projectRoot, events, sessionId: graph.sessionId });
  const handle = graph.workspace
    ? await manager.adopt(`goal:${graph.id}`, { ...graph.workspace, ownerLabel: graph.title })
    : await manager.allocate(`goal:${graph.id}`, {
        slugHint: `goal-${graph.id}`,
        ownerLabel: graph.title,
      });
  if (handle.status !== 'active')
    throw new Error(handle.lastError ?? 'Cannot allocate an isolated Goal checkout.');
  graph.workspace = { dir: handle.dir, branch: handle.branch, baseBranch: handle.baseBranch };
  return handle.dir;
}
