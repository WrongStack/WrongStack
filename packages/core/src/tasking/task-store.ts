import type { TaskGraph } from '@wrongstack/contracts/types/task-graph';
import type { TaskStore } from './task-tracker.js';

/**
 * In-memory task-graph store used by Goal and tests.
 *
 * The store clones the graph container on read/write so callers cannot replace
 * its Maps/arrays behind the store's back. Task nodes themselves intentionally
 * remain shared: TaskTracker owns node mutation and persists after each change.
 */
export class DefaultTaskStore implements TaskStore {
  private readonly graphs = new Map<string, TaskGraph>();

  async saveGraph(graph: TaskGraph): Promise<void> {
    this.graphs.set(graph.id, this.cloneGraph(graph));
  }

  async loadGraph(id: string): Promise<TaskGraph | null> {
    const graph = this.graphs.get(id);
    return graph ? this.cloneGraph(graph) : null;
  }

  async listGraphs(): Promise<Array<{ id: string; title: string; updatedAt: number }>> {
    return Array.from(this.graphs.values()).map((graph) => ({
      id: graph.id,
      title: graph.title,
      updatedAt: graph.updatedAt,
    }));
  }

  async deleteGraph(id: string): Promise<void> {
    this.graphs.delete(id);
  }

  private cloneGraph(graph: TaskGraph): TaskGraph {
    return {
      ...graph,
      nodes: new Map(graph.nodes),
      edges: [...graph.edges],
      rootNodes: [...graph.rootNodes],
    };
  }
}
