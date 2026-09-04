import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  AutonomousBrain,
  type AutonomousDecisionRequest,
} from '../../src/coordination/autonomous-brain.js';
import type { FleetBus } from '../../src/coordination/fleet-bus.js';
import type {
  ChangeNode,
  DecisionNode,
  FactNode,
  GoalNode,
  KnowledgeGraph,
} from '../../src/coordination/knowledge-graph.js';

// ── Mock helpers ──────────────────────────────────────────────────────────────

function createMockGraph(): KnowledgeGraph {
  return {
    getFacts: vi.fn(() => [] as FactNode[]),
    getGoals: vi.fn(() => [] as GoalNode[]),
    getOpenGoals: vi.fn(() => [] as GoalNode[]),
    getChanges: vi.fn(() => []),
    getDecisions: vi.fn(() => [] as DecisionNode[]),
    get: vi.fn(() => undefined),
    add: vi.fn(async (data: Record<string, unknown>) => {
      const id = `node_${Math.random().toString(36).slice(2)}`;
      return { id, ...data } as DecisionNode;
    }),
    update: vi.fn(async (id: string, patch: Record<string, unknown>) => ({
      id,
      ...patch,
    })),
    subscribe: vi.fn(() => () => {}),
    dispose: vi.fn(),
  } as never as KnowledgeGraph;
}

function createMockFleetBus(): FleetBus {
  return {
    emit: vi.fn(),
    filter: vi.fn(() => vi.fn()),
    subscribe: vi.fn(() => () => {}),
    unsubscribe: vi.fn(),
    dispose: vi.fn(),
  } as never as FleetBus;
}

// Mock LLM provider
function createMockLlmProvider(decision: { optionId: string; rationale: string }) {
  return {
    decide: vi.fn(async () => decision),
  };
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('AutonomousBrain', () => {
  let graph: KnowledgeGraph;
  let fleet: FleetBus;

  beforeEach(() => {
    graph = createMockGraph();
    fleet = createMockFleetBus();
  });

  describe('constructor', () => {
    it('initializes with options', () => {
      const llm = createMockLlmProvider({ optionId: 'yes', rationale: 'test' });
      const brain = new AutonomousBrain({
        llmProvider: llm,
        graph,
        fleet,
        maxRetries: 5,
        consensusRiskThreshold: 'critical',
        selfImprove: false,
      });

      expect(brain).toBeDefined();
    });

    it('uses default values when options not provided', () => {
      const llm = createMockLlmProvider({ optionId: 'yes', rationale: 'test' });
      const brain = new AutonomousBrain({
        llmProvider: llm,
        graph,
      });

      expect(brain).toBeDefined();
    });
  });

  describe('decide (BrainArbiter interface)', () => {
    it('makes a decision via the LLM', async () => {
      const llm = createMockLlmProvider({ optionId: 'spawn:bug-hunter', rationale: 'Good fit' });
      const brain = new AutonomousBrain({ llmProvider: llm, graph, fleet });

      const result = await brain.decide({
        id: 'req-1',
        source: 'system',
        question: 'Should we spawn an agent?',
        options: [
          { id: 'spawn:bug-hunter', label: 'Spawn bug-hunter', risk: 'low', recommended: true },
          { id: 'defer', label: 'Defer', risk: 'low', recommended: false },
        ],
        context: '',
        risk: 'low',
        fallback: 'deny',
      });

      expect(result.type).toBe('answer');
      expect(result.optionId).toBe('spawn:bug-hunter');
      expect(llm.decide).toHaveBeenCalled();
    });

    it('returns deny when LLM fails and risk is not low', async () => {
      const llm = {
        decide: vi.fn(async () => {
          throw new Error('LLM unavailable');
        }),
      };
      const brain = new AutonomousBrain({ llmProvider: llm, graph, fleet });

      const result = await brain.decide({
        id: 'req-1',
        source: 'system',
        question: 'Should we spawn?',
        options: [{ id: 'yes', label: 'Yes', risk: 'medium', recommended: true }],
        context: '',
        risk: 'medium',
        fallback: 'deny',
      });

      expect(result.type).toBe('deny');
    });

    it('falls back to recommended option when LLM fails and risk is low', async () => {
      const llm = {
        decide: vi.fn(async () => {
          throw new Error('LLM unavailable');
        }),
      };
      const brain = new AutonomousBrain({ llmProvider: llm, graph, fleet });

      const result = await brain.decide({
        id: 'req-1',
        source: 'system',
        question: 'Should we spawn?',
        options: [{ id: 'yes', label: 'Yes', risk: 'low', recommended: true }],
        context: '',
        risk: 'low',
        fallback: 'deny',
      });

      expect(result.type).toBe('answer');
      expect(result.optionId).toBe('yes');
    });

    it('emits decision event via fleet bus', async () => {
      const llm = createMockLlmProvider({ optionId: 'yes', rationale: 'Test' });
      const brain = new AutonomousBrain({ llmProvider: llm, graph, fleet });

      await brain.decide({
        id: 'req-1',
        source: 'system',
        question: 'Test',
        options: [{ id: 'yes', label: 'Yes', risk: 'low', recommended: true }],
        context: '',
        risk: 'low',
        fallback: 'deny',
      });

      expect(fleet.emit).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'brain.decision',
          payload: expect.objectContaining({
            optionId: 'yes',
          }),
        }),
      );
    });
  });

  describe('decideAuto (autonomous entry point)', () => {
    it('processes autonomous decision request', async () => {
      const llm = createMockLlmProvider({ optionId: 'retry', rationale: 'Worth retrying' });
      const brain = new AutonomousBrain({ llmProvider: llm, graph, fleet });

      const result = await brain.decideAuto({
        id: 'auto-1',
        source: 'system',
        decisionType: 'retry_task',
        question: 'Should we retry this task?',
        context: {
          taskDescription: 'Fix bug',
          attempts: 1,
        },
        options: [
          { id: 'retry', label: 'Retry', risk: 'low', recommended: true },
          { id: 'fail', label: 'Mark failed', risk: 'medium', recommended: false },
        ],
        risk: 'low',
        requiresConsensus: false,
      });

      expect(result.type).toBe('answer');
      expect(result.optionId).toBe('retry');
    });

    const consensusRequest = {
      id: 'auto-1',
      source: 'system' as const,
      decisionType: 'approve_change',
      question: 'Should we approve this change?',
      context: {},
      options: [{ id: 'approve', label: 'Approve', risk: 'high' as const, recommended: true }],
      risk: 'high' as const,
      requiresConsensus: true,
    } satisfies AutonomousDecisionRequest;

    it('escalates a consensus-required decision when nothing can approve it', async () => {
      const llm = createMockLlmProvider({ optionId: 'approve', rationale: 'Safe change' });
      const brain = new AutonomousBrain({ llmProvider: llm, graph, fleet });

      const result = await brain.decideAuto(consensusRequest);

      // It used to return a plain `answer` with a warning appended to the
      // PROSE rationale. Consumers act on the exact optionId and never read
      // prose, so the decision executed unapproved and
      // `consensusRiskThreshold` was inert.
      expect(result.type).toBe('ask_human');
      if (result.type === 'ask_human') {
        expect(result.prompt).toContain('Consensus required');
        expect(result.prompt).toContain('Approve');
        // The offered options travel with the escalation so a human — or the
        // headless terminal policy — decides on the real proposal.
        expect(result.options).toHaveLength(1);
      }
    });

    it('answers with the chosen option once consensus approves it', async () => {
      const llm = createMockLlmProvider({ optionId: 'approve', rationale: 'Safe change' });
      const brain = new AutonomousBrain({
        llmProvider: llm,
        graph,
        fleet,
        consensus: async () => true,
      });

      const result = await brain.decideAuto(consensusRequest);

      expect(result).toMatchObject({ type: 'answer', optionId: 'approve' });
    });

    it('denies when consensus rejects the proposal', async () => {
      const llm = createMockLlmProvider({ optionId: 'approve', rationale: 'Safe change' });
      const brain = new AutonomousBrain({
        llmProvider: llm,
        graph,
        fleet,
        consensus: async () => false,
      });

      const result = await brain.decideAuto(consensusRequest);

      expect(result.type).toBe('deny');
    });

    it('treats a failing consensus resolver as a rejection', async () => {
      const llm = createMockLlmProvider({ optionId: 'approve', rationale: 'Safe change' });
      const brain = new AutonomousBrain({
        llmProvider: llm,
        graph,
        fleet,
        consensus: async () => {
          throw new Error('vote timed out');
        },
      });

      const result = await brain.decideAuto(consensusRequest);

      expect(result.type).toBe('deny');
    });
  });

  describe('decideSpawn', () => {
    it('generates spawn decision', async () => {
      const llm = createMockLlmProvider({
        optionId: 'spawn:bug-hunter',
        rationale: 'Bug fix needed',
      });
      const brain = new AutonomousBrain({ llmProvider: llm, graph, fleet });

      const result = await brain.decideSpawn(
        'system',
        'Fix the null pointer exception in auth/session.ts',
        [],
        { running: 1, idle: 2, total: 3, costSoFar: 0.1 },
      );

      expect(result.type).toBe('answer');
      expect(result.optionId).toMatch(/^spawn:/);
    });
  });

  describe('decideApproval', () => {
    it('approves safe changes', async () => {
      const llm = createMockLlmProvider({ optionId: 'approve', rationale: 'Low risk' });
      const brain = new AutonomousBrain({ llmProvider: llm, graph, fleet });

      const change: ChangeNode = {
        id: 'change-1',
        type: 'change',
        title: 'Add tests',
        description: 'Add unit tests',
        files: [{ path: 'src/test.ts', action: 'create' }],
        status: 'proposed',
        proposedBy: 'agent-1',
        proposedAt: new Date().toISOString(),
        approvedBy: [],
        rejectedBy: [],
        votes: [],
        qualityGate: { passed: true, checks: [] },
        satisfiesGoals: [],
      };

      const result = await brain.decideApproval('system', change, []);

      expect(result.type).toBe('answer');
      expect(result.optionId).toBe('approve');
    });
  });

  describe('decideEscalation', () => {
    it('handles escalation decisions', async () => {
      const llm = createMockLlmProvider({ optionId: 'retry', rationale: 'Worth another try' });
      const brain = new AutonomousBrain({ llmProvider: llm, graph, fleet });

      const result = await brain.decideEscalation('system', 'task-1', 'Timeout error', 2);

      expect(result.type).toBe('answer');
    });

    it('recommends mark_failed after max retries', async () => {
      const llm = createMockLlmProvider({
        optionId: 'mark_failed',
        rationale: 'Max retries reached',
      });
      const brain = new AutonomousBrain({ llmProvider: llm, graph, fleet, maxRetries: 3 });

      // Simulate that we've already retried 3 times
      brain.recordOutcome('decision-id', 'failure');

      const result = await brain.decideEscalation('system', 'task-1', 'Timeout error', 3);

      expect(result.type).toBe('answer');
    });
  });

  describe('recordOutcome', () => {
    it('records success outcome', () => {
      const llm = createMockLlmProvider({ optionId: 'yes', rationale: 'Test' });
      const brain = new AutonomousBrain({ llmProvider: llm, graph, fleet });

      // Should not throw
      brain.recordOutcome('decision-1', 'success');
    });

    it('records failure outcome', () => {
      const llm = createMockLlmProvider({ optionId: 'yes', rationale: 'Test' });
      const brain = new AutonomousBrain({ llmProvider: llm, graph, fleet });

      // Should not throw
      brain.recordOutcome('decision-1', 'failure');
    });
  });
});
