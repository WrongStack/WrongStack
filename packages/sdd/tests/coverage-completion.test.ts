import * as fs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DefaultTaskStore, TaskTracker } from '@wrongstack/core/tasking';
import type { Specification, TaskGraph, TaskNode } from '@wrongstack/core/types';
import { afterEach, describe, expect, it } from 'vitest';
import { buildBoardSnapshot, buildBoardTasks } from '../src/board-types.js';
import { assessTaskNodeAtomicity, decomposeNonAtomicTasks } from '../src/plan-decompose.js';
import { type SddRunControl, SddRunRegistry } from '../src/sdd-run-registry.js';
import { SddSupervisor } from '../src/sdd-supervisor.js';
import { SpecParser } from '../src/spec-parser.js';
import { SpecStore } from '../src/spec-store.js';
import { TaskGenerator } from '../src/task-generator.js';
import { TaskGraphStore } from '../src/task-graph-store.js';

const roots: string[] = [];

function node(id: string, overrides: Partial<TaskNode> = {}): TaskNode {
  return {
    id,
    title: id,
    description: '',
    type: 'feature',
    priority: 'medium',
    status: 'pending',
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
  };
}

function graph(overrides: Partial<TaskGraph> = {}): TaskGraph {
  return {
    id: 'graph',
    specId: 'spec',
    title: 'Graph',
    nodes: new Map([['a', node('a')]]),
    edges: [],
    rootNodes: ['a'],
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
  };
}

function spec(overrides: Partial<Specification> = {}): Specification {
  return {
    id: 'spec',
    title: 'Spec',
    version: '1',
    status: 'draft',
    overview: '',
    sections: [],
    requirements: [],
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
  };
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

describe('SDD small-file coverage completion', () => {
  it('projects malformed edges, metadata, diagnostics, and merge history safely', () => {
    const nodes = new Map<string, TaskNode>([
      [
        'a',
        node('a', {
          status: 'failed',
          metadata: {
            cancelled: true,
            worktreeBranch: 'task/a',
            retries: 2,
            model: 'model',
            provider: 'provider',
            fallbackModels: ['fallback'],
            verificationCommand: 'pnpm test',
            verificationState: 'passed',
            verificationDetail: 'ok',
          },
        }),
      ],
      ['b', node('b')],
    ]);
    const malformed = graph({
      nodes,
      edges: [
        { id: 'ignored', from: 'a', to: 'b', type: 'relates_to' },
        { id: 'dangling-target', from: 'a', to: 'missing', type: 'depends_on' },
        { id: 'dangling-source', from: 'missing', to: 'b', type: 'depends_on' },
      ],
    });

    const projected = buildBoardTasks(malformed);
    expect(projected.tasks[0]).toMatchObject({
      displayStatus: 'cancelled',
      worktreeBranch: 'task/a',
      retries: 2,
      verificationState: 'passed',
    });
    expect(projected.tasks[1]?.deps).toEqual(['missin']);

    const snapshot = buildBoardSnapshot(
      malformed,
      {
        runId: 'run',
        status: 'deadlocked',
        startedAt: 1,
        wave: 1,
        deadlockChains: [{ blocked: 't02', blockedBy: ['missin'] }],
        mergedCommits: [{ taskId: 'a', sha: 'abc', title: 'A' }],
      },
      2,
    );
    expect(snapshot.diagnostics?.deadlockChains).toHaveLength(1);
    expect(snapshot.mergedCommits).toHaveLength(1);
  });

  it('keeps a run registered when a different run is cleared', () => {
    const registry = new SddRunRegistry();
    const control = {
      runId: 'active',
      snapshot: () => ({}) as ReturnType<SddRunControl['snapshot']>,
    } as SddRunControl;
    registry.register(control);
    registry.clear('other');
    expect(registry.getActive()).toBe(control);
    registry.clear('active');
    expect(registry.getActive()).toBeNull();
  });

  it('covers decomposition defaults, child filtering, and an empty applied split', async () => {
    const tracker = new TaskTracker({ store: new DefaultTaskStore() });
    await tracker.createGraph('spec', 'Graph');
    const parent = tracker.addNode({
      title: 'Parent',
      description: 'parent',
      type: 'feature',
      priority: 'medium',
      status: 'pending',
      estimateHours: 1,
    });
    tracker.addNode({
      title: 'Child',
      description: 'child',
      type: 'feature',
      priority: 'medium',
      status: 'pending',
      parentId: parent.id,
      estimateHours: 1,
    });
    const big = tracker.addNode({
      title: 'Build auth and then billing; also migrate database and update docs',
      description: undefined as unknown as string,
      type: 'feature',
      priority: 'critical',
      status: 'pending',
      estimateHours: 40,
    });
    assessTaskNodeAtomicity(tracker, {
      ...big,
      description: undefined as unknown as string,
    });
    assessTaskNodeAtomicity(tracker, {
      ...big,
      description: '**Acceptance Criteria:**\nNo bullet criteria',
    });

    const result = await decomposeNonAtomicTasks({
      tracker,
      mode: 'auto',
      maxDecompositions: 0,
      decompose: async () => {
        tracker.updateNodeStatus(big.id, 'in_progress');
        return [{ title: 'Part', description: 'part', successCriterion: 'done' }];
      },
    });
    expect(result.flagged).toContain(big.id);
    expect(result.applied).toEqual([]);
  });

  it('generates uncommon requirement and endpoint variants', async () => {
    const tracker = new TaskTracker({ store: new DefaultTaskStore() });
    const generator = new TaskGenerator({
      taskTracker: tracker,
      verificationFromAcceptance: true,
      atomicity: {},
    });
    const unusual = spec({
      sections: [{ type: 'overview', title: 'Overview', level: 2, content: 'Overview' }],
      requirements: [
        {
          id: 'odd',
          type: 'functional',
          priority: 'unknown' as 'low',
          description: 'Odd',
          acceptanceCriteria: undefined as unknown as string[],
          blockedBy: [],
        },
        {
          id: 'odd-2',
          type: 'functional',
          priority: 'unknown-2' as 'low',
          description: 'Odd 2',
          acceptanceCriteria: [],
        },
      ],
      apiEndpoints: [
        {
          method: 'GET',
          path: '/plain',
          description: 'Plain',
          auth: false,
          response: {},
        },
      ],
    });

    await generator.generateFromSpec(unusual);
    const nodes = tracker.getAllNodes();
    expect(nodes.find((item) => item.specRequirementId === 'odd')?.estimateHours).toBe(1);
    expect(nodes.find((item) => item.title.includes('/plain'))?.metadata?.atomicity).toBeDefined();

    const emptyTracker = new TaskTracker({ store: new DefaultTaskStore() });
    await new TaskGenerator({ taskTracker: emptyTracker }).generateFromSpec(
      spec({ requirements: undefined as unknown as Specification['requirements'] }),
    );
  });

  it('handles invalid indexes, replacement saves, and failed deletion', async () => {
    const root = join(
      tmpdir(),
      `sdd-task-graph-coverage-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    );
    roots.push(root);
    await fs.mkdir(root, { recursive: true });
    await fs.writeFile(join(root, '_index.json'), JSON.stringify({ version: 2, entries: [] }));
    const store = new TaskGraphStore({ baseDir: root });
    const item = graph();
    await store.save(item);
    await store.save({ ...item, title: 'Updated', updatedAt: 2 });
    expect((await store.list())[0]?.title).toBe('Updated');
    expect(await store.delete('missing')).toBe(false);
  });

  it('covers uncommon parser sections and all completeness inputs', () => {
    const parser = new SpecParser();
    const parsed = parser.parse(`# Complete

## Overview
Overview
### Nested detail

## Requirements
Requirement one

## Data Model
Data

## Acceptance Criteria
Done`);
    expect(parsed.sections.map((section) => section.type)).toEqual([
      'overview',
      'requirements',
      'data',
      'acceptance',
    ]);
    expect(parser.analyze(parsed).completeness).toBeGreaterThanOrEqual(80);
  });

  it('covers missing spec updates, invalid indexes, and failed spec deletion', async () => {
    const root = join(
      tmpdir(),
      `sdd-spec-store-coverage-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    );
    roots.push(root);
    await fs.mkdir(root, { recursive: true });
    await fs.writeFile(join(root, '_index.json'), JSON.stringify({ version: 2, entries: [] }));
    const store = new SpecStore({ baseDir: root });
    expect(await store.list()).toEqual([]);
    expect(await store.update('missing', { title: 'Nope' })).toBeNull();
    expect(await store.delete('missing')).toBe(false);
  });

  it('degrades a rejected supervisor split into retry', async () => {
    const supervisor = new SddSupervisor({
      brain: {
        async decide() {
          return { type: 'answer', optionId: 'split', text: 'split' };
        },
      },
      generateSubtasks: async () => {
        throw new Error('generator unavailable');
      },
    });
    await expect(
      supervisor.superviseFailure({
        task: node('failed', { status: 'failed' }),
        error: 'failed',
        attempts: 0,
      }),
    ).resolves.toEqual({ action: 'retry' });

    const emptyModel = new SddSupervisor({
      brain: {
        async decide() {
          return { type: 'answer', optionId: 'reassign', text: 'reassign' };
        },
      },
      reassignModels: [''],
    });
    await expect(
      emptyModel.superviseFailure({
        task: node('failed', { status: 'failed' }),
        error: 'failed',
        attempts: 0,
      }),
    ).resolves.toEqual({ action: 'reassign', model: undefined, provider: undefined });
  });
});
