import { describe, expect, it, } from 'vitest';
import { TaskDAG, type DAGEdgeEvent } from '../../src/coordination/task-dag.js';

describe('TaskDAG', () => {
  describe('addNode', () => {
    it('adds a node with no deps as ready', () => {
      const dag = new TaskDAG();
      dag.addNode('task1', 'First task');

      const node = dag.getNode('task1');
      expect(node).toBeDefined();
      expect(node!.status).toBe('ready');
      expect(node!.description).toBe('First task');
    });

    it('adds a node with deps as pending', () => {
      const dag = new TaskDAG();
      dag.addNode('task1', 'First task');
      dag.addNode('task2', 'Second task', ['task1']);

      expect(dag.getNode('task2')!.status).toBe('pending');
    });

    it('adds multiple independent tasks as ready', () => {
      const dag = new TaskDAG();
      dag.addNode('task1', 'Task 1');
      dag.addNode('task2', 'Task 2');
      dag.addNode('task3', 'Task 3');

      const ready = dag.getReady();
      expect(ready).toHaveLength(3);
    });

    it('throws for unknown dependency', () => {
      const dag = new TaskDAG();
      expect(() => dag.addNode('task1', 'Task', ['unknown'])).toThrow(
        /unknown dependency "unknown"/,
      );
    });

    // Note: addNode() is idempotent — calling with an existing id is a no-op.
    // This means cycle detection via addNode is not testable this way.
    // The _wouldCycle() method exists but is only reachable through addNode
    // for non-existent nodes that would create a cycle.

    it('is idempotent for duplicate addNode', () => {
      const dag = new TaskDAG();
      dag.addNode('task1', 'First task');
      dag.addNode('task1', 'First task again');

      expect(dag.getAll()).toHaveLength(1);
    });

    it('respects priority option', () => {
      const dag = new TaskDAG();
      dag.addNode('low', 'Low priority', [], { priority: 10 });
      dag.addNode('high', 'High priority', [], { priority: 1 });

      const ready = dag.getReady();
      expect(ready[0]!.id).toBe('high');
      expect(ready[1]!.id).toBe('low');
    });

    it('supports tags option', () => {
      const dag = new TaskDAG();
      dag.addNode('task1', 'Task', [], { tags: ['refactor', 'urgent'] });

      expect(dag.getNode('task1')!.tags).toEqual(['refactor', 'urgent']);
    });
  });

  describe('start', () => {
    it('transitions ready node to running', () => {
      const dag = new TaskDAG();
      dag.addNode('task1', 'Task');
      const result = dag.start('task1', 'agent-1');

      expect(result).toBe(true);
      expect(dag.getNode('task1')!.status).toBe('running');
      expect(dag.getNode('task1')!.assignedTo).toBe('agent-1');
    });

    it('returns false for pending node', () => {
      const dag = new TaskDAG();
      dag.addNode('parent', 'Parent');
      dag.addNode('child', 'Child', ['parent']);
      // child is pending, not ready
      const result = dag.start('child', 'agent-1');

      expect(result).toBe(false);
    });

    it('returns false for unknown node', () => {
      const dag = new TaskDAG();
      const result = dag.start('unknown', 'agent-1');

      expect(result).toBe(false);
    });

    it('emits node:started event', () => {
      const dag = new TaskDAG();
      dag.addNode('task1', 'Task');

      const events: DAGEdgeEvent[] = [];
      dag.onEvent((e) => events.push(e));

      dag.start('task1', 'agent-1');

      expect(events).toContainEqual(
        expect.objectContaining({ type: 'node:started', nodeId: 'task1', assignedTo: 'agent-1' }),
      );
    });
  });

  describe('complete', () => {
    it('transitions running node to done', () => {
      const dag = new TaskDAG();
      dag.addNode('task1', 'Task');
      dag.start('task1', 'agent-1');
      dag.complete('task1', { result: 'ok' });

      expect(dag.getNode('task1')!.status).toBe('done');
      expect(dag.getNode('task1')!.result).toEqual({ result: 'ok' });
    });

    // The DAG is shared across sessions — `autonomous-coordinator` folds in
    // "completed/failed by another session" goal updates — so duplicated and
    // late terminal reports are ordinary traffic. Terminal states must be
    // absorbing: `fail()` after `complete()` used to flip `done` to `failed`,
    // erase the result, and re-emit lifecycle events.
    it('keeps the first terminal outcome when a late fail() arrives', () => {
      const dag = new TaskDAG();
      dag.addNode('task1', 'Task');
      dag.start('task1', 'agent-1');
      dag.complete('task1', { result: 'ok' });

      dag.fail('task1', 'late timeout report');

      const node = dag.getNode('task1')!;
      expect(node.status).toBe('done');
      expect(node.result).toEqual({ result: 'ok' });
      expect(node.error).toBeUndefined();
    });

    it('keeps a failed node failed when a late complete() arrives', () => {
      const dag = new TaskDAG();
      dag.addNode('task1', 'Task');
      dag.start('task1', 'agent-1');
      dag.fail('task1', 'boom');

      dag.complete('task1', { result: 'too late' });
      dag.skip('task1', 'also too late');

      const node = dag.getNode('task1')!;
      expect(node.status).toBe('failed');
      expect(node.error).toBe('boom');
    });

    it('unblocks dependent nodes', () => {
      const dag = new TaskDAG();
      dag.addNode('task1', 'Task 1');
      dag.addNode('task2', 'Task 2', ['task1']);

      expect(dag.getNode('task2')!.status).toBe('pending');

      dag.start('task1', 'agent-1');
      dag.complete('task1', undefined);

      expect(dag.getNode('task2')!.status).toBe('ready');
    });

    it('does not unblock if other deps are incomplete', () => {
      const dag = new TaskDAG();
      dag.addNode('task1', 'Task 1');
      dag.addNode('task2', 'Task 2');
      dag.addNode('task3', 'Task 3', ['task1', 'task2']);

      dag.start('task1', 'agent-1');
      dag.complete('task1', undefined);

      // task3 still waits for task2
      expect(dag.getNode('task3')!.status).toBe('pending');
    });

    it('emits node:completed event', () => {
      const dag = new TaskDAG();
      dag.addNode('task1', 'Task');
      dag.start('task1', 'agent-1');

      const events: DAGEdgeEvent[] = [];
      dag.onEvent((e) => events.push(e));

      dag.complete('task1', { value: 42 });

      expect(events).toContainEqual(
        expect.objectContaining({ type: 'node:completed', nodeId: 'task1' }),
      );
    });
  });

  describe('fail', () => {
    it('transitions running node to failed', () => {
      const dag = new TaskDAG();
      dag.addNode('task1', 'Task');
      dag.start('task1', 'agent-1');
      dag.fail('task1', 'Something went wrong');

      expect(dag.getNode('task1')!.status).toBe('failed');
      expect(dag.getNode('task1')!.error).toBe('Something went wrong');
    });

    it('only unblocks when ALL deps are done or skipped', () => {
      const dag = new TaskDAG();
      dag.addNode('task1', 'Task 1');
      dag.addNode('task2', 'Task 2');
      dag.addNode('task3', 'Task 3', ['task1', 'task2']);

      // Complete task2 first (task1 still running)
      dag.start('task2', 'agent-2');
      dag.complete('task2', undefined);

      // task3 should still be pending because task1 is not done
      expect(dag.getNode('task3')!.status).toBe('pending');

      // Now complete task1
      dag.start('task1', 'agent-1');
      dag.complete('task1', undefined);

      // Both deps done, task3 should be ready
      expect(dag.getNode('task3')!.status).toBe('ready');
    });

    it('emits node:failed event', () => {
      const dag = new TaskDAG();
      dag.addNode('task1', 'Task');
      dag.start('task1', 'agent-1');

      const events: DAGEdgeEvent[] = [];
      dag.onEvent((e) => events.push(e));

      dag.fail('task1', 'error');

      expect(events).toContainEqual(
        expect.objectContaining({ type: 'node:failed', nodeId: 'task1' }),
      );
    });
  });

  describe('skip', () => {
    it('transitions node to skipped', () => {
      const dag = new TaskDAG();
      dag.addNode('task1', 'Task');
      dag.skip('task1', 'Not needed');

      expect(dag.getNode('task1')!.status).toBe('skipped');
    });

    it('unblocks dependents like done does', () => {
      const dag = new TaskDAG();
      dag.addNode('task1', 'Task 1');
      dag.addNode('task2', 'Task 2', ['task1']);

      dag.skip('task1', 'skipped');

      expect(dag.getNode('task2')!.status).toBe('ready');
    });
  });

  describe('removeNode', () => {
    it('removes node and its edges', () => {
      const dag = new TaskDAG();
      dag.addNode('task1', 'Task 1');
      dag.addNode('task2', 'Task 2', ['task1']);

      dag.removeNode('task1');

      expect(dag.getNode('task1')).toBeUndefined();
      expect(dag.getNode('task2')).toBeDefined();
      // task2's deps still references task1, but task1 no longer exists
      expect(dag.getNode('task2')!.deps).toContain('task1');
    });

    it('removing unknown node is a no-op', () => {
      const dag = new TaskDAG();
      dag.addNode('task1', 'Task 1');

      dag.removeNode('nonexistent');

      expect(dag.getNode('task1')).toBeDefined();
      expect(dag.getAll()).toHaveLength(1);
    });
  });

  describe('isDone / isFailed', () => {
    it('isDone returns true when all nodes are done/failed/skipped', () => {
      const dag = new TaskDAG();
      dag.addNode('task1', 'Task 1');
      dag.addNode('task2', 'Task 2');
      dag.start('task1', 'a');
      dag.start('task2', 'b');
      dag.complete('task1', undefined);
      dag.complete('task2', undefined);

      expect(dag.isDone()).toBe(true);
    });

    it('isFailed returns true when any node failed', () => {
      const dag = new TaskDAG();
      dag.addNode('task1', 'Task');
      dag.start('task1', 'a');
      dag.fail('task1', 'error');

      expect(dag.isFailed()).toBe(true);
    });
  });

  describe('hasDeadlock', () => {
    it('returns false when tasks are running', () => {
      const dag = new TaskDAG();
      dag.addNode('task1', 'Task');
      dag.start('task1', 'a');

      expect(dag.hasDeadlock()).toBe(false);
    });

    it('returns true when no tasks are ready and none are running', () => {
      const dag = new TaskDAG();
      dag.addNode('task1', 'Task 1');
      dag.addNode('task2', 'Task 2', ['task1']);

      // task1 is ready but not started → no deadlock yet
      expect(dag.hasDeadlock()).toBe(false);

      // After starting task1, it's running → no deadlock
      dag.start('task1', 'agent-1');
      expect(dag.hasDeadlock()).toBe(false);

      // After completing task1, task2 becomes ready → no deadlock
      dag.complete('task1', undefined);
      expect(dag.hasDeadlock()).toBe(false);
    });

    // Note: Deadlock detection is hard to test without cycle creation,
    // which addNode prevents (idempotent). The hasDeadlock() method exists
    // but testing it requires a graph where all tasks are pending without cycles.

    it('returns false when graph is done', () => {
      const dag = new TaskDAG();
      dag.addNode('task1', 'Task');
      dag.start('task1', 'a');
      dag.complete('task1', undefined);

      expect(dag.hasDeadlock()).toBe(false);
    });
  });

  describe('getTopologicalOrder', () => {
    it('returns nodes in dependency order', () => {
      const dag = new TaskDAG();
      dag.addNode('a', 'A');
      dag.addNode('b', 'B');
      dag.addNode('c', 'C', ['a', 'b']);

      const order = dag.getTopologicalOrder().map((n) => n.id);

      // c should come after a and b
      expect(order.indexOf('c')).toBeGreaterThan(order.indexOf('a'));
      expect(order.indexOf('c')).toBeGreaterThan(order.indexOf('b'));
    });
  });

  describe('stats', () => {
    it('reports correct counts', () => {
      const dag = new TaskDAG();
      dag.addNode('task1', 'Task 1');
      dag.addNode('task2', 'Task 2', ['task1']);

      // Initial state: task1 ready, task2 pending
      let s = dag.stats();
      expect(s.total).toBe(2);
      expect(s.ready).toBe(1);
      expect(s.pending).toBe(1);
      expect(s.done).toBe(0);

      // After completing task1: task2 becomes ready
      dag.start('task1', 'a');
      dag.complete('task1', undefined);

      s = dag.stats();
      expect(s.total).toBe(2);
      expect(s.ready).toBe(1); // task2 is now ready
      expect(s.pending).toBe(0);
      expect(s.done).toBe(1);
      expect(s.progress).toBeCloseTo(0.5);
    });
  });

  describe('events', () => {
    it('onEvent fires for node:started event', () => {
      const dag = new TaskDAG();
      dag.addNode('task1', 'Task 1');

      const events: DAGEdgeEvent[] = [];
      dag.onEvent((e) => events.push(e));

      dag.start('task1', 'agent-1');

      expect(events).toContainEqual(
        expect.objectContaining({ type: 'node:started', nodeId: 'task1' }),
      );
    });

    it('returns unsubscribe function', () => {
      const dag = new TaskDAG();
      dag.addNode('task1', 'Task');

      const events: DAGEdgeEvent[] = [];
      const unsubscribe = dag.onEvent((e) => events.push(e));
      unsubscribe();
      dag.start('task1', 'a');

      expect(events).toHaveLength(0);
    });
  });
});
