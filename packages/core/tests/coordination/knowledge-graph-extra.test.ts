import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { KnowledgeGraph } from '../../src/coordination/knowledge-graph.js';

let dir: string;
let kg: KnowledgeGraph;
beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'wstack-kg-'));
  kg = new KnowledgeGraph(dir);
});
afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true });
});

const fact = (over: Record<string, unknown> = {}) =>
  ({
    type: 'fact',
    subject: 's',
    detail: 'd',
    category: 'general',
    tags: [],
    discoveredBy: 'a1',
    key: 'k',
    related: [],
    ...over,
  }) as never;

describe('knowledge-graph — extra coverage', () => {
  it('getPendingChanges returns proposed changes; getDecisions returns decisions', async () => {
    await kg.add({
      type: 'change',
      title: 't',
      description: 'd',
      files: [],
      status: 'proposed',
      proposedBy: 'a1',
      proposedAt: 'now',
      approvedBy: [],
      rejectedBy: [],
      votes: [],
      qualityGate: { passed: true, checks: [] },
      satisfiesGoals: ['goal-1'],
    } as never);
    expect(kg.getPendingChanges()).toHaveLength(1);
    await kg.add({
      type: 'decision',
      title: 'd1',
      rationale: 'because',
      decidedBy: 'a1',
      decidedAt: 'now',
    } as never);
    expect(kg.getDecisions()).toHaveLength(1);
  });

  it('searchFacts matches subject, detail, file and tags (case-insensitive)', async () => {
    await kg.add(fact({ subject: 'AuthFlow', detail: 'login logic' }));
    await kg.add(fact({ subject: 'other', detail: 'has TOKEN secret' }));
    await kg.add(fact({ subject: 'x', detail: 'y', file: 'src/Server.ts' }));
    await kg.add(fact({ subject: 'z', detail: 'w', tags: ['Performance'] }));
    expect(kg.searchFacts('authflow')).toHaveLength(1);
    expect(kg.searchFacts('token')).toHaveLength(1);
    expect(kg.searchFacts('server.ts')).toHaveLength(1);
    expect(kg.searchFacts('performance')).toHaveLength(1);
    expect(kg.searchFacts('nomatch')).toHaveLength(0);
  });

  it('getRelatedFacts returns related fact nodes, or [] for an unknown id', async () => {
    const a = await kg.add(fact({ subject: 'A' }));
    const b = await kg.add(fact({ subject: 'B', related: [a.id] }));
    expect(kg.getRelatedFacts(b.id).map((f) => f.id)).toEqual([a.id]);
    expect(kg.getRelatedFacts('nonexistent')).toEqual([]);
  });

  it('makeQualityGate aggregates pass/fail', () => {
    expect(
      KnowledgeGraph.makeQualityGate([
        { name: 'a', passed: true },
        { name: 'b', passed: true },
      ]).passed,
    ).toBe(true);
    expect(
      KnowledgeGraph.makeQualityGate([
        { name: 'a', passed: true },
        { name: 'b', passed: false },
      ]).passed,
    ).toBe(false);
  });

  it('getAll filters by assignee, discoveredBy, proposedBy and tags', async () => {
    await kg.add({
      type: 'goal',
      title: 'g',
      description: '',
      status: 'pending',
      priority: 'high',
      assignee: 'agent-x',
      tags: ['ui'],
      createdBy: 'a',
      createdAt: 'now',
    } as never);
    await kg.add(fact({ discoveredBy: 'finder-1', tags: ['perf'] }));
    await kg.add({
      type: 'change',
      title: 'c',
      description: '',
      files: [],
      status: 'proposed',
      proposedBy: 'proposer-1',
      proposedAt: 'now',
      approvedBy: [],
      rejectedBy: [],
      votes: [],
      qualityGate: { passed: true, checks: [] },
      satisfiesGoals: [],
    } as never);
    expect(kg.getAll({ assignee: 'agent-x' })).toHaveLength(1);
    expect(kg.getAll({ discoveredBy: 'finder-1' })).toHaveLength(1);
    expect(kg.getAll({ proposedBy: 'proposer-1' })).toHaveLength(1);
    expect(kg.getAll({ tags: ['ui'] })).toHaveLength(1);
    expect(kg.getAll({ tags: ['none'] })).toHaveLength(0);
  });

  it('snapshot returns nodes and subscription count', async () => {
    await kg.add(fact());
    kg.subscribe('a1', { type: 'fact' });
    const snap = kg.snapshot();
    expect(snap.nodes).toHaveLength(1);
    expect(snap.subs).toBe(1);
  });

  it('index-routed getAll preserves creation order even after an update', async () => {
    // Three goals added in order g1, g2, g3.
    const g1 = await kg.add({
      type: 'goal',
      title: 'g1',
      description: '',
      status: 'pending',
      priority: 'medium',
      createdBy: 'a',
      createdAt: 'now',
      tags: [],
    } as never);
    const g2 = await kg.add({
      type: 'goal',
      title: 'g2',
      description: '',
      status: 'pending',
      priority: 'medium',
      createdBy: 'a',
      createdAt: 'now',
      tags: [],
    } as never);
    const g3 = await kg.add({
      type: 'goal',
      title: 'g3',
      description: '',
      status: 'pending',
      priority: 'medium',
      createdBy: 'a',
      createdAt: 'now',
      tags: [],
    } as never);

    // Updating g1 does a remove+re-add in the type index, moving its id to the
    // set's tail. Without seq-sorting, index-routed getAll would return g2,g3,g1.
    await kg.update((g1 as { id: string }).id, { title: 'g1-updated' });

    const order = kg.getGoals().map((g) => g.title);
    expect(order).toEqual(['g1-updated', 'g2', 'g3']);

    // Sanity: the ids are in creation order too.
    const ids = kg.getGoals().map((g) => (g as { id: string }).id);
    expect(ids).toEqual([
      (g1 as { id: string }).id,
      (g2 as { id: string }).id,
      (g3 as { id: string }).id,
    ]);
  });

  it('type-filtered getAll narrows by type then applies secondary predicates', async () => {
    await kg.add({
      type: 'goal',
      title: 'goal-pending',
      description: '',
      status: 'pending',
      priority: 'high',
      createdBy: 'a',
      createdAt: 'now',
      tags: [],
    } as never);
    await kg.add({
      type: 'goal',
      title: 'goal-done',
      description: '',
      status: 'done',
      priority: 'high',
      createdBy: 'a',
      createdAt: 'now',
      tags: [],
    } as never);
    await kg.add(fact()); // a non-goal node that the type index must exclude

    // type:goal index has 2 ids; the status predicate keeps exactly 1.
    const pending = kg.getAll({ type: 'goal', status: 'pending' });
    expect(pending).toHaveLength(1);
    expect(pending[0]?.type).toBe('goal');

    // A type with no nodes yields [] without touching the full node map.
    expect(kg.getAll({ type: 'vote' })).toEqual([]);
  });

  it('load() rebuilds state from both plain and {op:"update"} log lines', async () => {
    const gdir = path.join(dir, '_knowledge_graph');
    await fs.mkdir(gdir, { recursive: true });
    const plain = {
      id: 'n1',
      type: 'fact',
      subject: 'plain',
      detail: 'd',
      category: 'general',
      tags: [],
      discoveredBy: 'a',
      key: 'k',
      related: [],
    };
    const updated = {
      op: 'update',
      node: {
        id: 'n2',
        type: 'fact',
        subject: 'updated',
        detail: 'd',
        category: 'general',
        tags: [],
        discoveredBy: 'a',
        key: 'k',
        related: [],
      },
    };
    await fs.writeFile(
      path.join(gdir, 'graph.jsonl'),
      JSON.stringify(plain) + '\n' + JSON.stringify(updated) + '\n{bad json\n',
      'utf8',
    );
    const fresh = new KnowledgeGraph(dir);
    await fresh.load();
    expect(fresh.get('n1')?.type).toBe('fact');
    expect(fresh.get('n2')?.type).toBe('fact');
  });

  it('compacts repeated updates to the latest node versions', async () => {
    const compacting = new KnowledgeGraph(dir, 2_000, 5);
    const node = await compacting.add(fact({ detail: 'version-0' }));
    for (let version = 1; version <= 12; version++) {
      await compacting.update(node.id, { detail: `version-${version}` } as never);
    }

    const graphPath = path.join(dir, '_knowledge_graph', 'graph.jsonl');
    const lines = (await fs.readFile(graphPath, 'utf8')).trim().split('\n').filter(Boolean);
    expect(lines.length).toBeLessThanOrEqual(4);

    const reloaded = new KnowledgeGraph(dir);
    await reloaded.load();
    expect((reloaded.get(node.id) as { detail?: string } | undefined)?.detail).toBe('version-12');
  });
});
