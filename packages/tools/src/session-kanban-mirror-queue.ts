import type { SerializedTaskGraph } from '@wrongstack/contracts/types';
import { deserializeTaskGraph } from '@wrongstack/core/tasking';
import { rawErrorMessage } from '@wrongstack/core/utils';
import {
  compactSessionMirrorBoard,
  getBoard,
  type KanbanBoard,
  syncBoardFromTaskGraph,
} from '@wrongstack/kanban';
import {
  boardKey,
  enqueueBoardWork,
  ensureSessionKanbanBoard,
  MIRROR_DISABLED_ENV,
  sessionBoardTags,
} from './session-kanban-boards.js';

type PendingMirror = {
  projectRoot: string;
  sessionId: string;
  graph: SerializedTaskGraph;
  reconciliationGraph?: SerializedTaskGraph | undefined;
  sourceSystem: 'session-todo' | 'session-task' | 'session-plan';
};

export const pendingMirrors = new Map<string, PendingMirror>();

export const activeMirrors = new Set<string>();

/**
 * The final graph each mirror key last projected successfully. Completed
 * nodes from it are carried into the next turn's graphs: `projectGraph`
 * archives every card missing from the graph, so without this a Todo list
 * that prunes finished rows on a later turn archived the completed cards.
 * Kept separate from the in-burst `reconciliationGraph`, whose completed
 * nodes are projected once and then dropped so a card completed and removed
 * within one coalesced burst still archives.
 */
export const lastMirroredGraphs = new Map<string, SerializedTaskGraph>();

export const mirrorFailures = new Map<
  string,
  { message: string; sourceSystem: PendingMirror['sourceSystem'] }
>();

export function mirrorKey(
  projectRoot: string,
  sessionId: string,
  sourceSystem: PendingMirror['sourceSystem'],
): string {
  return `${boardKey(projectRoot, sessionId)}\0${sourceSystem}`;
}

function completedReconciliationGraph(
  latest: SerializedTaskGraph,
  candidates: readonly SerializedTaskGraph[],
): SerializedTaskGraph | undefined {
  const latestNodeIds = new Set(latest.nodes.map((node) => node.id));
  const carriedNodeIds = new Set<string>();
  const completedNodes = candidates.flatMap((candidate) =>
    candidate.nodes.filter((node) => {
      if (
        node.status !== 'completed' ||
        latestNodeIds.has(node.id) ||
        carriedNodeIds.has(node.id)
      ) {
        return false;
      }
      carriedNodeIds.add(node.id);
      return true;
    }),
  );
  if (completedNodes.length === 0) return undefined;

  const carriedRequirements = completedNodes.flatMap((node) =>
    node.specRequirementId ? [node.specRequirementId] : [],
  );
  return {
    ...latest,
    nodes: [...latest.nodes, ...completedNodes],
    rootNodes: [...new Set([...latest.rootNodes, ...completedNodes.map((node) => node.id)])],
    ...(latest.requiredRequirementIds
      ? {
          requiredRequirementIds: [
            ...new Set([...latest.requiredRequirementIds, ...carriedRequirements]),
          ],
        }
      : {}),
  };
}

export async function projectGraph(
  projectRoot: string | undefined,
  sessionId: string,
  graph: SerializedTaskGraph,
  sourceSystem: 'session-todo' | 'session-task' | 'session-plan',
): Promise<KanbanBoard | null> {
  if (!projectRoot || !sessionId || process.env[MIRROR_DISABLED_ENV] === '0') return null;
  return enqueueBoardWork(projectRoot, sessionId, async () => {
    const board = await ensureSessionKanbanBoard(projectRoot, sessionId);
    if (!board) return null;
    const result = await syncBoardFromTaskGraph(
      projectRoot,
      board.id,
      deserializeTaskGraph(graph),
      {
        sourceSystem,
        tags: [...new Set([...(board.tags ?? []), ...sessionBoardTags(sessionId)])],
        archiveMissingTasks: true,
        includeCompletedTasks: true,
        allowRequirementScopeShrink: true,
      },
    );
    if (!result) return null;
    const compacted = await compactSessionMirrorBoard(projectRoot, board.id);
    if (compacted?.removedTaskIds.length) {
      return (await getBoard(projectRoot, board.id)) ?? result.board;
    }
    return result.board;
  });
}

export function queueLatestMirror(
  projectRoot: string | undefined,
  sessionId: string,
  graph: SerializedTaskGraph,
  sourceSystem: PendingMirror['sourceSystem'],
): void {
  if (!projectRoot || !sessionId || process.env[MIRROR_DISABLED_ENV] === '0') return;
  const key = mirrorKey(projectRoot, sessionId, sourceSystem);
  const previous = pendingMirrors.get(key);
  const reconciliationGraph = previous
    ? completedReconciliationGraph(
        graph,
        [previous.reconciliationGraph, previous.graph].filter(
          (candidate): candidate is SerializedTaskGraph => candidate !== undefined,
        ),
      )
    : undefined;
  pendingMirrors.set(key, {
    projectRoot,
    sessionId,
    graph,
    ...(reconciliationGraph ? { reconciliationGraph } : {}),
    sourceSystem,
  });
  if (activeMirrors.has(key)) return;
  activeMirrors.add(key);
  const pump = (async () => {
    try {
      for (;;) {
        const pending = pendingMirrors.get(key);
        if (!pending) break;
        pendingMirrors.delete(key);
        try {
          const previous = lastMirroredGraphs.get(key);
          const withHistory = (graph: SerializedTaskGraph): SerializedTaskGraph =>
            (previous ? completedReconciliationGraph(graph, [previous]) : undefined) ?? graph;
          if (pending.reconciliationGraph) {
            await projectGraph(
              pending.projectRoot,
              pending.sessionId,
              withHistory(pending.reconciliationGraph),
              pending.sourceSystem,
            );
          }
          const finalGraph = withHistory(pending.graph);
          await projectGraph(
            pending.projectRoot,
            pending.sessionId,
            finalGraph,
            pending.sourceSystem,
          );
          lastMirroredGraphs.set(key, finalGraph);
          mirrorFailures.delete(boardKey(pending.projectRoot, pending.sessionId));
        } catch (error) {
          const message = rawErrorMessage(error);
          mirrorFailures.set(boardKey(pending.projectRoot, pending.sessionId), {
            message,
            sourceSystem: pending.sourceSystem,
          });
          console.warn(
            JSON.stringify({
              level: 'warn',
              event: 'session-kanban.mirror-failed',
              sessionId: pending.sessionId,
              sourceSystem: pending.sourceSystem,
              message,
              timestamp: new Date().toISOString(),
            }),
          );
        }
      }
    } finally {
      activeMirrors.delete(key);
      const pending = pendingMirrors.get(key);
      if (pending) {
        pendingMirrors.delete(key);
        // Re-queue through the same coalescing path, but do NOT lose the
        // carried completed nodes. `projectGraph` runs with
        // `archiveMissingTasks: true`, so a graph that has shed the completed
        // work archives those cards — which is exactly the "finished task
        // disappeared, then came back as a new card" report. `queueLatestMirror`
        // rebuilds the reconciliation set from the pending entry it finds, so
        // the carried nodes have to be folded back into the graph here rather
        // than dropped on the floor.
        const carried = pending.reconciliationGraph
          ? completedReconciliationGraph(pending.graph, [pending.reconciliationGraph])
          : undefined;
        queueLatestMirror(
          pending.projectRoot,
          pending.sessionId,
          carried ?? pending.graph,
          pending.sourceSystem,
        );
      }
    }
  })();
  trackBackgroundWork(pump);
}

/**
 * Every background pass this module starts — presence touches, board
 * refreshes, the mirror pump — outlives the call that started it. Nothing
 * held a handle on that work, so a caller that had finished with a session
 * (a test tearing down its temp dir, a surface closing a session) could not
 * wait for it: the writes landed on a directory that was already gone and
 * reported the ENOENT as a warning long after anyone was listening.
 *
 * The set is the handle. It holds settled-or-not promises that never reject,
 * so tracking can never itself become an unhandled rejection.
 */
export const backgroundWork = new Set<Promise<void>>();

export function trackBackgroundWork(work: Promise<unknown>): void {
  const tracked = work.then(
    () => undefined,
    () => undefined,
  );
  backgroundWork.add(tracked);
  void tracked.then(() => {
    backgroundWork.delete(tracked);
  });
}
