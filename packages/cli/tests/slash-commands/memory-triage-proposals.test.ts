/**
 * Integration test for the /memory triage --apply proposal round-trip.
 *
 * Verifies that when /memory triage --apply runs against a corpus that
 * produces archive proposals, every proposal is filed via
 * Sage.createCandidate with the correct MemoryCandidate shape.
 *
 * The round-trip path is:
 *   1. runTriage(memories, mockLlm) → TriageReport with proposals
 *   2. fileProposals(Sage, proposals) → submits CreateCandidateInput
 *   3. /memory candidates → listCandidates() should return the proposals
 */

import { describe, expect, it } from 'vitest';
import type { SageSurface, MemoryCandidate, CreateCandidateInput } from '@wrongstack/sage';
import { runTriage } from '@wrongstack/sage';
import { fileProposals as internFileProposals } from '../../src/slash-commands/memory-triage.js';

// ── Mock Sage surface ─────────────────────────────────────────

interface MockSageOptions {
  /** Make createCandidate reject after this many calls (0 = never). */
  failAfter?: number;
  /** Make createCandidate reject for specific memoryIds. */
  failFor?: Set<string>;
  /** Make createCandidate throw a specific error. */
  errorToThrow?: Error;
}

function makeMockSage(options: MockSageOptions = {}) {
  const candidates = new Map<string, MemoryCandidate>();
  const callLog: Array<{ input: CreateCandidateInput; atCallNumber: number }> = [];
  let callCount = 0;

  // Only the two members `fileProposals` and these tests exercise. Keeping the
  // seam typed as `Partial<SageSurface>` still checks both signatures against
  // the real contract; the cast covers the members nothing here calls.
  const partial: Partial<SageSurface> = {
    listCandidates: async (includeResolved?: boolean) => {
      const all = [...candidates.values()];
      return includeResolved ? all : all.filter((c) => c.status === 'pending');
    },
    createCandidate: async (input: CreateCandidateInput) => {
      callCount++;
      if (options.failAfter && callCount > options.failAfter) {
        throw options.errorToThrow ?? new Error('mock createCandidate failure');
      }
      if (options.failFor?.has(input.targetMemoryId ?? '')) {
        throw options.errorToThrow ?? new Error(
          `mock createCandidate failure for ${input.targetMemoryId}`,
        );
      }
      // Mirrors `createSqliteCandidate`'s defaulting so the mock cannot drift
      // from the shape the real store persists.
      const candidate: MemoryCandidate = {
        schemaVersion: 1,
        id: `cand_${callCount}`,
        status: 'pending',
        text: input.text,
        kind: input.kind ?? 'fact',
        scope: input.scope ?? 'project',
        confidence: input.confidence ?? 0.6,
        importance: input.importance ?? 0.6,
        tags: input.tags ?? [],
        anchors: input.anchors ?? [],
        sources: input.sources ?? [{ type: 'session' }],
        createdAt: '2026-08-04T12:00:00.000Z',
        updatedAt: '2026-08-04T12:00:00.000Z',
        memoryId: input.targetMemoryId,
        reason: input.reviewReason,
        ...(input.targetMemoryId ? { targetMemoryId: input.targetMemoryId } : {}),
        ...(input.suggestedAction ? { suggestedAction: input.suggestedAction } : {}),
      };
      candidates.set(candidate.id, candidate);
      callLog.push({ input, atCallNumber: callCount });
      return candidate;
    },
  };
  const mock = partial as SageSurface;
  return {
    mock,
    candidates,
    callLog,
    get callCount() {
      return callCount;
    },
  };
}

// ── Sample memories + mock LLM ─────────────────────────────────

const SAMPLE_MEMORIES = [
  // High-importance — should be kept by Phase 1
  {
    id: 'm_kept_1',
    revision: 1,
    scope: 'project' as const,
    kind: 'decision' as const,
    status: 'active' as const,
    persistence: 'permanent' as const,
    text: 'Home-directory startup guard refuses wstack boot when cwd is os.homedir.',
    importance: 0.85,
    confidence: 1,
    freshness: 1,
    tags: ['boot', 'safety'],
    anchors: [{ type: 'file' as const, path: 'packages/cli/src/boot.ts' }],
    sources: [{ type: 'user' as const }],
    createdAt: '2026-07-20T00:00:00.000Z',
    updatedAt: '2026-07-20T00:00:00.000Z',
  },
  // Mid-importance — should be uncertain, then gray
  // Tuned to land in the gray zone (30-69) by Phase 2 scoring:
  //   textScore ~21, anchorScore 5, confidenceScore 0.8*15=12, total ~38
  {
    id: 'm_gray_1',
    revision: 1,
    scope: 'project' as const,
    kind: 'fact' as const,
    status: 'active' as const,
    persistence: 'long_lived' as const,
    text: 'SAGE injects 5+ SAGE-block paragraphs on tool result after read/grep/edit/write.',
    importance: 0.55,
    confidence: 0.5,
    freshness: 1,
    tags: ['sage', 'injection'],
    anchors: [{ type: 'file' as const, path: 'packages/sage/src/middleware/tool-call-memory.ts' }],
    sources: [{ type: 'user' as const }],
    createdAt: '2026-07-25T00:00:00.000Z',
    updatedAt: '2026-07-25T00:00:00.000Z',
  },
  // Discardable — transient pattern
  {
    id: 'm_discard_1',
    revision: 1,
    scope: 'project' as const,
    kind: 'summary' as const,
    status: 'active' as const,
    persistence: 'long_lived' as const,
    text: 'WIP: fix the auth module',
    importance: 0.3,
    confidence: 0.2,
    freshness: 1,
    tags: [],
    anchors: [],
    sources: [{ type: 'user' as const }],
    createdAt: '2026-07-15T00:00:00.000Z',
    updatedAt: '2026-07-15T00:00:00.000Z',
  },
];

// ── Tests ───────────────────────────────────────────────────────

describe('memory triage proposal round-trip', () => {
  it('runs triage and produces consistent proposal contracts', async () => {
    // Mock LLM that rates m_gray_1 as transient (LLM=2) → produces archive proposal
    const mockLlm = async (system: string) => {
      if (system.includes('SCORE')) {
        return '2 | Transient, low confidence';
      }
      if (system.includes('YES | NO | OVERLAP')) {
        return 'NO';
      }
      return '3';
    };

    const report = await runTriage(SAMPLE_MEMORIES, mockLlm, {
      dryRun: true,
      maxPhase3Calls: 10,
      maxPhase4Pairs: 5,
    });

    // The triage pipeline should produce at least one proposal for the mid-importance gray-zone memory
    expect(report.dispatch.proposals.length).toBeGreaterThan(0);

    // Every proposal must have the required shape
    for (const proposal of report.dispatch.proposals) {
      expect(proposal.memoryId).toBeTruthy();
      expect(proposal.memoryText.length).toBeGreaterThan(0);
      expect(['archive', 'investigate', 'delete']).toContain(proposal.suggestedAction);
      expect(proposal.reason.length).toBeGreaterThan(0);
    }
  });

  it('fileProposals submits correct CreateCandidateInput shape', async () => {
    const mockLlm = async (system: string) => {
      if (system.includes('SCORE')) return '2 | Transient';
      if (system.includes('YES | NO | OVERLAP')) return 'NO';
      return '3';
    };

    const report = await runTriage(SAMPLE_MEMORIES, mockLlm, {
      dryRun: true,
      maxPhase3Calls: 10,
      maxPhase4Pairs: 5,
    });

    const mockHandle = makeMockSage();
    const result = await internFileProposals(mockHandle.mock, report.dispatch.proposals);

    expect(result.total).toBe(report.dispatch.proposals.length);
    expect(result.filed).toBe(report.dispatch.proposals.length);
    expect(result.failed).toBe(0);
    expect(result.failures).toEqual([]);
    expect(mockHandle.callCount).toBe(report.dispatch.proposals.length);

    // Every submitted input must conform to the CreateCandidateInput contract
    for (const input of result.inputs) {
      expect(input.kind).toBe('memory_review');
      expect(input.scope).toBe('project');
      expect(input.importance).toBe(0.5);
      expect(input.confidence).toBe(0.9);
      expect(input.tags).toEqual(['triage']);
      expect(input.anchors).toEqual([]);
      expect(input.sources).toHaveLength(1);
      expect(input.sources?.[0]?.type).toBe('project_instruction');
      expect(input.targetMemoryId).toBeTruthy();
      expect(input.reviewReason).toBeTruthy();
      expect(input.suggestedAction).toBeTruthy();
    }

    // Round-trip: every candidate must be retrievable via listCandidates
    const listed = await mockHandle.mock.listCandidates();
    expect(listed).toHaveLength(report.dispatch.proposals.length);

    // Each listed candidate must have the same memoryId as the original proposal
    const proposalMemoryIds = new Set(report.dispatch.proposals.map((p) => p.memoryId));
    const listedMemoryIds = new Set(listed.map((c) => c.memoryId).filter(Boolean));
    expect(proposalMemoryIds).toEqual(listedMemoryIds);

    // The candidates store should hold exactly one entry per proposal
    expect(mockHandle.candidates.size).toBe(report.dispatch.proposals.length);
  });

  it('survives partial failures — some proposals succeed, others fail', async () => {
    const mockLlm = async (system: string) => {
      if (system.includes('SCORE')) return '2 | Transient';
      if (system.includes('YES | NO | OVERLAP')) return 'NO';
      return '3';
    };

    const report = await runTriage(SAMPLE_MEMORIES, mockLlm, {
      dryRun: true,
      maxPhase3Calls: 10,
      maxPhase4Pairs: 5,
    });

    // Make createCandidate fail for the first proposal only
    const failFor = new Set<string>([report.dispatch.proposals[0]!.memoryId]);
    const mockHandle = makeMockSage({ failFor });
    const result = await internFileProposals(mockHandle.mock, report.dispatch.proposals);

    expect(result.total).toBe(report.dispatch.proposals.length);
    expect(result.filed).toBe(report.dispatch.proposals.length - 1);
    expect(result.failed).toBe(1);
    expect(result.failures).toHaveLength(1);
    expect(result.failures[0]!.memoryId).toBe(report.dispatch.proposals[0]!.memoryId);
    expect(mockHandle.callCount).toBe(report.dispatch.proposals.length);

    // listCandidates should still return the successful ones
    const listed = await mockHandle.mock.listCandidates();
    expect(listed).toHaveLength(report.dispatch.proposals.length - 1);
  });

  it('handles empty proposal list gracefully', async () => {
    const { mock: Sage, callCount } = makeMockSage();
    const result = await internFileProposals(Sage, []);

    expect(result.total).toBe(0);
    expect(result.filed).toBe(0);
    expect(result.failed).toBe(0);
    expect(result.failures).toEqual([]);
    expect(result.inputs).toEqual([]);
    expect(callCount).toBe(0);
  });

  it('preserves the suggestedAction field verbatim from the proposal', async () => {
    // Build a report with one proposal that has `investigate` as the suggestedAction
    const syntheticProposals = [
      {
        memoryId: 'm_test_1',
        memoryText: 'Test memory text for archive proposal.',
        suggestedAction: 'archive' as const,
        reason: 'LLM rated 1 (noise) + det score low → propose archive',
      },
      {
        memoryId: 'm_test_2',
        memoryText: 'Test memory text for investigate proposal.',
        suggestedAction: 'investigate' as const,
        reason: 'LLM rated 1 but importance 1.0 → safety gate: investigate',
      },
    ];

    const { mock: Sage } = makeMockSage();
    const result = await internFileProposals(Sage, syntheticProposals);

    expect(result.filed).toBe(2);
    expect(result.inputs[0]!.suggestedAction).toBe('archive');
    expect(result.inputs[1]!.suggestedAction).toBe('investigate');
    expect(result.inputs[0]!.targetMemoryId).toBe('m_test_1');
    expect(result.inputs[1]!.targetMemoryId).toBe('m_test_2');
  });

  it('produces proposals that surface in `/memory candidates` list', async () => {
    // End-to-end: run real triage → file proposals → list candidates
    const mockLlm = async (system: string) => {
      if (system.includes('SCORE')) return '2 | Transient';
      if (system.includes('YES | NO | OVERLAP')) return 'NO';
      return '3';
    };

    const report = await runTriage(SAMPLE_MEMORIES, mockLlm, {
      dryRun: true,
      maxPhase3Calls: 10,
      maxPhase4Pairs: 5,
    });

    const { mock: Sage } = makeMockSage();
    await internFileProposals(Sage, report.dispatch.proposals);

    // The listCandidates surface must return all filed proposals
    const candidates = await Sage.listCandidates();
    expect(candidates.length).toBe(report.dispatch.proposals.length);

    // Each candidate must have the metadata needed to render in /memory candidates UI
    for (const candidate of candidates) {
      expect(candidate.id).toBeTruthy();
      expect(candidate.kind).toBe('memory_review');
      expect(candidate.text).toBeTruthy();
      expect(candidate.memoryId).toBeTruthy();
      expect(candidate.reason).toBeTruthy();
      expect(candidate.createdAt).toBeTruthy();
    }
  });
});
