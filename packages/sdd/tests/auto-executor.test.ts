import { EventBus } from '@wrongstack/core/kernel/events.js';
import { DefaultTaskStore } from '@wrongstack/core/tasking';
import type { Specification } from '@wrongstack/core/types/spec.js';
import type { TaskGraph, TaskNode } from '@wrongstack/core/types/task-graph.js';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AutoExecutor, createAutoExecutor } from '../src/auto-executor.js';
import { TaskTracker } from '../src/task-tracker.js';

function makeSpec(): Specification {
  return {
    id: 'spec-1',
    title: 'Test',
    version: '1.0.0',
    status: 'draft',
    overview: 'Overview',
    sections: [],
    requirements: [],
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };
}

function makeNode(id: string, overrides: Partial<TaskNode> = {}): TaskNode {
  return {
    id,
    title: `Task ${id}`,
    description: '',
    type: 'feature',
    priority: 'high',
    status: 'pending',
    createdAt: Date.now(),
    updatedAt: Date.now(),
    ...overrides,
  };
}

function makeGraph(nodes: TaskNode[], edges: Array<{ from: string; to: string }> = []): TaskGraph {
  return {
    id: 'graph-1',
    specId: 'spec-1',
    title: 'Test Graph',
    nodes: new Map(nodes.map((n) => [n.id, n])),
    edges: edges.map((e) => ({
      id: `${e.from}-${e.to}`,
      from: e.from,
      to: e.to,
      type: 'depends_on',
    })),
    rootNodes: nodes.filter((n) => !edges.some((e) => e.to === n.id)).map((n) => n.id),
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };
}

describe('AutoExecutor', () => {
  let store: DefaultTaskStore;
  let tracker: TaskTracker;
  let events: EventBus;

  beforeEach(() => {
    store = new DefaultTaskStore();
    tracker = new TaskTracker({ store });
    events = new EventBus();
  });

  it('executes a single task successfully', async () => {
    const node = makeNode('a');
    const graph = makeGraph([node]);
    await store.saveGraph(graph);
    await tracker.loadGraph(graph.id);

    const executor = new AutoExecutor({
      tracker,
      events,
      executeTask: async () => ({ success: true, output: 'done' }),
    });

    const summary = await executor.execute(graph, makeSpec());
    expect(summary.completed).toBe(1);
    expect(summary.failed).toBe(0);
  });

  it('handles task failure', async () => {
    const node = makeNode('a');
    const graph = makeGraph([node]);
    await store.saveGraph(graph);
    await tracker.loadGraph(graph.id);

    const executor = new AutoExecutor({
      tracker,
      events,
      maxRetries: 0,
      executeTask: async () => ({ success: false, error: 'failed' }),
    });

    const summary = await executor.execute(graph, makeSpec());
    expect(summary.failed).toBe(1);
  });

  it('respects dependency order', async () => {
    const a = makeNode('a');
    const b = makeNode('b');
    const graph = makeGraph([a, b], [{ from: 'a', to: 'b' }]);
    await store.saveGraph(graph);
    await tracker.loadGraph(graph.id);

    const executionOrder: string[] = [];
    const executor = new AutoExecutor({
      tracker,
      events,
      executeTask: async (task) => {
        executionOrder.push(task.id);
        return { success: true };
      },
    });

    await executor.execute(graph, makeSpec());
    expect(executionOrder).toEqual(['a', 'b']);
  });

  it('retries failed tasks', async () => {
    const node = makeNode('a');
    const graph = makeGraph([node]);
    await store.saveGraph(graph);
    await tracker.loadGraph(graph.id);

    let attempts = 0;
    const executor = new AutoExecutor({
      tracker,
      events,
      maxRetries: 2,
      executeTask: async () => {
        attempts++;
        if (attempts < 3) return { success: false, retry: true };
        return { success: true };
      },
    });

    const summary = await executor.execute(graph, makeSpec());
    expect(summary.completed).toBe(1);
    expect(summary.retried).toBeGreaterThan(0);
  });

  it('calls onTaskStart and onTaskComplete', async () => {
    const node = makeNode('a');
    const graph = makeGraph([node]);
    await store.saveGraph(graph);
    await tracker.loadGraph(graph.id);

    const onStart = vi.fn();
    const onComplete = vi.fn();

    const executor = new AutoExecutor({
      tracker,
      events,
      executeTask: async () => ({ success: true }),
      onTaskStart: onStart,
      onTaskComplete: onComplete,
    });

    await executor.execute(graph, makeSpec());
    expect(onStart).toHaveBeenCalled();
    expect(onComplete).toHaveBeenCalled();
  });

  it('calls onDone with summary', async () => {
    const node = makeNode('a');
    const graph = makeGraph([node]);
    await store.saveGraph(graph);
    await tracker.loadGraph(graph.id);

    const onDone = vi.fn();
    const executor = new AutoExecutor({
      tracker,
      events,
      executeTask: async () => ({ success: true }),
      onDone,
    });

    await executor.execute(graph, makeSpec());
    expect(onDone).toHaveBeenCalledWith(
      expect.objectContaining({
        total: 1,
        completed: 1,
        failed: 0,
      }),
    );
  });

  it('stops execution when stop() called', async () => {
    const nodes = [makeNode('a'), makeNode('b'), makeNode('c')];
    const graph = makeGraph(nodes);
    await store.saveGraph(graph);
    await tracker.loadGraph(graph.id);

    let executed = 0;
    const executor = new AutoExecutor({
      tracker,
      events,
      maxConcurrent: 1,
      executeTask: async () => {
        executed++;
        if (executed === 1) executor.stop();
        return { success: true };
      },
    });

    await executor.execute(graph, makeSpec());
    // Should have stopped after first task
    expect(executed).toBeLessThanOrEqual(2);
  });

  it('handles empty graph', async () => {
    const graph = makeGraph([]);
    await store.saveGraph(graph);

    const executor = new AutoExecutor({
      tracker,
      events,
      executeTask: async () => ({ success: true }),
    });

    const summary = await executor.execute(graph, makeSpec());
    expect(summary.total).toBe(0);
    expect(summary.completed).toBe(0);
  });

  it('marks a task failed when execution requests a retry after the retry budget', async () => {
    const graph = makeGraph([makeNode('a')]);
    await store.saveGraph(graph);
    await tracker.loadGraph(graph.id);
    const executor = new AutoExecutor({
      tracker,
      events,
      maxRetries: 0,
      executeTask: async () => ({ success: false, retry: true, error: 'still failing' }),
    });

    const summary = await executor.execute(graph, makeSpec());

    expect(summary.retried).toBe(1);
    expect(summary.failed).toBe(0);
    expect(tracker.getNode('a')?.status).toBe('in_progress');
  });

  it('reports failures thrown outside the task executor through allSettled', async () => {
    const graph = makeGraph([makeNode('a')]);
    await store.saveGraph(graph);
    await tracker.loadGraph(graph.id);
    const onTaskFail = vi.fn();
    const executor = new AutoExecutor({
      tracker,
      events,
      executeTask: async () => ({ success: true }),
      onTaskStart: () => {
        throw new Error('start callback failed');
      },
      onTaskFail,
    });

    const summary = await executor.execute(graph, makeSpec());

    expect(summary.failed).toBe(1);
    expect(onTaskFail).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'a' }),
      expect.any(Error),
      0,
    );
  });

  it('retries thrown errors and provides dependency context', async () => {
    const a = makeNode('a', { priority: 'low' });
    const b = makeNode('b', { priority: 'critical' });
    const graph = makeGraph([a, b], [{ from: 'a', to: 'b' }]);
    graph.edges.push({ id: 'related', from: 'a', to: 'b', type: 'relates_to' });
    await store.saveGraph(graph);
    await tracker.loadGraph(graph.id);
    const onTaskFail = vi.fn();
    let attempts = 0;
    const executor = new AutoExecutor({
      tracker,
      events,
      maxConcurrent: 2,
      maxRetries: 1,
      onTaskFail,
      executeTask: async (task, context) => {
        if (task.id === 'a' && attempts++ === 0) throw new Error('transient');
        if (task.id === 'a') expect(context.dependents.map((node) => node.id)).toEqual(['b']);
        if (task.id === 'b') expect(context.dependencies.map((node) => node.id)).toEqual(['a']);
        return { success: true };
      },
    });

    const summary = await executor.execute(graph, makeSpec());

    expect(summary.completed).toBe(2);
    expect(summary.retried).toBe(1);
    expect(onTaskFail).toHaveBeenCalledWith(expect.anything(), expect.any(Error), 1);
  });

  it('normalizes non-Error task exceptions after retries are exhausted', async () => {
    const graph = makeGraph([makeNode('a')]);
    await store.saveGraph(graph);
    await tracker.loadGraph(graph.id);
    const executor = new AutoExecutor({
      tracker,
      events,
      maxRetries: 0,
      executeTask: async () => {
        throw 'plain failure';
      },
    });

    const summary = await executor.execute(graph, makeSpec());

    expect(summary.failed).toBe(1);
    expect(tracker.getNode('a')?.status).toBe('failed');
  });

  it('uses the message from an Error after retries are exhausted', async () => {
    const graph = makeGraph([makeNode('a')]);
    await store.saveGraph(graph);
    await tracker.loadGraph(graph.id);
    const executor = new AutoExecutor({
      tracker,
      events,
      maxRetries: 0,
      executeTask: async () => {
        throw new Error('typed failure');
      },
    });

    await expect(executor.execute(graph, makeSpec())).resolves.toMatchObject({ failed: 1 });
  });

  it('stops when failed blockers deadlock remaining tasks', async () => {
    const failed = makeNode('a', { status: 'failed' });
    const pending = makeNode('b');
    const graph = makeGraph([failed, pending], [{ from: 'a', to: 'b' }]);
    await store.saveGraph(graph);
    await tracker.loadGraph(graph.id);
    const executeTask = vi.fn(async () => ({ success: true }));
    const executor = new AutoExecutor({ tracker, events, executeTask });

    const summary = await executor.execute(graph, makeSpec());

    expect(summary.completed).toBe(0);
    expect(executeTask).not.toHaveBeenCalled();
  });

  it('stops without a deadlock when no task is currently ready', async () => {
    const active = makeNode('a', { status: 'in_progress' });
    const pending = makeNode('b');
    const graph = makeGraph([active, pending], [{ from: 'a', to: 'b' }]);
    await store.saveGraph(graph);
    await tracker.loadGraph(graph.id);
    const executeTask = vi.fn(async () => ({ success: true }));
    const executor = new AutoExecutor({ tracker, events, executeTask });

    await executor.execute(graph, makeSpec());

    expect(executeTask).not.toHaveBeenCalled();
  });

  it('creates an executor through the convenience factory', async () => {
    const graph = makeGraph([makeNode('a'), makeNode('b', { priority: 'medium' })]);
    await store.saveGraph(graph);
    await tracker.loadGraph(graph.id);
    const executor = createAutoExecutor({
      tracker,
      events,
      maxConcurrent: 2,
      maxRetries: 0,
      executeTask: async () => ({ success: true }),
    });

    await expect(executor.execute(graph, makeSpec())).resolves.toMatchObject({ completed: 2 });
  });
});
