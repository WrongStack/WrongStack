import { describe, expect, it, vi, beforeEach } from 'vitest';
import { ConsensusProtocol, type VoterConfig } from '../../src/coordination/consensus-protocol.js';
import type { ChangeNode, KnowledgeGraph } from '../../src/coordination/knowledge-graph.js';
import type { FleetBus } from '../../src/coordination/fleet-bus.js';

// ── Mock KnowledgeGraph ───────────────────────────────────────────────────────

function createMockGraph(): KnowledgeGraph {
  const nodes = new Map<string, ChangeNode>();

  return {
    add: vi.fn(async (data) => {
      const id = `change_${nodes.size + 1}`;
      const node: ChangeNode = {
        id,
        type: 'change',
        title: (data as { title?: string }).title ?? 'Untitled',
        description: (data as { description?: string }).description ?? '',
        files: (data as { files?: unknown[] }).files ?? [],
        status: (data as { status?: string }).status ?? 'proposed',
        proposedBy: (data as { proposedBy?: string }).proposedBy ?? '',
        proposedAt: new Date().toISOString(),
        approvedBy: [],
        rejectedBy: [],
        votes: [],
        qualityGate: { passed: false, checks: [] },
        satisfiesGoals: [],
      } as ChangeNode;
      nodes.set(id, node);
      return node;
    }),
    get: vi.fn((id: string) => nodes.get(id)),
    update: vi.fn(async (id: string, patch: Record<string, unknown>) => {
      const node = nodes.get(id);
      if (!node) return null;
      Object.assign(node, patch);
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

function createChangeNode(
  graph: KnowledgeGraph,
  id: string,
  overrides: Partial<ChangeNode> = {},
): ChangeNode {
  const node: ChangeNode = {
    id,
    type: 'change',
    title: `Change ${id}`,
    description: 'Test change',
    files: [],
    status: 'proposed',
    proposedBy: 'test-agent',
    proposedAt: new Date().toISOString(),
    approvedBy: [],
    rejectedBy: [],
    votes: [],
    qualityGate: { passed: false, checks: [] },
    satisfiesGoals: [],
    ...overrides,
  };
  graph.get = (graphId: string) => (graphId === id ? node : undefined);
  return node;
}

// ── Mock FleetBus ─────────────────────────────────────────────────────────────

function createMockFleetBus(): FleetBus {
  return {
    emit: vi.fn(),
    subscribe: vi.fn(() => () => {}),
    unsubscribe: vi.fn(),
    dispose: vi.fn(),
  } as never as FleetBus;
}

// ── Default voters ───────────────────────────────────────────────────────────

function defaultVoters(): VoterConfig[] {
  return [
    { agentId: 'voter-1', agentName: 'Alice', role: 'reviewer', weight: 1 },
    { agentId: 'voter-2', agentName: 'Bob', role: 'reviewer', weight: 1 },
    { agentId: 'voter-3', agentName: 'Carol', role: 'senior-reviewer', weight: 2 },
  ];
}

describe('ConsensusProtocol', () => {
  let graph: KnowledgeGraph;
  let fleet: FleetBus;

  beforeEach(() => {
    graph = createMockGraph();
    fleet = createMockFleetBus();
  });

  describe('initiateVote', () => {
    it('updates change status to proposed', async () => {
      const protocol = new ConsensusProtocol({
        voters: defaultVoters(),
        graph,
      });
      createChangeNode(graph, 'change-1');

      await protocol.initiateVote('change-1');

      expect(graph.update).toHaveBeenCalledWith(
        'change-1',
        expect.objectContaining({ status: 'proposed', votes: [] }),
      );
    });

    it('throws for unknown change', async () => {
      const protocol = new ConsensusProtocol({ voters: [], graph });

      await expect(protocol.initiateVote('nonexistent')).rejects.toThrow(/no change found/);
    });

    it('emits vote_initiated via fleet bus', async () => {
      const protocol = new ConsensusProtocol({ voters: defaultVoters(), graph, fleet });
      createChangeNode(graph, 'change-1');

      await protocol.initiateVote('change-1');

      expect(fleet.emit).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'consensus:vote_initiated',
          payload: expect.objectContaining({ changeId: 'change-1' }),
        }),
      );
    });
  });

  describe('castVote', () => {
    it('records approve vote and returns pending if quorum not met', async () => {
      const protocol = new ConsensusProtocol({
        voters: defaultVoters(),
        graph,
        rules: { quorumFraction: 1, approvalFraction: 0.5, vetoRoles: [] }, // need all voters
      });
      createChangeNode(graph, 'change-1');

      const result = await protocol.castVote('change-1', 'voter-1', 'approve', 'Looks good');

      expect(result.outcome).toBe('quorum_not_met');
      expect(result.approveCount).toBe(1);
      expect(graph.update).toHaveBeenCalledWith(
        'change-1',
        expect.objectContaining({
          votes: expect.arrayContaining([
            expect.objectContaining({
              agentId: 'voter-1',
              value: 'approve',
              rationale: 'Looks good',
            }),
          ]),
        }),
      );
    });

    it('records reject vote', async () => {
      const protocol = new ConsensusProtocol({ voters: defaultVoters(), graph });
      createChangeNode(graph, 'change-1');

      const result = await protocol.castVote('change-1', 'voter-1', 'reject', 'Too risky');

      expect(result.rejectCount).toBe(1);
      expect(result.approveCount).toBe(0);
    });

    it('records abstain vote', async () => {
      const protocol = new ConsensusProtocol({ voters: defaultVoters(), graph });
      createChangeNode(graph, 'change-1');

      const result = await protocol.castVote('change-1', 'voter-1', 'abstain');

      expect(result.abstainCount).toBe(1);
    });

    it('throws for unknown voter', async () => {
      const protocol = new ConsensusProtocol({ voters: [], graph });
      createChangeNode(graph, 'change-1');

      await expect(protocol.castVote('change-1', 'unknown', 'approve')).rejects.toThrow(
        /unknown voter "unknown"/,
      );
    });

    it('throws for non-change node', async () => {
      const protocol = new ConsensusProtocol({ voters: defaultVoters(), graph });

      await expect(protocol.castVote('not-a-change', 'voter-1', 'approve')).rejects.toThrow();
    });

    it('allows voter to change their vote', async () => {
      const protocol = new ConsensusProtocol({ voters: defaultVoters(), graph });
      createChangeNode(graph, 'change-1', {
        votes: [{ agentId: 'voter-1', agentName: 'Alice', value: 'approve', votedAt: '' }],
      });

      await protocol.castVote('change-1', 'voter-1', 'reject', 'Changed my mind');

      // Should have exactly one vote (updated, not added)
      expect(graph.update).toHaveBeenCalledWith(
        'change-1',
        expect.objectContaining({
          votes: expect.arrayContaining([
            expect.objectContaining({ agentId: 'voter-1', value: 'reject' }),
          ]),
        }),
      );
      expect((graph.update as ReturnType<typeof vi.fn>).mock.calls[0]![1]!.votes).toHaveLength(1);
    });

    it('calls graph.update when casting a vote', async () => {
      const protocol = new ConsensusProtocol({
        voters: defaultVoters(),
        graph,
        rules: { quorumFraction: 0.5, approvalFraction: 0.6, vetoRoles: [] },
      });
      createChangeNode(graph, 'change-1');

      await protocol.castVote('change-1', 'voter-1', 'approve');

      // Verify graph.update was called with vote data
      expect(graph.update).toHaveBeenCalled();
      const call = (graph.update as ReturnType<typeof vi.fn>).mock.calls[0]!;
      expect(call[0]).toBe('change-1');
      expect(call[1]).toHaveProperty('votes');
    });

    it('returns pending when only some voters have voted', async () => {
      const protocol = new ConsensusProtocol({
        voters: defaultVoters(),
        graph,
        rules: { quorumFraction: 1, approvalFraction: 0.5, vetoRoles: [] },
      });
      createChangeNode(graph, 'change-1');

      const result = await protocol.castVote('change-1', 'voter-1', 'approve');

      // With quorumFraction=1, need all voters
      expect(result.outcome).toBe('quorum_not_met');
      expect(result.quorumMet).toBe(false);
    });

    it('handles veto from veto-role voter', async () => {
      const protocol = new ConsensusProtocol({
        voters: [
          { agentId: 'voter-1', agentName: 'Alice', role: 'security', weight: 1, veto: true },
          { agentId: 'voter-2', agentName: 'Bob', role: 'reviewer', weight: 1 },
        ],
        graph,
        rules: { quorumFraction: 0.5, approvalFraction: 0.5, vetoRoles: ['security'] },
      });
      createChangeNode(graph, 'change-1');

      const result = await protocol.castVote('change-1', 'voter-1', 'reject');

      expect(result.outcome).toBe('vetoed');
      expect(result.vetoedBy).toBe('voter-1');
    });
  });

  describe('weight-based voting', () => {
    it('records votes with different weights', async () => {
      const protocol = new ConsensusProtocol({
        voters: [
          { agentId: 'voter-1', agentName: 'Alice', role: 'reviewer', weight: 1 },
          { agentId: 'voter-2', agentName: 'Bob', role: 'senior', weight: 3 },
        ],
        graph,
        rules: {
          quorumFraction: 0.5,
          approvalFraction: 0.5,
          vetoRoles: [],
          approvalWeightFraction: 0.6,
        },
      });
      createChangeNode(graph, 'change-1');

      const result = await protocol.castVote('change-1', 'voter-1', 'approve');

      // Should return vote result with weight info
      expect(result).toBeDefined();
      expect(result.eligibleVoters).toContain('voter-1');
      expect(result.eligibleVoters).toContain('voter-2');
    });

    it('calls graph.update with weight information', async () => {
      const protocol = new ConsensusProtocol({
        voters: [{ agentId: 'voter-1', agentName: 'Alice', role: 'reviewer', weight: 2 }],
        graph,
        rules: { quorumFraction: 0.5, approvalFraction: 0.5, vetoRoles: [] },
      });
      createChangeNode(graph, 'change-1');

      await protocol.castVote('change-1', 'voter-1', 'approve');

      // Verify graph.update was called
      expect(graph.update).toHaveBeenCalled();
    });

    it('passes when heavy proposer is excluded from totalWeight denominator (BIZ-006)', async () => {
      const protocol = new ConsensusProtocol({
        voters: [
          { agentId: 'proposer', agentName: 'Heavy Proposer', role: 'architect', weight: 10 },
          { agentId: 'voter-1', agentName: 'Alice', role: 'reviewer', weight: 1 },
          { agentId: 'voter-2', agentName: 'Bob', role: 'reviewer', weight: 1 },
        ],
        graph,
        rules: {
          quorumFraction: 0.5,
          approvalFraction: 0.5,
          vetoRoles: [],
          approvalWeightFraction: 0.5,
        },
      });
      createChangeNode(graph, 'change-heavy', { proposedBy: 'proposer' });

      await protocol.castVote('change-heavy', 'voter-1', 'approve');
      const res = await protocol.castVote('change-heavy', 'voter-2', 'approve');

      expect(res.outcome).toBe('approved');
      expect(res.approvalMet).toBe(true);
    });

    it('refuses late votes on already-resolved changes (BIZ-007)', async () => {
      const protocol = new ConsensusProtocol({
        voters: [
          { agentId: 'voter-1', agentName: 'Alice', role: 'reviewer', weight: 1 },
          { agentId: 'voter-2', agentName: 'Bob', role: 'reviewer', weight: 1 },
        ],
        graph,
        rules: { quorumFraction: 0.5, approvalFraction: 0.5, vetoRoles: [] },
      });
      createChangeNode(graph, 'change-closed', { status: 'approved' });

      await expect(protocol.castVote('change-closed', 'voter-1', 'reject')).rejects.toThrow(
        /ballot is closed/,
      );
      await expect(protocol.initiateVote('change-closed')).rejects.toThrow(/already resolved/);
    });
  });

  describe('resolveNow', () => {
    it('returns consensus result for a change with votes', async () => {
      const protocol = new ConsensusProtocol({
        voters: defaultVoters(),
        graph,
        rules: { quorumFraction: 1, approvalFraction: 0.5, vetoRoles: [] },
      });
      createChangeNode(graph, 'change-1', {
        votes: [
          { agentId: 'voter-1', agentName: 'Alice', value: 'approve', votedAt: '' },
          { agentId: 'voter-2', agentName: 'Bob', value: 'approve', votedAt: '' },
        ],
      });

      const result = await protocol.resolveNow('change-1');

      // Should return a result object
      expect(result).toBeDefined();
      expect(result).toHaveProperty('outcome');
      expect(result).toHaveProperty('approveCount');
      expect(result).toHaveProperty('rejectCount');
    });

    it('throws for unknown change', async () => {
      const protocol = new ConsensusProtocol({ voters: [], graph });

      await expect(protocol.resolveNow('nonexistent')).rejects.toThrow();
    });
  });

  describe('getStatus', () => {
    it('returns current vote status', () => {
      const protocol = new ConsensusProtocol({
        voters: defaultVoters(),
        graph,
        rules: { quorumFraction: 0.5, approvalFraction: 0.5, vetoRoles: [] },
      });
      createChangeNode(graph, 'change-1', {
        votes: [{ agentId: 'voter-1', agentName: 'Alice', value: 'approve', votedAt: '' }],
      });

      const status = protocol.getStatus('change-1');

      expect(status).not.toBeNull();
      expect(status!.approveCount).toBe(1);
    });

    it('returns null for non-change node', () => {
      const protocol = new ConsensusProtocol({ voters: [], graph });

      expect(protocol.getStatus('nonexistent')).toBeNull();
    });
  });

  describe('registerVoter', () => {
    it('adds a new voter', async () => {
      const protocol = new ConsensusProtocol({ voters: [], graph });
      createChangeNode(graph, 'change-1');

      protocol.registerVoter({
        agentId: 'new-voter',
        agentName: 'Dave',
        role: 'reviewer',
        weight: 1,
      });
      const result = await protocol.castVote('change-1', 'new-voter', 'approve');

      expect(result.eligibleVoters).toContain('new-voter');
    });
  });

  describe('quorum calculation', () => {
    it('requires minimum voters based on quorum fraction', async () => {
      const protocol = new ConsensusProtocol({
        voters: [
          { agentId: 'v1', agentName: 'V1', role: 'r', weight: 1 },
          { agentId: 'v2', agentName: 'V2', role: 'r', weight: 1 },
          { agentId: 'v3', agentName: 'V3', role: 'r', weight: 1 },
          { agentId: 'v4', agentName: 'V4', role: 'r', weight: 1 },
        ],
        graph,
        rules: { quorumFraction: 0.75, approvalFraction: 0.5, vetoRoles: [] }, // need 3 of 4
      });
      createChangeNode(graph, 'change-1');

      // Only 2 votes
      await protocol.castVote('change-1', 'v1', 'approve');
      const result = await protocol.castVote('change-1', 'v2', 'approve');

      expect(result.outcome).toBe('quorum_not_met');
      expect(result.quorumMet).toBe(false);
    });
  });
});
