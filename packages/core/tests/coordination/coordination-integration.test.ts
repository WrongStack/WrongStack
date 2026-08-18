import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import { KnowledgeGraph } from '../../src/coordination/knowledge-graph.js';
import { ConsensusProtocol } from '../../src/coordination/consensus-protocol.js';
import { ChangeManager } from '../../src/coordination/change-manager.js';
import { TaskDAG } from '../../src/coordination/task-dag.js';
import type { FactNode, GoalNode, ChangeNode } from '../../src/coordination/knowledge-graph.js';

// ── Test setup ─────────────────────────────────────────────────────────────

let tempDir: string;

beforeEach(async () => {
  tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'coord-integration-'));
});

afterEach(async () => {
  // Retry rm on Windows where locked files can cause ENOTEMPTY during parallel runs.
  for (let attempt = 0; attempt < 10; attempt++) {
    try {
      await fs.rm(tempDir, { recursive: true, force: true });
      return;
    } catch (err: unknown) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOTEMPTY') throw err;
      await new Promise((resolve) => setTimeout(resolve, 50 * (attempt + 1)));
    }
  }
});

// ── Integration: KnowledgeGraph + ConsensusProtocol ─────────────────────────

describe('KnowledgeGraph + ConsensusProtocol Integration', () => {
  it('stores facts and votes for consensus decisions', async () => {
    const graph = new KnowledgeGraph(tempDir);

    // Add a critical fact
    const fact = await graph.add({
      type: 'fact',
      category: 'bug',
      subject: 'Critical memory leak',
      detail: 'Memory grows unbounded in session store',
      key: 'mem-leak-1',
      severity: 'critical',
      discoveredBy: 'agent-1',
      discoveredAt: new Date().toISOString(),
      tags: ['memory', 'critical'],
      related: [],
    } as Omit<FactNode, 'id'>);

    // Create consensus protocol with voters
    const protocol = new ConsensusProtocol({
      graph,
      voters: [
        { agentId: 'voter-1', agentName: 'Alice', weight: 1, role: 'reviewer' },
        { agentId: 'voter-2', agentName: 'Bob', weight: 1, role: 'architect' },
      ],
      rules: { quorumFraction: 0, vetoRoles: [], approvalFraction: 0.6 },
    });

    // Propose a change for the vote
    const changeId = await graph.add({
      type: 'change',
      title: 'Fix memory leak',
      description: 'Add proper cleanup in session store',
      files: [{ path: 'session.ts', action: 'modify' }],
      status: 'proposed',
      proposedBy: 'agent-1',
      proposedAt: new Date().toISOString(),
      approvedBy: [],
      rejectedBy: [],
      votes: [],
      qualityGate: { passed: true, checks: [] },
      satisfiesGoals: [],
    } as Omit<ChangeNode, 'id'>);

    // Initiate vote
    await protocol.initiateVote(changeId.id);

    // Cast votes (castVote returns ConsensusResult directly)
    const result1 = await protocol.castVote(changeId.id, 'voter-1', 'approve');
    const result2 = await protocol.castVote(changeId.id, 'voter-2', 'approve');

    // Check consensus reached
    expect(result1.quorumMet).toBe(true);
    expect(result1.outcome).toBe('approved');
    expect(result2.outcome).toBe('approved');

    // Retrieve fact from graph
    const retrieved = graph.get(fact.id);
    expect(retrieved).toBeDefined();
    expect((retrieved as FactNode).subject).toBe('Critical memory leak');
  });

  it('handles rejected proposals with consensus', async () => {
    const graph = new KnowledgeGraph(tempDir);

    const protocol = new ConsensusProtocol({
      graph,
      voters: [
        { agentId: 'voter-1', agentName: 'Alice', weight: 1, role: 'reviewer' },
        { agentId: 'voter-2', agentName: 'Bob', weight: 1, role: 'reviewer' },
      ],
      rules: { quorumFraction: 0, vetoRoles: [], approvalFraction: 0.6 },
    });

    // Propose a minor change
    const changeId = await graph.add({
      type: 'change',
      title: 'Minor formatting fix',
      description: 'Fix trailing whitespace',
      files: [{ path: 'file.ts', action: 'modify' }],
      status: 'proposed',
      proposedBy: 'agent-1',
      proposedAt: new Date().toISOString(),
      approvedBy: [],
      rejectedBy: [],
      votes: [],
      qualityGate: { passed: false, checks: [] },
      satisfiesGoals: [],
    } as Omit<ChangeNode, 'id'>);

    await protocol.initiateVote(changeId.id);

    const result1 = await protocol.castVote(changeId.id, 'voter-1', 'reject');
    const result2 = await protocol.castVote(changeId.id, 'voter-2', 'reject');

    expect(result1.quorumMet).toBe(true);
    expect(result1.outcome).toBe('rejected');
    expect(result2.outcome).toBe('rejected');
  });
});

// ── Integration: KnowledgeGraph + ChangeManager ──────────────────────────────

describe('KnowledgeGraph + ChangeManager Integration', () => {
  it('proposes changes with required fields', async () => {
    const graph = new KnowledgeGraph(tempDir);

    // ChangeManager requires a ConsensusProtocol
    const consensus = new ConsensusProtocol({
      graph,
      voters: [
        { agentId: 'voter-1', agentName: 'Alice', weight: 1, role: 'reviewer' },
      ],
      rules: { quorumFraction: 0, vetoRoles: [], approvalFraction: 0.6 },
    });

    const changeManager = new ChangeManager({ graph, consensus });

    // Propose a change with all required fields
    const change = await changeManager.propose({
      title: 'Add memory leak test',
      description: 'Add test for session store memory leak',
      files: [
        { path: 'packages/core/tests/session-store.test.ts', action: 'create' },
      ],
      proposedBy: 'test-agent',
      satisfiesGoals: [],
      tags: ['test', 'memory'],
    });

    expect(change.id).toBeDefined();
    expect(change.title).toBe('Add memory leak test');

    // Verify it exists in graph
    const changes = graph.getChanges({ status: 'proposed' });
    expect(changes.some(c => c.id === change.id)).toBe(true);
  });

  it('tracks change lifecycle in graph', async () => {
    const graph = new KnowledgeGraph(tempDir);

    const consensus = new ConsensusProtocol({
      graph,
      voters: [
        { agentId: 'voter-1', agentName: 'Alice', weight: 1, role: 'reviewer' },
      ],
      rules: { quorumFraction: 0, vetoRoles: [], approvalFraction: 0.6 },
    });

    const changeManager = new ChangeManager({ graph, consensus });

    // Create change
    const change = await changeManager.propose({
      title: 'Refactor auth module',
      description: 'Clean up authentication logic',
      files: [
        { path: 'packages/core/src/auth/session.ts', action: 'modify' },
      ],
      proposedBy: 'architect',
      satisfiesGoals: [],
      tags: ['refactor', 'auth'],
    });

    // Verify it starts as proposed
    let changes = graph.getChanges({ status: 'proposed' });
    expect(changes.some(c => c.id === change.id)).toBe(true);

    // Simulate approval by updating directly in graph
    await graph.update(change.id, {
      status: 'approved',
      approvedBy: ['architect'],
    });

    // Verify status changed
    changes = graph.getChanges({ status: 'approved' });
    expect(changes.some(c => c.id === change.id)).toBe(true);
  });
});

// ── Integration: TaskDAG + KnowledgeGraph ───────────────────────────────────

describe('TaskDAG + KnowledgeGraph Integration', () => {
  it('tracks task execution in DAG and updates goals in graph', async () => {
    const graph = new KnowledgeGraph(tempDir);
    const dag = new TaskDAG();

    // Create goals in graph
    const goal1 = await graph.add({
      type: 'goal',
      title: 'Implement feature X',
      description: 'Build feature X',
      status: 'pending',
      priority: 'high',
      createdBy: 'system',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      blockedBy: [],
      dependsOn: [],
      tags: ['feature'],
      children: [],
    } as Omit<GoalNode, 'id'>);

    // Track task execution in DAG
    dag.addNode('task-1', 'Implement feature X', [], { tags: ['feature'] });

    // Verify DAG state - should be ready since no deps
    const task = dag.getNode('task-1');
    expect(task).toBeDefined();
    expect(task!.status).toBe('ready');

    // Start the task
    dag.start('task-1', 'agent-1');

    // Verify running
    const running = dag.getNode('task-1');
    expect(running!.status).toBe('running');

    // Complete the task
    dag.complete('task-1', { success: true });

    // Verify completion
    const completed = dag.getNode('task-1');
    expect(completed!.status).toBe('done');

    // Update goal status in graph
    await graph.update(goal1.id, { status: 'in_progress' as const });
    await graph.update(goal1.id, { status: 'done' as const });

    // Verify goal updated
    const updatedGoal = graph.get(goal1.id) as GoalNode;
    expect(updatedGoal.status).toBe('done');
  });

  it('handles task dependency chains', () => {
    const dag = new TaskDAG();

    // Create a chain: A -> B -> C
    dag.addNode('task-a', 'Task A', []);
    dag.addNode('task-b', 'Task B', ['task-a']);
    dag.addNode('task-c', 'Task C', ['task-b']);

    // Verify initial states
    expect(dag.getNode('task-a')!.status).toBe('ready');
    expect(dag.getNode('task-b')!.status).toBe('pending');
    expect(dag.getNode('task-c')!.status).toBe('pending');

    // Complete A
    dag.start('task-a', 'agent-1');
    dag.complete('task-a', { success: true });

    // B should now be ready
    expect(dag.getNode('task-b')!.status).toBe('ready');
    expect(dag.getNode('task-c')!.status).toBe('pending');

    // Complete B
    dag.start('task-b', 'agent-2');
    dag.complete('task-b', { success: true });

    // C should now be ready
    expect(dag.getNode('task-c')!.status).toBe('ready');

    // Complete C
    dag.start('task-c', 'agent-3');
    dag.complete('task-c', { success: true });

    // All done
    expect(dag.isDone()).toBe(true);
  });

  it('handles parallel independent tasks', () => {
    const dag = new TaskDAG();

    // Create multiple independent tasks
    dag.addNode('task-1', 'Task 1', []);
    dag.addNode('task-2', 'Task 2', []);
    dag.addNode('task-3', 'Task 3', []);
    dag.addNode('task-4', 'Task 4', ['task-1', 'task-2', 'task-3']);

    // Check that 3 tasks are ready (task-4 is blocked)
    const readyTasks = dag.getReady();
    expect(readyTasks.length).toBe(3);
    expect(readyTasks.some(t => t.id === 'task-4')).toBe(false);

    // Complete two tasks
    dag.start('task-1', 'agent-1');
    dag.complete('task-1', { success: true });
    dag.start('task-2', 'agent-2');
    dag.complete('task-2', { success: true });

    // task-4 should still be blocked (waiting for task-3)
    const stillReady = dag.getReady();
    expect(stillReady.length).toBe(1);
    expect(stillReady[0]!.id).toBe('task-3');

    // Complete the last task
    dag.start('task-3', 'agent-3');
    dag.complete('task-3', { success: true });

    // Now task-4 should be ready
    const allReady = dag.getReady();
    expect(allReady.length).toBe(1);
    expect(allReady[0]!.id).toBe('task-4');
  });
});

// ── Integration: Error Recovery ──────────────────────────────────────────────

describe('Error Recovery Integration', () => {
  it('handles task failure', () => {
    const dag = new TaskDAG();

    // Create task
    dag.addNode('retry-task', 'Flaky task', []);

    // Start and fail
    dag.start('retry-task', 'flaky-agent');
    dag.fail('retry-task', 'Timeout: exceeded 30s limit');

    // Check failed status
    const failed = dag.getNode('retry-task');
    expect(failed!.status).toBe('failed');
    expect(failed!.error).toContain('Timeout');

    // Verify isFailed
    expect(dag.isFailed()).toBe(true);
  });

  it('handles skipped tasks correctly', () => {
    const dag = new TaskDAG();

    dag.addNode('task-a', 'Task A', []);
    dag.addNode('task-b', 'Task B', ['task-a']);

    // Start and skip task A
    dag.start('task-a', 'agent-1');
    dag.skip('task-a', 'Task no longer needed');

    // Task B should now be ready (skipped counts as done for deps)
    const ready = dag.getReady();
    expect(ready.some(t => t.id === 'task-b')).toBe(true);

    // Verify skipped task is in completed
    const completed = dag.getCompleted();
    expect(completed.some(t => t.id === 'task-a')).toBe(true);
  });

  it('handles failed dependency correctly', () => {
    const dag = new TaskDAG();

    dag.addNode('task-a', 'Task A', []);
    dag.addNode('task-b', 'Task B', ['task-a']);

    // Fail task A
    dag.start('task-a', 'agent-1');
    dag.fail('task-a', 'Critical error');

    // Task B should still be pending (dependency failed)
    const pending = dag.getPending();
    expect(pending.some(t => t.id === 'task-b')).toBe(true);

    // Get blocked tasks
    const blocked = dag.getBlocked();
    expect(blocked.some(t => t.id === 'task-b')).toBe(true);
  });
});

// ── Full Workflow Simulation ─────────────────────────────────────────────────

describe('Full Coordination Workflow', () => {
  it('simulates a complete bug fix workflow', async () => {
    const graph = new KnowledgeGraph(tempDir);
    const dag = new TaskDAG();

    const consensus = new ConsensusProtocol({
      graph,
      voters: [
        { agentId: 'voter-1', agentName: 'Alice', weight: 1, role: 'reviewer' },
        { agentId: 'voter-2', agentName: 'Bob', weight: 1, role: 'architect' },
      ],
      rules: { quorumFraction: 0, vetoRoles: [], approvalFraction: 0.6 },
    });

    const changeManager = new ChangeManager({ graph, consensus });

    // Step 1: Discovery - add bug fact
    const bugFact = await graph.add({
      type: 'fact',
      category: 'bug',
      subject: 'Null pointer in auth handler',
      detail: 'auth/session.ts line 42',
      key: 'npe-auth-42',
      severity: 'high',
      discoveredBy: 'test-agent',
      discoveredAt: new Date().toISOString(),
      tags: ['auth', 'null-pointer'],
      related: [],
    } as Omit<FactNode, 'id'>);

    expect(bugFact.id).toBeDefined();

    // Step 2: Create fix goal
    const fixGoal = await graph.add({
      type: 'goal',
      title: `Fix: ${(bugFact as FactNode).subject}`,
      description: 'Add null check before accessing user object',
      status: 'pending',
      priority: 'high',
      createdBy: 'system',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      blockedBy: [],
      dependsOn: [],
      tags: ['bug-fix', 'auth'],
      children: [],
    } as Omit<GoalNode, 'id'>);

    // Step 3: Track in DAG
    dag.addNode(fixGoal.id, fixGoal.title, [], { tags: ['bug-fix'] });

    // Step 4: Propose fix change
    const fixChange = await changeManager.propose({
      title: 'Add null check in auth handler',
      description: `Fix for: ${(bugFact as FactNode).subject}`,
      files: [
        { path: 'packages/core/src/auth/session.ts', action: 'modify' },
      ],
      proposedBy: 'fix-agent',
      satisfiesGoals: [fixGoal.id],
      tags: ['bug-fix'],
    });

    // Step 5: Start task work
    dag.start(fixGoal.id, 'fix-agent');

    // Step 6: Complete the task
    dag.complete(fixGoal.id, { success: true });
    await graph.update(fixGoal.id, { status: 'done' as const });

    // Verify final state
    const finalGoal = graph.get(fixGoal.id) as GoalNode;
    expect(finalGoal.status).toBe('done');

    const finalDagNode = dag.getNode(fixGoal.id);
    expect(finalDagNode!.status).toBe('done');

    const changes = graph.getChanges({ status: 'proposed' });
    expect(changes.some(c => c.id === fixChange.id)).toBe(true);

    // Verify DAG is done
    expect(dag.isDone()).toBe(true);
  });

  it('simulates consensus workflow for change approval', async () => {
    const graph = new KnowledgeGraph(tempDir);

    const consensus = new ConsensusProtocol({
      graph,
      voters: [
        { agentId: 'architect', agentName: 'Architect', weight: 2, role: 'architect' },
        { agentId: 'senior-dev', agentName: 'Senior Dev', weight: 1, role: 'senior-dev' },
        { agentId: 'junior-dev', agentName: 'Junior Dev', weight: 1, role: 'developer' },
      ],
      rules: {
        quorumFraction: 0.6,
        vetoRoles: ['architect'],
        approvalFraction: 0.6,
      },
    });

    // Propose change
    const changeId = await graph.add({
      type: 'change',
      title: 'Add new API endpoint',
      description: 'Add GET /api/health endpoint',
      files: [{ path: 'api/health.ts', action: 'create' }],
      status: 'proposed',
      proposedBy: 'developer',
      proposedAt: new Date().toISOString(),
      approvedBy: [],
      rejectedBy: [],
      votes: [],
      qualityGate: { passed: true, checks: [] },
      satisfiesGoals: [],
    } as Omit<ChangeNode, 'id'>);

    // Initiate vote
    consensus.initiateVote(changeId.id);

    // Cast votes - castVote returns ConsensusResult directly
    const _result1 = await consensus.castVote(changeId.id, 'senior-dev', 'approve');
    const _result2 = await consensus.castVote(changeId.id, 'architect', 'approve');
    const result3 = await consensus.castVote(changeId.id, 'junior-dev', 'approve');

    // Check consensus result
    expect(result3.quorumMet).toBe(true);
    expect(result3.outcome).toBe('approved');
  });
});
