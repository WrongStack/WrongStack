import { beforeEach, describe, expect, it } from 'vitest';
import { DefaultTaskStore } from '@wrongstack/core/tasking';
import { TaskGenerator, extractVerificationCommand } from '../src/task-generator.js';
import { TaskTracker } from '../src/task-tracker.js';
import type { TaskStore } from '../src/task-tracker.js';
import type { TaskGraph } from '@wrongstack/core/types/task-graph.js';
import type { SpecRequirement, Specification } from '@wrongstack/core/types/spec.js';

function makeRequirement(overrides: Partial<SpecRequirement> = {}): SpecRequirement {
  return {
    id: 'REQ-1',
    type: 'functional',
    priority: 'medium',
    description: 'Test requirement',
    acceptanceCriteria: [],
    ...overrides,
  };
}

function makeSpec(overrides: Partial<Specification> = {}): Specification {
  return {
    id: 'spec-1',
    title: 'Test Specification',
    version: '1.0.0',
    status: 'draft',
    overview: 'Test overview',
    sections: [],
    requirements: [],
    createdAt: Date.now(),
    updatedAt: Date.now(),
    ...overrides,
  };
}

function makeFakeStore(): TaskStore & { graphs: Map<string, TaskGraph> } {
  const graphs = new Map<string, TaskGraph>();
  return {
    graphs,
    async saveGraph(graph: TaskGraph) {
      graphs.set(graph.id, {
        ...graph,
        nodes: new Map(graph.nodes),
        edges: [...graph.edges],
        rootNodes: [...graph.rootNodes],
      });
    },
    async loadGraph(id: string) {
      const g = graphs.get(id);
      return g
        ? {
            ...g,
            nodes: new Map(g.nodes),
            edges: [...g.edges],
            rootNodes: [...g.rootNodes],
          }
        : null;
    },
    async listGraphs() {
      return Array.from(graphs.values()).map((g) => ({
        id: g.id,
        title: g.title,
        updatedAt: g.updatedAt,
      }));
    },
    async deleteGraph(id: string) {
      graphs.delete(id);
    },
  };
}

describe('TaskGenerator', () => {
  let store: ReturnType<typeof makeFakeStore>;
  let tracker: TaskTracker;
  let generator: TaskGenerator;

  beforeEach(() => {
    store = makeFakeStore();
    tracker = new TaskTracker({ store });
    generator = new TaskGenerator({ taskTracker: tracker });
  });

  describe('generateFromSpec', () => {
    it('creates graph with spec id and title', async () => {
      const spec = makeSpec({ id: 'my-spec', title: 'My Spec' });
      const graph = await generator.generateFromSpec(spec);
      expect(graph.specId).toBe('my-spec');
      expect(graph.title).toBe('My Spec');
    });

    it('adds overview task when overview section exists', async () => {
      const spec = makeSpec({
        sections: [{ type: 'overview', title: 'Overview', level: 2, content: 'Overview content' }],
      });
      await generator.generateFromSpec(spec);
      const nodes = tracker.getAllNodes();
      expect(nodes.some((n) => n.title.includes('Implement'))).toBe(true);
    });

    it('creates tasks for critical requirements first', async () => {
      const spec = makeSpec({
        requirements: [
          makeRequirement({ id: 'REQ-1', priority: 'critical', description: 'Critical task' }),
          makeRequirement({ id: 'REQ-2', priority: 'high', description: 'High task' }),
          makeRequirement({ id: 'REQ-3', priority: 'medium', description: 'Medium task' }),
          makeRequirement({ id: 'REQ-4', priority: 'low', description: 'Low task' }),
        ],
      });
      await generator.generateFromSpec(spec);
      const nodes = tracker.getAllNodes();
      const critical = nodes.find((n) => n.title === 'Critical task');
      expect(critical).toBeDefined();
      expect(critical?.priority).toBe('critical');
    });

    it('maps requirement type to task type', async () => {
      const spec = makeSpec({
        requirements: [
          makeRequirement({ type: 'functional', description: 'Functional req' }),
          makeRequirement({ type: 'security', description: 'Security req' }),
          makeRequirement({ type: 'performance', description: 'Performance req' }),
        ],
      });
      await generator.generateFromSpec(spec);
      const nodes = tracker.getAllNodes();
      const reqNodes = nodes.filter((n) => n.specRequirementId);
      expect(reqNodes.every((n) => n.type === 'feature')).toBe(true);
    });

    it('sets estimate hours based on priority', async () => {
      const spec = makeSpec({
        requirements: [
          makeRequirement({ priority: 'critical', description: 'Crit' }),
          makeRequirement({ priority: 'high', description: 'High' }),
          makeRequirement({ priority: 'medium', description: 'Med' }),
          makeRequirement({ priority: 'low', description: 'Low' }),
        ],
      });
      await generator.generateFromSpec(spec);
      const nodes = tracker.getAllNodes();
      const reqNodes = nodes.filter((n) => n.specRequirementId);
      expect(reqNodes.find((n) => n.priority === 'critical')?.estimateHours).toBe(8);
      expect(reqNodes.find((n) => n.priority === 'high')?.estimateHours).toBe(4);
      expect(reqNodes.find((n) => n.priority === 'medium')?.estimateHours).toBe(2);
      expect(reqNodes.find((n) => n.priority === 'low')?.estimateHours).toBe(1);
    });

    it('adds API tasks when spec has apiEndpoints', async () => {
      const spec = makeSpec({
        apiEndpoints: [
          {
            method: 'GET',
            path: '/users',
            description: 'Get users',
            auth: false,
            request: undefined,
            response: {},
          },
          {
            method: 'POST',
            path: '/users',
            description: 'Create user',
            auth: true,
            request: {},
            response: {},
          },
        ],
      });
      await generator.generateFromSpec(spec);
      const nodes = tracker.getAllNodes();
      const apiParent = nodes.find((n) => n.title === 'API Implementation');
      expect(apiParent).toBeDefined();
      const children = tracker.getChildren(apiParent!.id);
      expect(children).toHaveLength(2);
    });

    it('estimates extra hours for authenticated endpoints', async () => {
      const spec = makeSpec({
        apiEndpoints: [
          {
            method: 'GET',
            path: '/public',
            description: 'Public',
            auth: false,
            request: undefined,
            response: {},
          },
          {
            method: 'GET',
            path: '/private',
            description: 'Private',
            auth: true,
            request: { type: 'object' as any, fields: [] },
            response: {},
          },
        ],
      });
      await generator.generateFromSpec(spec);
      const nodes = tracker.getAllNodes();
      const apiNodes = nodes.filter((n) => n.title.includes('GET'));
      const privateNode = apiNodes.find((n) => n.title.includes('/private'));
      // auth=true adds 1 hour, request=true adds 1 hour (total 2+2=4)
      expect(privateNode?.estimateHours).toBe(4);
      const publicNode = apiNodes.find((n) => n.title.includes('/public'));
      // auth=false, no request = 2 hours
      expect(publicNode?.estimateHours).toBe(2);
    });

    it('always adds Write Tests task', async () => {
      const spec = makeSpec({ requirements: [] });
      await generator.generateFromSpec(spec);
      const nodes = tracker.getAllNodes();
      expect(nodes.find((n) => n.title === 'Write Tests')).toBeDefined();
    });

    it('always adds Update Documentation task', async () => {
      const spec = makeSpec({ requirements: [] });
      await generator.generateFromSpec(spec);
      const nodes = tracker.getAllNodes();
      expect(nodes.find((n) => n.title === 'Update Documentation')).toBeDefined();
    });

    it('sets specRequirementId on task nodes', async () => {
      const spec = makeSpec({
        requirements: [makeRequirement({ id: 'REQ-TEST', description: 'Test req' })],
      });
      await generator.generateFromSpec(spec);
      const nodes = tracker.getAllNodes();
      const taskNode = nodes.find((n) => n.specRequirementId === 'REQ-TEST');
      expect(taskNode).toBeDefined();
    });

    it('adds tags to task nodes based on requirement type and priority', async () => {
      const spec = makeSpec({
        requirements: [
          makeRequirement({ type: 'security', priority: 'critical', description: 'Sec' }),
        ],
      });
      await generator.generateFromSpec(spec);
      const nodes = tracker.getAllNodes();
      const taskNode = nodes.find((n) => n.specRequirementId === 'REQ-1');
      expect(taskNode?.tags).toContain('security');
      expect(taskNode?.tags).toContain('critical');
    });

    it('builds description with acceptance criteria', async () => {
      const spec = makeSpec({
        requirements: [
          makeRequirement({
            description: 'Main desc',
            acceptanceCriteria: ['AC1', 'AC2'],
          }),
        ],
      });
      await generator.generateFromSpec(spec);
      const nodes = tracker.getAllNodes();
      const taskNode = nodes.find((n) => n.specRequirementId === 'REQ-1');
      expect(taskNode?.description).toContain('Main desc');
      expect(taskNode?.description).toContain('**Type:**');
      expect(taskNode?.description).toContain('**Acceptance Criteria:**');
      expect(taskNode?.description).toContain('- AC1');
      expect(taskNode?.description).toContain('- AC2');
    });

    it('includes blocked by info in description', async () => {
      const spec = makeSpec({
        requirements: [
          makeRequirement({
            description: 'Blocked task',
            blockedBy: ['REQ-BLOCKED'],
          }),
        ],
      });
      await generator.generateFromSpec(spec);
      const nodes = tracker.getAllNodes();
      const taskNode = nodes.find((n) => n.specRequirementId === 'REQ-1');
      expect(taskNode?.description).toContain('**Blocked by:** REQ-BLOCKED');
    });
  });

  describe('generateSubtasks', () => {
    it('returns early if task has no specRequirementId', async () => {
      const spec = makeSpec({ requirements: [] });
      await tracker.createGraph('s', 't');
      const taskId = tracker.addNode({
        title: 'Task',
        description: '',
        type: 'feature',
        priority: 'high',
        status: 'pending',
      }).id;
      await generator.generateSubtasks(taskId, spec);
      // Should not throw and not add any nodes
      const children = tracker.getChildren(taskId);
      expect(children).toHaveLength(0);
    });

    it('returns early if requirement not found in spec', async () => {
      const spec = makeSpec({ requirements: [] });
      await tracker.createGraph('s', 't');
      const taskId = tracker.addNode({
        title: 'Task',
        description: '',
        type: 'feature',
        priority: 'high',
        status: 'pending',
        specRequirementId: 'NONEXISTENT',
      }).id;
      await generator.generateSubtasks(taskId, spec);
      // Should not throw
    });

    it('creates subtasks for each acceptance criterion', async () => {
      const spec = makeSpec({
        requirements: [
          makeRequirement({
            id: 'REQ-SUB',
            description: 'Parent task',
            acceptanceCriteria: ['AC1', 'AC2', 'AC3'],
          }),
        ],
      });
      await tracker.createGraph('s', 't');
      const parentId = tracker.addNode({
        title: 'Parent',
        description: '',
        type: 'feature',
        priority: 'high',
        status: 'pending',
        specRequirementId: 'REQ-SUB',
      }).id;

      await generator.generateSubtasks(parentId, spec);

      const subtasks = tracker.getChildren(parentId);
      expect(subtasks).toHaveLength(3);
      expect(subtasks.every((n) => n.type === 'test')).toBe(true);
      expect(subtasks[0].title).toBe('AC1');
    });

    it('skips requirement with no acceptance criteria', async () => {
      const spec = makeSpec({
        requirements: [
          makeRequirement({ id: 'REQ-NOAC', description: 'No AC', acceptanceCriteria: [] }),
        ],
      });
      await tracker.createGraph('s', 't');
      const parentId = tracker.addNode({
        title: 'Parent',
        description: '',
        type: 'feature',
        priority: 'high',
        status: 'pending',
        specRequirementId: 'REQ-NOAC',
      }).id;

      await generator.generateSubtasks(parentId, spec);

      const children = tracker.getChildren(parentId);
      expect(children).toHaveLength(0);
    });
  });
});

describe('DefaultTaskStore', () => {
  let store: DefaultTaskStore;

  beforeEach(() => {
    store = new DefaultTaskStore();
  });

  describe('saveGraph', () => {
    it('saves graph without error', async () => {
      const graph: TaskGraph = {
        id: 'g1',
        specId: 's1',
        title: 'Test Graph',
        nodes: new Map(),
        edges: [],
        rootNodes: [],
        createdAt: Date.now(),
        updatedAt: Date.now(),
      };
      await expect(store.saveGraph(graph)).resolves.not.toThrow();
    });

    it('preserves nodes map after save', async () => {
      const graph: TaskGraph = {
        id: 'g1',
        specId: 's1',
        title: 'Test Graph',
        nodes: new Map([
          [
            'n1',
            {
              id: 'n1',
              title: 'Node',
              description: '',
              type: 'feature',
              priority: 'high',
              status: 'pending',
              createdAt: 0,
              updatedAt: 0,
            },
          ],
        ]),
        edges: [],
        rootNodes: [],
        createdAt: Date.now(),
        updatedAt: Date.now(),
      };
      await store.saveGraph(graph);
      const loaded = await store.loadGraph('g1');
      expect(loaded?.nodes.get('n1')).toBeDefined();
    });
  });

  describe('loadGraph', () => {
    it('returns null for nonexistent graph', async () => {
      const result = await store.loadGraph('nonexistent');
      expect(result).toBeNull();
    });

    it('returns cloned graph (not same reference)', async () => {
      const graph: TaskGraph = {
        id: 'g1',
        specId: 's1',
        title: 'Test',
        nodes: new Map(),
        edges: [],
        rootNodes: [],
        createdAt: Date.now(),
        updatedAt: Date.now(),
      };
      await store.saveGraph(graph);
      const loaded1 = await store.loadGraph('g1');
      const loaded2 = await store.loadGraph('g1');
      expect(loaded1).not.toBe(loaded2);
      expect(loaded1?.id).toBe(loaded2?.id);
    });
  });

  describe('listGraphs', () => {
    it('returns empty array initially', async () => {
      const result = await store.listGraphs();
      expect(result).toHaveLength(0);
    });

    it('returns all saved graphs', async () => {
      const g1: TaskGraph = {
        id: 'g1',
        specId: 's1',
        title: 'Graph 1',
        nodes: new Map(),
        edges: [],
        rootNodes: [],
        createdAt: 0,
        updatedAt: 0,
      };
      const g2: TaskGraph = {
        id: 'g2',
        specId: 's1',
        title: 'Graph 2',
        nodes: new Map(),
        edges: [],
        rootNodes: [],
        createdAt: 0,
        updatedAt: 0,
      };
      await store.saveGraph(g1);
      await store.saveGraph(g2);
      const result = await store.listGraphs();
      expect(result).toHaveLength(2);
      expect(result.some((g) => g.id === 'g1')).toBe(true);
      expect(result.some((g) => g.id === 'g2')).toBe(true);
    });
  });

  describe('deleteGraph', () => {
    it('deletes existing graph', async () => {
      const graph: TaskGraph = {
        id: 'g1',
        specId: 's1',
        title: 'Test',
        nodes: new Map(),
        edges: [],
        rootNodes: [],
        createdAt: 0,
        updatedAt: 0,
      };
      await store.saveGraph(graph);
      await store.deleteGraph('g1');
      const loaded = await store.loadGraph('g1');
      expect(loaded).toBeNull();
    });

    it('does nothing for nonexistent graph', async () => {
      await expect(store.deleteGraph('nonexistent')).resolves.not.toThrow();
    });
  });
});

describe('extractVerificationCommand', () => {
  it('recognizes $ / run: / verify: / cmd: markers (first wins)', () => {
    expect(extractVerificationCommand(['$ pnpm vitest run x'])).toBe('pnpm vitest run x');
    expect(extractVerificationCommand(['run: npm test'])).toBe('npm test');
    expect(extractVerificationCommand(['VERIFY:  make check  '])).toBe('make check');
    expect(extractVerificationCommand(['cmd:lint'])).toBe('lint');
    expect(extractVerificationCommand(['free text', 'verify: a', 'cmd: b'])).toBe('a');
  });
  it('returns undefined for unmarked / empty criteria', () => {
    expect(extractVerificationCommand([])).toBeUndefined();
    expect(extractVerificationCommand(['the app should be fast', 'login works'])).toBeUndefined();
    expect(extractVerificationCommand(['$'])).toBeUndefined();
  });
});

describe('TaskGenerator — verificationFromAcceptance (opt-in)', () => {
  const req = (criteria: string[]): SpecRequirement =>
    makeRequirement({
      id: 'REQ-V',
      description: 'Gated requirement',
      acceptanceCriteria: criteria,
    });

  function run(enabled: boolean, criteria: string[]) {
    const trk = new TaskTracker({ store: makeFakeStore() });
    const gen = new TaskGenerator({ taskTracker: trk, verificationFromAcceptance: enabled });
    return gen
      .generateFromSpec(makeSpec({ requirements: [req(criteria)] }))
      .then(() => trk.getAllNodes().find((n) => n.specRequirementId === 'REQ-V'));
  }

  it('is OFF by default — no verificationCommand even with a marked criterion', async () => {
    const node = await run(false, ['$ pnpm vitest run x']);
    expect(node?.metadata?.verificationCommand).toBeUndefined();
  });

  it('extracts a marked command when enabled', async () => {
    const node = await run(true, ['must be fast', 'verify: pnpm test auth']);
    expect(node?.metadata?.verificationCommand).toBe('pnpm test auth');
  });

  it('ignores plain free-text criteria (no marker → no command)', async () => {
    const node = await run(true, ['the page loads quickly', 'users can log in']);
    expect(node?.metadata?.verificationCommand).toBeUndefined();
  });
});

describe('TaskGenerator — atomicity annotation (opt-in)', () => {
  function run(atomicity: boolean, requirement: SpecRequirement) {
    const trk = new TaskTracker({ store: makeFakeStore() });
    const gen = new TaskGenerator({
      taskTracker: trk,
      ...(atomicity ? { atomicity: {} } : {}),
    });
    return gen
      .generateFromSpec(makeSpec({ requirements: [requirement] }))
      .then(() => trk.getAllNodes());
  }

  it('is OFF by default — no metadata.atomicity', async () => {
    const nodes = await run(false, makeRequirement());
    expect(nodes.every((n) => n.metadata?.atomicity === undefined)).toBe(true);
  });

  it('stamps verdict/score/reasons on generated nodes when enabled', async () => {
    const nodes = await run(
      true,
      makeRequirement({
        id: 'REQ-A',
        priority: 'medium',
        description: 'Small verifiable requirement',
        acceptanceCriteria: ['verify: pnpm test small'],
      }),
    );
    const reqNode = nodes.find((n) => n.specRequirementId === 'REQ-A');
    const atomicity = reqNode?.metadata?.atomicity as
      | { verdict: string; score: number; reasons: string[] }
      | undefined;
    expect(atomicity).toBeDefined();
    expect(typeof atomicity!.score).toBe('number');
    expect(['atomic', 'borderline', 'needs_decomposition']).toContain(atomicity!.verdict);
    // Closing tasks are annotated too.
    const testsNode = nodes.find((n) => n.title === 'Write Tests');
    expect(testsNode?.metadata?.atomicity).toBeDefined();
  });

  it('marks an oversized critical requirement as needs_decomposition', async () => {
    const nodes = await run(
      true,
      makeRequirement({
        id: 'REQ-B',
        priority: 'critical',
        description:
          'Build auth and then billing; also migrate the database and then update all docs',
        acceptanceCriteria: [],
      }),
    );
    const reqNode = nodes.find((n) => n.specRequirementId === 'REQ-B');
    const atomicity = reqNode?.metadata?.atomicity as { verdict: string; reasons: string[] };
    expect(atomicity.verdict).toBe('needs_decomposition');
    expect(atomicity.reasons.length).toBeGreaterThan(0);
  });

  describe('ensureRequirementCoverage — uncovered branches', () => {
    function freshTracker() {
      const trk = new TaskTracker({ store: makeFakeStore() });
      const gen = new TaskGenerator({ taskTracker: trk });
      return { trk, gen };
    }

    it('throws when the graph targets a different spec (:228)', async () => {
      const { trk, gen } = freshTracker();
      const graph = await trk.createGraph('spec-1', 'Mismatched graph');

      expect(() => gen.ensureRequirementCoverage(makeSpec({ id: 'spec-2' }), graph)).toThrow(
        'Task graph spec mismatch',
      );
    });

    it('treats a spec without requirements as an empty scope (:235, :253)', async () => {
      const { trk, gen } = freshTracker();
      const graph = await trk.createGraph('spec-1', 'Empty scope');
      const spec = makeSpec();
      delete (spec as { requirements?: unknown }).requirements;

      const added = gen.ensureRequirementCoverage(spec, graph);

      expect(added).toEqual([]);
      expect(graph.requiredRequirementIds).toEqual([]);
    });

    it('drops a node mapping that points outside the approved scope (:240)', async () => {
      const { trk, gen } = freshTracker();
      const graph = await trk.createGraph('spec-1', 'Typo mapping');
      const node = trk.addNode({
        title: 'Model task with a typo requirement id',
        description: 'Maps to no approved requirement.',
        type: 'feature',
        priority: 'medium',
        status: 'pending',
        specRequirementId: 'REQ-TYPO',
      });
      const spec = makeSpec({
        requirements: [makeRequirement({ id: 'REQ-1', description: 'Real requirement' })],
      });

      const added = gen.ensureRequirementCoverage(spec, graph);

      // The untrusted mapping is dropped; the canonical requirement still
      // receives its deterministic task.
      expect(node.specRequirementId).toBeUndefined();
      expect(added.map((n) => n.specRequirementId)).toEqual(['REQ-1']);
      // The proposed task remains as additional work.
      expect(graph.nodes.has(node.id)).toBe(true);
    });
  });
});
