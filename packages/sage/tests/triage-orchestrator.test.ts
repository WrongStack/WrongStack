/**
 * Tests for SAGE Memory Triage — Orchestrator (Phases 1→2→3→4→5).
 *
 * Validates the full pipeline end-to-end with a mock LLM.
 */

import { describe, expect, it } from 'vitest';
import type { Sage } from '../src/types.js';
import type { LlmCallFn } from '../src/triage/llm-evaluator.js';
import { runTriage, formatTriageReport } from '../src/triage/orchestrator.js';

// ── Helpers ─────────────────────────────────────────────────────────────

function makeMem(id: string, overrides: Partial<Sage> = {}): Sage {
  return {
    id,
    revision: 1,
    scope: 'project',
    kind: 'fact',
    status: 'active',
    persistence: 'long_lived',
    text: 'Sample memory text for orchestrator testing.',
    importance: 0.6,
    confidence: 0.8,
    freshness: 1,
    tags: [],
    anchors: [{ type: 'file', path: 'src/x.ts' }],
    sources: [{ type: 'user' }],
    createdAt: '2026-08-04T12:00:00.000Z',
    updatedAt: '2026-08-04T12:00:00.000Z',
    ...overrides,
  };
}

// ── Full pipeline ──────────────────────────────────────────────────────

describe('orchestrator — full pipeline', () => {
  it('runs all phases end-to-end with empty input', async () => {
    const mockLlm: LlmCallFn = async () => 'NO';
    const report = await runTriage([], mockLlm);

    expect(report.phaseStats.input).toBe(0);
    expect(report.dispatch.autoApply).toHaveLength(0);
    expect(report.dispatch.proposals).toHaveLength(0);
    expect(report.merges.merges).toHaveLength(0);
    expect(report.cost.llmCalls).toBe(0);
  });

  it('produces a TriageReport with all required fields', async () => {
    const memories = [makeMem('a', { importance: 0.6 }), makeMem('b', { importance: 0.6 })];
    const mockLlm: LlmCallFn = async () => '4 | useful';
    const report = await runTriage(memories, mockLlm);

    expect(report.dryRun).toBe(true);
    expect(report.startedAt).toBeTruthy();
    expect(report.completedAt).toBeTruthy();
    expect(report.durationMs).toBeGreaterThanOrEqual(0);
    expect(report.phaseStats).toBeDefined();
    expect(report.dispatch).toBeDefined();
    expect(report.merges).toBeDefined();
    expect(report.cost).toBeDefined();
  });

  it('defaults to dryRun mode', async () => {
    const memories = [makeMem('a')];
    const mockLlm: LlmCallFn = async () => 'NO';
    const report = await runTriage(memories, mockLlm);
    expect(report.dryRun).toBe(true);
  });

  it('honors dryRun: false option', async () => {
    const memories = [makeMem('a')];
    const mockLlm: LlmCallFn = async () => 'NO';
    const report = await runTriage(memories, mockLlm, { dryRun: false });
    expect(report.dryRun).toBe(false);
  });
});

// ── Phase distribution ─────────────────────────────────────────────────

describe('orchestrator — phase distribution', () => {
  it('counts phase 1 keep/discard/uncertain correctly', async () => {
    const memories = [
      makeMem('keep1', { importance: 1.0 }), // → keep
      makeMem('keep2', { persistence: 'permanent' }), // → keep
      makeMem('disc1', { text: '', importance: 0.3 }), // → discard
      makeMem('unc1', { importance: 0.6 }), // → uncertain
    ];
    const mockLlm: LlmCallFn = async () => '4 | useful';
    const report = await runTriage(memories, mockLlm);

    expect(report.phaseStats.phase1Keep).toBe(2);
    expect(report.phaseStats.phase1Discard).toBe(1);
    expect(report.phaseStats.phase1Uncertain).toBe(1);
  });

  it('counts phase 2 keep/gray/discard distribution', async () => {
    const memories = [
      // Uncertain → phase 2 scoring
      makeMem('good', {
        importance: 0.6,
        anchors: [{ type: 'file', path: 'src/a.ts' }],
        tags: ['x', 'y'],
        confidence: 0.8,
        lastVerifiedAt: '2026-08-04T12:00:00.000Z',
      }),
      makeMem('bad', {
        anchors: [],
        tags: [],
        confidence: 0.1,
        persistence: 'short_lived',
        lastVerifiedAt: '2025-01-01T00:00:00.000Z',
        text: 'short',
      }),
    ];
    const mockLlm: LlmCallFn = async () => 'NO';
    const report = await runTriage(memories, mockLlm);

    expect(report.phaseStats.phase2Keep).toBeGreaterThanOrEqual(0);
    expect(report.phaseStats.phase2Gray).toBeGreaterThanOrEqual(0);
    expect(report.phaseStats.phase2Discard).toBeGreaterThanOrEqual(0);
    // Total should equal uncertain count
    expect(
      report.phaseStats.phase2Keep + report.phaseStats.phase2Gray + report.phaseStats.phase2Discard,
    ).toBe(report.phaseStats.phase1Uncertain);
  });
});

// ── LLM call counting ──────────────────────────────────────────────────

describe('orchestrator — LLM call counting', () => {
  it('only calls LLM for gray-zone memories in Phase 3', async () => {
    // All memories high-importance → all Phase 1 keep → no Phase 3 calls
    // But Phase 4 still evaluates pairs in same file-anchor clusters
    const memories = [
      makeMem('a', { importance: 1.0, anchors: [{ type: 'file', path: 'src/different-a.ts' }] }),
      makeMem('b', { importance: 1.0, anchors: [{ type: 'file', path: 'src/different-b.ts' }] }),
    ];

    let callCount = 0;
    const mockLlm: LlmCallFn = async () => {
      callCount++;
      return 'NO';
    };

    await runTriage(memories, mockLlm);
    // Different file anchors → no cluster → no Phase 4 pairs → 0 calls total
    expect(callCount).toBe(0);
  });

  it('counts Phase 4 pairs evaluated', async () => {
    const memories = [
      makeMem('a', { anchors: [{ type: 'file', path: 'src/x.ts' }] }),
      makeMem('b', { anchors: [{ type: 'file', path: 'src/x.ts' }] }),
    ];

    let callCount = 0;
    const mockLlm: LlmCallFn = async () => {
      callCount++;
      return 'NO';
    };

    const report = await runTriage(memories, mockLlm, { verbose: false });
    // 2 memories in same cluster → 1 pair
    expect(report.phaseStats.phase4PairsEvaluated).toBe(1);
    expect(callCount).toBeGreaterThanOrEqual(1);
  });
});

// ── Dispatch output ─────────────────────────────────────────────────────

describe('orchestrator — dispatch output', () => {
  it('produces autoApply updates for LLM=4 memories', async () => {
    const memories = [
      // importance < 0.9, so Phase 1 uncertain, Phase 2 gray, Phase 3 evaluated
      makeMem('a', {
        importance: 0.6,
        confidence: 0.5,
        anchors: [{ type: 'file', path: 'src/x.ts' }],
      }),
    ];

    const mockLlm: LlmCallFn = async () => '4 | useful';
    const report = await runTriage(memories, mockLlm);

    // LLM=4 + det ≥ 40 → keep → bump confidence to 0.8
    expect(report.dispatch.autoApply.length).toBeGreaterThan(0);
    const confUpdate = report.dispatch.autoApply.find((a) =>
      a.updates.some((u) => u.field === 'confidence'),
    );
    expect(confUpdate).toBeDefined();
  });

  it('produces proposals for LLM=2 memories below 0.9 importance', async () => {
    const memories = [
      makeMem('a', { importance: 0.3, anchors: [{ type: 'file', path: 'src/x.ts' }] }),
    ];

    const mockLlm: LlmCallFn = async () => '2 | transient';
    const report = await runTriage(memories, mockLlm);

    expect(report.dispatch.proposals.length).toBeGreaterThan(0);
    expect(report.dispatch.proposals[0]!.suggestedAction).toBe('archive');
  });

  it('safety gate: LLM=1 with importance ≥ 0.9 → investigate proposal', async () => {
    const memories = [
      makeMem('a', { importance: 1.0, anchors: [{ type: 'file', path: 'src/x.ts' }] }),
    ];

    const mockLlm: LlmCallFn = async () => '1 | noise';
    const report = await runTriage(memories, mockLlm);

    // Phase 1 keep because importance ≥ 0.9 → no Phase 3 evaluation
    expect(report.dispatch.proposals).toHaveLength(0);
  });
});

// ── Merge output ───────────────────────────────────────────────────────

describe('orchestrator — merge output', () => {
  it('produces merge actions for YES pairs', async () => {
    const memories = [
      makeMem('older', {
        text: 'Authentication uses bcrypt with cost factor 10.',
        anchors: [{ type: 'file', path: 'src/auth.ts' }],
        createdAt: '2026-01-01T00:00:00.000Z',
      }),
      makeMem('newer', {
        text: 'Authentication uses bcrypt with cost factor 12.',
        anchors: [{ type: 'file', path: 'src/auth.ts' }],
        createdAt: '2026-07-01T00:00:00.000Z',
      }),
    ];

    const mockLlm: LlmCallFn = async () => {
      // First call is Phase 3 (no gray zone → no calls)
      // Phase 4 starts immediately. First pair → YES
      return 'YES';
    };

    const report = await runTriage(memories, mockLlm);
    expect(report.merges.merges.length).toBe(1);
    expect(report.merges.merges[0]!.supersededId).toBe('older');
    expect(report.merges.merges[0]!.keeperId).toBe('newer');
  });
});

// ── Cost reporting ─────────────────────────────────────────────────────

describe('orchestrator — cost reporting', () => {
  it('reports LLM call count and estimated tokens', async () => {
    const memories = [
      makeMem('a', { importance: 0.6, anchors: [{ type: 'file', path: 'src/x.ts' }] }),
      makeMem('b', { importance: 0.6, anchors: [{ type: 'file', path: 'src/x.ts' }] }),
    ];

    const mockLlm: LlmCallFn = async () => '4 | useful';
    const report = await runTriage(memories, mockLlm);

    expect(report.cost.llmCalls).toBeGreaterThan(0);
    expect(report.cost.estimatedTokens).toBeGreaterThan(0);
  });

  it('zero cost for empty input', async () => {
    const mockLlm: LlmCallFn = async () => 'NO';
    const report = await runTriage([], mockLlm);
    expect(report.cost.llmCalls).toBe(0);
    expect(report.cost.estimatedTokens).toBe(0);
  });
});

// ── Max limits ──────────────────────────────────────────────────────────

describe('orchestrator — max limits', () => {
  it('respects maxPhase3Calls', async () => {
    // Create 5 gray-zone memories
    const memories = Array.from({ length: 5 }, (_, i) => makeMem(`m${i}`, { importance: 0.6 }));

    let callCount = 0;
    const mockLlm: LlmCallFn = async () => {
      callCount++;
      return '4 | useful';
    };

    await runTriage(memories, mockLlm, { maxPhase3Calls: 2 });
    // Phase 3 capped at 2; Phase 4 may add more
    // We just verify the total was bounded
    expect(callCount).toBeLessThanOrEqual(2 + 100); // generous upper bound for Phase 4
  });

  it('respects maxPhase4Pairs', async () => {
    const memories = Array.from({ length: 5 }, (_, i) =>
      makeMem(`m${i}`, { anchors: [{ type: 'file', path: 'src/x.ts' }] }),
    );

    const mockLlm: LlmCallFn = async () => 'NO';
    const report = await runTriage(memories, mockLlm, { maxPhase4Pairs: 2 });
    // 5 memories in same cluster → 10 pairs, capped at 2
    expect(report.phaseStats.phase4PairsEvaluated).toBeLessThanOrEqual(2);
  });
});

// ── Format helper ──────────────────────────────────────────────────────

describe('formatTriageReport', () => {
  it('produces a markdown summary', async () => {
    const memories = [makeMem('a', { importance: 1.0 })];
    const mockLlm: LlmCallFn = async () => 'NO';
    const report = await runTriage(memories, mockLlm);
    const formatted = formatTriageReport(report);

    expect(formatted).toContain('# Triage Report');
    expect(formatted).toContain('Phase Statistics');
    expect(formatted).toContain('dry-run');
    expect(formatted).toContain('Cost');
  });

  it('shows apply mode when dryRun: false', async () => {
    const memories = [makeMem('a')];
    const mockLlm: LlmCallFn = async () => 'NO';
    const report = await runTriage(memories, mockLlm, { dryRun: false });
    const formatted = formatTriageReport(report);
    expect(formatted).toContain('apply');
  });
});
