import { describe, expect, it } from 'vitest';
import {
  assignmentInput,
  mergedDependsOn,
  taskInput,
  taskPatch,
} from '../src/kanban-task-inputs.js';

describe('taskInput', () => {
  it('returns default for empty input', () => {
    const result = taskInput({ action: 'add_task' });
    expect(result.title).toBe('');
    expect(result.columnId).toBeUndefined();
  });

  it('sets title and basic fields', () => {
    const result = taskInput({
      action: 'add_task',
      title: 'My Task',
      columnId: 'col-1',
      description: 'Do the thing',
      status: 'pending',
      priority: 'high',
    });
    expect(result.title).toBe('My Task');
    expect(result.columnId).toBe('col-1');
    expect(result.description).toBe('Do the thing');
    expect(result.status).toBe('pending');
    expect(result.priority).toBe('high');
  });

  it('includes assignment when agentId provided', () => {
    const result = taskInput({
      action: 'add_task',
      agentId: 'agent-1',
      title: 'Assigned task',
    });
    expect(result.assignedAgent).toBe('agent-1');
    expect(result.assignment).toBeDefined();
    expect(result.assignment?.status).toBe('assigned');
  });

  it('includes assignment when name provided', () => {
    const result = taskInput({
      action: 'add_task',
      name: 'worker-1',
      title: 'Named task',
    });
    expect(result.assignedAgent).toBe('worker-1');
  });

  it('includes assignment when role provided', () => {
    const result = taskInput({
      action: 'add_task',
      role: 'developer',
      title: 'Role task',
    });
    expect(result.assignedAgent).toBe('developer');
  });

  it('handles dependsOn and dependencyTaskId', () => {
    const result = taskInput({
      action: 'add_task',
      title: 'Dependent task',
      dependsOn: ['task-1'],
      dependencyTaskId: 'task-2',
    });
    expect(result.dependsOn).toContain('task-1');
    expect(result.dependsOn).toContain('task-2');
  });

  it('handles taskType', () => {
    const result = taskInput({
      action: 'add_task',
      taskType: 'bugfix',
      title: 'Bug fix',
    });
    expect(result.type).toBe('bugfix');
  });

  it('handles estimatedHours and actualHours', () => {
    const result = taskInput({
      action: 'add_task',
      title: 'Timed',
      estimatedHours: 5,
      actualHours: 3,
    });
    expect(result.estimatedHours).toBe(5);
    expect(result.actualHours).toBe(3);
  });

  it('handles labels', () => {
    const result = taskInput({
      action: 'add_task',
      title: 'Labeled',
      labels: ['frontend', 'urgent'],
    });
    expect(result.labels).toEqual(['frontend', 'urgent']);
  });

  it('handles order and retryPolicy and costCeilingUsd', () => {
    const result = taskInput({
      action: 'add_task',
      title: 'With extras',
      order: 2,
      retryPolicy: 'exponential',
      costCeilingUsd: 10.5,
    });
    expect(result.order).toBe(2);
    expect(result.retryPolicy).toBe('exponential');
    expect(result.costCeilingUsd).toBe(10.5);
  });

  it('handles childTitles mapping', () => {
    const result = taskInput({
      action: 'split_task',
      title: 'Parent',
      childTitles: ['Child 1', 'Child 2'],
    });
    expect(result.childTaskIds).toEqual(['Child 1', 'Child 2']);
  });

  it('handles checkDescription creating successCriteria', () => {
    const result = taskInput({
      action: 'add_task',
      title: 'Checked',
      checkDescription: 'Must verify',
      checkStatus: 'passed',
    });
    expect(result.successCriteria).toHaveLength(1);
    expect(result.successCriteria![0]!.description).toBe('Must verify');
    expect(result.successCriteria![0]!.status).toBe('passed');
  });

  it('handles metricName creating goalMetrics', () => {
    const result = taskInput({
      action: 'add_task',
      title: 'Metric',
      metricName: 'Coverage',
      metricStatus: 'pending',
      metricTarget: '90%',
      metricCurrent: '75%',
      metricUnit: '%',
      metricNotes: 'Improving',
    });
    expect(result.goalMetrics).toHaveLength(1);
    expect(result.goalMetrics![0]!.name).toBe('Coverage');
    expect(result.goalMetrics![0]!.target).toBe('90%');
  });

  it('handles url creating links', () => {
    const result = taskInput({
      action: 'add_task',
      title: 'Linked',
      url: 'https://example.com',
      linkTitle: 'Example',
      linkType: 'doc',
    });
    expect(result.links).toHaveLength(1);
    expect(result.links![0]!.url).toBe('https://example.com');
    expect(result.links![0]!.title).toBe('Example');
  });

  it('handles note creating notes', () => {
    const result = taskInput({
      action: 'add_task',
      title: 'With note',
      note: 'Important note',
      author: 'tester',
    });
    expect(result.notes).toHaveLength(1);
    expect(result.notes![0]!.content).toBe('Important note');
    expect(result.notes![0]!.author).toBe('tester');
  });

  it('handles graphId and sourceSystem', () => {
    const result = taskInput({
      action: 'add_task',
      title: 'Graph task',
      graphId: 'graph-1',
      specId: 'spec-1',
      specRequirementId: 'REQ-1',
      phaseId: 'phase-1',
      sourceSystem: 'import',
    });
    expect(result.origin?.graphId).toBe('graph-1');
    expect(result.origin?.specId).toBe('spec-1');
    expect(result.origin?.specRequirementId).toBe('REQ-1');
    expect(result.origin?.system).toBe('import');
  });

  it('keeps requirement traceability even when no graph id is supplied', () => {
    const result = taskInput({
      action: 'add_task',
      title: 'Requirement task',
      specId: 'spec-1',
      specRequirementId: 'REQ-1',
    });
    expect(result.origin).toMatchObject({
      system: 'kanban-tool',
      specId: 'spec-1',
      specRequirementId: 'REQ-1',
    });
  });

  it('handles assignee override', () => {
    const result = taskInput({
      action: 'add_task',
      title: 'Assigned',
      assignee: 'user-1',
      agentId: 'agent-1',
    });
    expect(result.assignee).toBe('user-1');
    expect(result.assignedAgent).toBe('agent-1');
  });
});

describe('mergedDependsOn', () => {
  it('returns undefined for no deps', () => {
    expect(mergedDependsOn({ action: 'add_task' })).toBeUndefined();
  });

  it('merges dependsOn and dependencyTaskId', () => {
    const result = mergedDependsOn({
      action: 'add_task',
      dependsOn: ['a', 'b'],
      dependencyTaskId: 'c',
    });
    expect(result).toEqual(['a', 'b', 'c']);
  });

  it('deduplicates overlapping ids', () => {
    const result = mergedDependsOn({
      action: 'add_task',
      dependsOn: ['a', 'b'],
      dependencyTaskId: 'a',
    });
    expect(result).toEqual(['a', 'b']);
  });
});

describe('taskPatch', () => {
  it('returns partial fields for update', () => {
    const result = taskPatch({
      action: 'update_task',
      title: 'Updated',
      description: 'New desc',
      priority: 'low',
      status: 'in_progress',
      order: 1,
    });
    expect(result.title).toBe('Updated');
    expect(result.description).toBe('New desc');
    expect(result.priority).toBe('low');
    expect(result.status).toBe('in_progress');
    expect(result.order).toBe(1);
  });

  it('includes dependsOn when present', () => {
    const result = taskPatch({
      action: 'update_task',
      dependsOn: ['task-1'],
    });
    expect(result.dependsOn).toEqual(['task-1']);
  });
});

describe('assignmentInput', () => {
  it('maps all fields from input', () => {
    const result = assignmentInput({
      action: 'assign_task',
      agentId: 'agent-1',
      name: 'worker',
      role: 'developer',
      provider: 'openai',
      model: 'gpt-4',
      fallbackProfile: 'fast',
      fallbackModels: ['gpt-3.5'],
      tools: ['read', 'write'],
      allowedCapabilities: ['fs.read'],
      assignee: 'user-1',
      leaseId: 'lease-1',
      claimedAt: '2024-01-01',
      heartbeatAt: '2024-01-02',
      leaseExpiresAt: '2024-01-03',
      attempt: 1,
      maxAttempts: 3,
      costCeilingUsd: 5.0,
      retryPolicy: 'incremental',
      lastFailureKind: 'timeout',
    });
    expect(result.agentId).toBe('agent-1');
    expect(result.name).toBe('worker');
    expect(result.role).toBe('developer');
    expect(result.provider).toBe('openai');
    expect(result.model).toBe('gpt-4');
    expect(result.fallbackProfile).toBe('fast');
    expect(result.fallbackModels).toEqual(['gpt-3.5']);
    expect(result.tools).toEqual(['read', 'write']);
    expect(result.allowedCapabilities).toEqual(['fs.read']);
    expect(result.assignee).toBe('user-1');
    expect(result.leaseId).toBe('lease-1');
    expect(result.claimedAt).toBe('2024-01-01');
    expect(result.heartbeatAt).toBe('2024-01-02');
    expect(result.leaseExpiresAt).toBe('2024-01-03');
    expect(result.attempt).toBe(1);
    expect(result.maxAttempts).toBe(3);
    expect(result.costCeilingUsd).toBe(5.0);
    expect(result.retryPolicy).toBe('incremental');
    expect(result.lastFailureKind).toBe('timeout');
  });
});
