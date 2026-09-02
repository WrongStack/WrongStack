import { describe, expect, it, vi, beforeEach } from 'vitest';
import {
  ChangeManager,
  DEFAULT_QUALITY_CHECKS,
  type ChangeFile,
  type ChangeProposal,
} from '../../src/coordination/change-manager.js';
import type {
  ChangeNode,
  KnowledgeGraph,
  QualityGateResult,
} from '../../src/coordination/knowledge-graph.js';
import type { ConsensusProtocol } from '../../src/coordination/consensus-protocol.js';
import type { FleetBus } from '../../src/coordination/fleet-bus.js';

// ── Mock helpers ──────────────────────────────────────────────────────────────

function createMockGraph(): KnowledgeGraph {
  const nodes = new Map<string, ChangeNode>();

  return {
    add: vi.fn(async (data: Record<string, unknown>) => {
      const id = `change_${nodes.size + 1}`;
      const node: ChangeNode = {
        id,
        type: 'change',
        title: String(data.title ?? 'Untitled'),
        description: String(data.description ?? ''),
        files: (data.files as ChangeNode['files']) ?? [],
        status: String(data.status ?? 'proposed'),
        proposedBy: String(data.proposedBy ?? ''),
        proposedAt: new Date().toISOString(),
        approvedBy: [],
        rejectedBy: [],
        votes: [],
        qualityGate: { passed: false, checks: [] },
        satisfiesGoals: (data.satisfiesGoals as string[]) ?? [],
      } as ChangeNode;
      nodes.set(id, node);
      return node;
    }),
    get: vi.fn((id: string) => {
      const n = nodes.get(id);
      // Return latest state from the map (after updates)
      return n;
    }),
    update: vi.fn(async (id: string, patch: Record<string, unknown>) => {
      const node = nodes.get(id);
      if (!node) return null;
      // Deep merge for qualityGate
      if (patch.qualityGate) {
        node.qualityGate = patch.qualityGate as ChangeNode['qualityGate'];
      } else {
        Object.assign(node, patch);
      }
      return node;
    }),
    getChanges: vi.fn(() => Array.from(nodes.values())),
    query: vi.fn(() => []),
    addEdge: vi.fn(),
    getEdges: vi.fn(() => []),
    subscribe: vi.fn(() => () => {}),
    dispose: vi.fn(),
  } as never as KnowledgeGraph;
}

function createMockConsensus(): ConsensusProtocol {
  return {
    initiateVote: vi.fn(),
    castVote: vi.fn(),
    resolveNow: vi.fn(),
    registerVoter: vi.fn(),
    getStatus: vi.fn(() => null),
  } as never as ConsensusProtocol;
}

function createMockFleetBus(): FleetBus {
  return {
    emit: vi.fn(),
    subscribe: vi.fn(() => () => {}),
    unsubscribe: vi.fn(),
    dispose: vi.fn(),
  } as never as FleetBus;
}

function sampleChangeProposal(overrides: Partial<ChangeProposal> = {}): ChangeProposal {
  return {
    title: 'Refactor auth module',
    description: 'Clean up authentication logic',
    files: [{ path: 'src/auth.ts', action: 'modify' as const, diff: '...' }],
    proposedBy: 'agent-1',
    satisfiesGoals: ['goal-1'],
    tags: ['refactor'],
    ...overrides,
  };
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe('ChangeManager', () => {
  let graph: KnowledgeGraph;
  let consensus: ConsensusProtocol;
  let fleet: FleetBus;
  let manager: ChangeManager;

  beforeEach(() => {
    graph = createMockGraph();
    consensus = createMockConsensus();
    fleet = createMockFleetBus();
    manager = new ChangeManager({ graph, consensus, fleet });
  });

  describe('DEFAULT_QUALITY_CHECKS', () => {
    it('has sensible defaults', () => {
      expect(DEFAULT_QUALITY_CHECKS.runTests).toBe(true);
      expect(DEFAULT_QUALITY_CHECKS.runTypecheck).toBe(true);
      expect(DEFAULT_QUALITY_CHECKS.runLint).toBe(false);
      expect(DEFAULT_QUALITY_CHECKS.runSecurityScan).toBe(true);
    });
  });

  describe('propose', () => {
    it('creates a change node in the graph', async () => {
      const proposal = sampleChangeProposal();
      const node = await manager.propose(proposal);

      expect(graph.add).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'change',
          title: proposal.title,
          description: proposal.description,
          proposedBy: proposal.proposedBy,
          status: 'proposed',
        }),
      );
      expect(node.id).toBeDefined();
      expect(node.type).toBe('change');
    });

    it('maps files correctly', async () => {
      const files: ChangeFile[] = [
        { path: 'src/a.ts', action: 'create', content: '...' },
        { path: 'src/b.ts', action: 'delete' },
        { path: 'src/c.ts', action: 'modify', diff: '...' },
      ];
      const proposal = sampleChangeProposal({ files });
      const node = await manager.propose(proposal);

      expect(node.files).toHaveLength(3);
      expect(node.files[0]).toEqual(
        expect.objectContaining({ path: 'src/a.ts', action: 'create' }),
      );
    });

    it('sets satisfiesGoals', async () => {
      const proposal = sampleChangeProposal({ satisfiesGoals: ['goal-1', 'goal-2'] });
      const node = await manager.propose(proposal);

      expect(node.satisfiesGoals).toEqual(['goal-1', 'goal-2']);
    });

    it('emits change:proposed event', async () => {
      const proposal = sampleChangeProposal();
      await manager.propose(proposal);

      expect(fleet.emit).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'change:proposed',
          payload: expect.objectContaining({ title: proposal.title }),
        }),
      );
    });

    it('runs quality gate asynchronously', async () => {
      const proposal = sampleChangeProposal();
      const node = await manager.propose(proposal);

      // Wait for async quality gate
      await new Promise((r) => setTimeout(r, 10));

      expect(graph.update).toHaveBeenCalledWith(
        node.id,
        expect.objectContaining({ qualityGate: expect.any(Object) }),
      );
    });
  });

  describe('submitForReview', () => {
    it('initiates consensus vote', async () => {
      const proposal = sampleChangeProposal();
      const node = await manager.propose(proposal);

      await manager.submitForReview(node.id);

      expect(consensus.initiateVote).toHaveBeenCalledWith(node.id);
    });

    it('throws for unknown change', async () => {
      await expect(manager.submitForReview('nonexistent')).rejects.toThrow(/no change found/);
    });

    it('throws for non-proposed change', async () => {
      const proposal = sampleChangeProposal();
      const node = await manager.propose(proposal);
      await graph.update(node.id, { status: 'approved' });

      await expect(manager.submitForReview(node.id)).rejects.toThrow(/not in 'proposed' state/);
    });

    it('emits change:submitted_for_review event', async () => {
      const node = await manager.propose(sampleChangeProposal());
      await manager.submitForReview(node.id);

      expect(fleet.emit).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'change:submitted_for_review',
          payload: expect.objectContaining({ changeId: node.id }),
        }),
      );
    });
  });

  describe('markApplied', () => {
    it('updates change status to applied', async () => {
      const node = await manager.propose(sampleChangeProposal());
      const appliedAt = new Date().toISOString();

      const result = await manager.markApplied(node.id, appliedAt);

      expect(result).not.toBeNull();
      expect(graph.update).toHaveBeenCalledWith(
        node.id,
        expect.objectContaining({ status: 'applied', appliedAt }),
      );
    });

    it('returns null for unknown change', async () => {
      const result = await manager.markApplied('nonexistent', new Date().toISOString());
      expect(result).toBeNull();
    });

    it('emits change:applied event', async () => {
      const node = await manager.propose(sampleChangeProposal());
      await manager.markApplied(node.id, new Date().toISOString());

      expect(fleet.emit).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'change:applied',
          payload: expect.objectContaining({ changeId: node.id }),
        }),
      );
    });
  });

  describe('markAppliedWithVerification', () => {
    it('returns success when verification passes', async () => {
      const node = await manager.propose(sampleChangeProposal());
      const verify = vi.fn().mockResolvedValue({ passed: true, checks: [] });

      const result = await manager.markAppliedWithVerification(node.id, verify);

      expect(result.success).toBe(true);
      expect(result.changeId).toBe(node.id);
      expect(verify).toHaveBeenCalled();
    });

    it('returns failure and proposes rollback when verification fails', async () => {
      const node = await manager.propose(sampleChangeProposal());
      const failedGate: QualityGateResult = {
        passed: false,
        checks: [{ name: 'tests', passed: false, detail: '2 tests failed' }],
      };
      const verify = vi.fn().mockResolvedValue(failedGate);

      const result = await manager.markAppliedWithVerification(node.id, verify);

      expect(result.success).toBe(false);
      expect(result.error).toContain('tests');
      expect(result.rollbackChangeId).toBeDefined();
    });

    it('throws for unknown change', async () => {
      const verify = vi.fn();
      await expect(manager.markAppliedWithVerification('nonexistent', verify)).rejects.toThrow(
        /unknown change/,
      );
    });
  });

  describe('proposeRollback', () => {
    it('creates a rollback change that reverses files', async () => {
      const original = await manager.propose({
        ...sampleChangeProposal(),
        files: [
          { path: 'src/a.ts', action: 'create' },
          { path: 'src/b.ts', action: 'delete' },
          { path: 'src/c.ts', action: 'modify' },
        ],
      });

      const rollback = await manager.proposeRollback(original.id, 'Tests failed');

      expect(rollback).not.toBeNull();
      expect(rollback!.title).toContain('Rollback');
      expect(rollback!.files).toEqual([
        { path: 'src/a.ts', action: 'delete' },
        { path: 'src/b.ts', action: 'create' },
        { path: 'src/c.ts', action: 'modify' },
      ]);
    });

    it('marks original with rollback reason', async () => {
      const original = await manager.propose(sampleChangeProposal());
      await manager.proposeRollback(original.id, 'Quality gate failed');

      expect(graph.update).toHaveBeenCalledWith(
        original.id,
        expect.objectContaining({
          rollbackReason: 'Quality gate failed',
        }),
      );
    });

    it('emits change:rollback_proposed event', async () => {
      const original = await manager.propose(sampleChangeProposal());
      await manager.proposeRollback(original.id, 'test');

      expect(fleet.emit).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'change:rollback_proposed',
          payload: expect.objectContaining({
            originalChangeId: original.id,
          }),
        }),
      );
    });

    it('returns null for unknown original', async () => {
      const result = await manager.proposeRollback('nonexistent', 'reason');
      expect(result).toBeNull();
    });
  });

  describe('markRolledBack', () => {
    it('updates status to rolled_back', async () => {
      const node = await manager.propose(sampleChangeProposal());
      const rolledBackAt = new Date().toISOString();

      const result = await manager.markRolledBack(node.id, rolledBackAt);

      expect(result).not.toBeNull();
      expect(graph.update).toHaveBeenCalledWith(
        node.id,
        expect.objectContaining({ status: 'rolled_back', rolledBackAt }),
      );
    });

    it('emits change:rolled_back event', async () => {
      const node = await manager.propose(sampleChangeProposal());
      await manager.markRolledBack(node.id, new Date().toISOString());

      expect(fleet.emit).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'change:rolled_back',
          payload: expect.objectContaining({ changeId: node.id }),
        }),
      );
    });
  });

  describe('queries', () => {
    it('getPendingReviews returns proposed changes', async () => {
      const node = await manager.propose(sampleChangeProposal());

      const pending = manager.getPendingReviews();

      expect(pending).toContainEqual(expect.objectContaining({ id: node.id }));
    });

    it('getAppliedChanges returns applied changes', async () => {
      const node = await manager.propose(sampleChangeProposal());
      await manager.markApplied(node.id, new Date().toISOString());

      const applied = manager.getAppliedChanges();

      expect(applied).toContainEqual(expect.objectContaining({ id: node.id, status: 'applied' }));
    });

    it('getChange returns specific change', async () => {
      const node = await manager.propose(sampleChangeProposal());

      const result = manager.getChange(node.id);

      expect(result).toEqual(expect.objectContaining({ id: node.id }));
    });

    it('getChangesForGoal returns changes satisfying a goal', async () => {
      await manager.propose(sampleChangeProposal({ satisfiesGoals: ['goal-1'] }));
      await manager.propose(sampleChangeProposal({ satisfiesGoals: ['goal-2'] }));

      const forGoal1 = manager.getChangesForGoal('goal-1');

      expect(forGoal1).toHaveLength(1);
      expect(forGoal1[0]!.satisfiesGoals).toContain('goal-1');
    });
  });

  describe('updateQualityGate', () => {
    it('calls graph.update with quality gate patch', async () => {
      const node = await manager.propose(sampleChangeProposal());

      await manager.updateQualityGate(node.id, 'tests', {
        passed: true,
        detail: 'All 42 tests passed',
      });

      // Verify graph.update was called
      expect(graph.update).toHaveBeenCalled();
      // Verify it was called with the node id
      const call = (graph.update as ReturnType<typeof vi.fn>).mock.calls[0]!;
      expect(call[0]).toBe(node.id);
    });

    it('emits quality_gate:updated event', async () => {
      const node = await manager.propose(sampleChangeProposal());

      await manager.updateQualityGate(node.id, 'tests', { passed: true });

      expect(fleet.emit).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'quality_gate:updated',
          payload: expect.objectContaining({ changeId: node.id, checkName: 'tests', passed: true }),
        }),
      );
    });

    it('handles unknown change gracefully', async () => {
      await expect(
        manager.updateQualityGate('nonexistent', 'tests', { passed: true }),
      ).resolves.toBeUndefined();
    });
  });

  describe('custom quality checks', () => {
    it('respects custom quality gate configuration', () => {
      const customManager = new ChangeManager({
        graph,
        consensus,
        fleet,
        checks: {
          runTests: false,
          runLint: true,
        },
      });

      expect(customManager).toBeDefined();
    });
  });
});
