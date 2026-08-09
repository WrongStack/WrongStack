/**
 * Tests for SAGE Memory Triage — Phase 5: Action Dispatcher
 *
 * Tests that the dispatcher correctly translates triage results
 * (Phase 2 value scores + Phase 3 LLM evaluations) into concrete
 * auto-apply updates and proposals.
 */

import { describe, expect, it } from 'vitest';
import { dispatchAction, dispatchBatch } from '../src/triage/action-dispatcher.js';
import type { LlmTriageResult } from '../src/triage/llm-evaluator.js';
import type { Sage } from '../src/types.js';

// ── Helpers ─────────────────────────────────────────────────────────────

function makeMemory(overrides: Partial<Sage> = {}): Sage {
  return {
    id: 'mem_test_dispatch',
    revision: 1,
    scope: 'project',
    kind: 'fact',
    status: 'active',
    persistence: 'long_lived',
    text: 'This is a test memory with enough text to be meaningful and show up in dispatch previews.',
    importance: 0.6,
    confidence: 0.8,
    freshness: 1,
    tags: ['test'],
    anchors: [{ type: 'file', path: 'src/foo.ts' }],
    sources: [{ type: 'user' }],
    createdAt: '2026-08-04T12:00:00.000Z',
    updatedAt: '2026-08-04T12:00:00.000Z',
    ...overrides,
  };
}

function makeValueScore(total: number) {
  return {
    total,
    band: total >= 70 ? ('keep' as const) : total <= 29 ? ('discard' as const) : ('gray' as const),
    anchor: 15,
    usage: 10,
    freshness: 15,
    quality: 10,
    persistence: 10,
    maxes: { anchor: 25, usage: 25, freshness: 20, quality: 15, persistence: 15 },
    reasons: ['test score'],
  };
}

function makeLlmResult(
  memory: Sage,
  llmScore: 1 | 2 | 3 | 4 | 5,
  action: LlmTriageResult['action'],
  detScore: number = 50,
): LlmTriageResult {
  return {
    memory,
    valueScore: makeValueScore(detScore),
    evaluation: {
      score: llmScore,
      reason: `Test reason for score ${llmScore}`,
      raw: `${llmScore} | Test reason`,
      ok: true,
    },
    action,
    actionReason: `Test action reason: ${action}`,
  };
}

// ── Keep actions ────────────────────────────────────────────────────────

describe('action dispatcher — keep', () => {
  it('LLM=5 bumps confidence to 0.9', () => {
    const m = makeMemory({ confidence: 0.5 });
    const result = makeLlmResult(m, 5, 'keep');
    const { autoApply } = dispatchAction(result);
    expect(autoApply).not.toBeNull();
    const confUpdate = autoApply!.updates.find((u) => u.field === 'confidence');
    expect(confUpdate).toBeDefined();
    expect(confUpdate!.value).toBe(0.9);
  });

  it('LLM=4 bumps confidence to 0.8', () => {
    const m = makeMemory({ confidence: 0.5 });
    const result = makeLlmResult(m, 4, 'keep');
    const { autoApply } = dispatchAction(result);
    expect(autoApply).not.toBeNull();
    const confUpdate = autoApply!.updates.find((u) => u.field === 'confidence');
    expect(confUpdate).toBeDefined();
    expect(confUpdate!.value).toBe(0.8);
  });

  it('LLM=4 does not lower existing high confidence', () => {
    const m = makeMemory({ confidence: 0.95 });
    const result = makeLlmResult(m, 4, 'keep');
    const { autoApply } = dispatchAction(result);
    const confUpdate = autoApply?.updates.find((u) => u.field === 'confidence');
    expect(confUpdate).toBeUndefined();
  });

  it('no proposal for keep action', () => {
    const m = makeMemory();
    const result = makeLlmResult(m, 5, 'keep');
    const { proposal } = dispatchAction(result);
    expect(proposal).toBeNull();
  });
});

// ── Keep LLM override ───────────────────────────────────────────────────

describe('action dispatcher — keep_llm_override', () => {
  it('bumps confidence to 0.75 when low', () => {
    const m = makeMemory({ confidence: 0.4 });
    const result = makeLlmResult(m, 4, 'keep_llm_override', 25);
    const { autoApply } = dispatchAction(result);
    const confUpdate = autoApply!.updates.find((u) => u.field === 'confidence');
    expect(confUpdate).toBeDefined();
    expect(confUpdate!.value).toBe(0.75);
  });

  it('bumps importance to 0.55 when low', () => {
    const m = makeMemory({ importance: 0.3, confidence: 0.8 });
    const result = makeLlmResult(m, 4, 'keep_llm_override', 25);
    const { autoApply } = dispatchAction(result);
    const impUpdate = autoApply!.updates.find((u) => u.field === 'importance');
    expect(impUpdate).toBeDefined();
    expect(impUpdate!.value).toBe(0.55);
  });

  it('does not lower existing high confidence', () => {
    const m = makeMemory({ confidence: 0.9 });
    const result = makeLlmResult(m, 4, 'keep_llm_override', 25);
    const { autoApply } = dispatchAction(result);
    const confUpdate = autoApply?.updates.find((u) => u.field === 'confidence');
    expect(confUpdate).toBeUndefined();
  });
});

// ── Stale action ────────────────────────────────────────────────────────

describe('action dispatcher — stale', () => {
  it('marks status as stale', () => {
    const m = makeMemory({ status: 'active' });
    const result = makeLlmResult(m, 3, 'stale', 35);
    const { autoApply } = dispatchAction(result);
    const statusUpdate = autoApply!.updates.find((u) => u.field === 'status');
    expect(statusUpdate).toBeDefined();
    expect(statusUpdate!.value).toBe('stale');
  });

  it('lowers confidence to 0.4', () => {
    const m = makeMemory({ confidence: 0.8 });
    const result = makeLlmResult(m, 3, 'stale', 35);
    const { autoApply } = dispatchAction(result);
    const confUpdate = autoApply!.updates.find((u) => u.field === 'confidence');
    expect(confUpdate).toBeDefined();
    expect(confUpdate!.value).toBe(0.4);
  });

  it('does not lower confidence below 0.4 if already low', () => {
    const m = makeMemory({ confidence: 0.2 });
    const result = makeLlmResult(m, 3, 'stale', 35);
    const { autoApply } = dispatchAction(result);
    const confUpdate = autoApply!.updates.find((u) => u.field === 'confidence');
    expect(confUpdate).toBeUndefined();
  });

  it('does not re-stale an already stale memory', () => {
    const m = makeMemory({ status: 'stale', confidence: 0.3 });
    const result = makeLlmResult(m, 3, 'stale', 35);
    const { autoApply } = dispatchAction(result);
    expect(autoApply).toBeNull();
  });

  it('no proposal for stale action', () => {
    const m = makeMemory();
    const result = makeLlmResult(m, 3, 'stale', 35);
    const { proposal } = dispatchAction(result);
    expect(proposal).toBeNull();
  });

  it('reduces importance after repeated below-score rejection', () => {
    const m = makeMemory({ importance: 0.6 });
    const result = makeLlmResult(m, 3, 'stale', 35);
    result.valueScore.rejectionGate = 'belowScore';
    result.valueScore.rejectionCount = 5;

    const { autoApply } = dispatchAction(result);
    expect(autoApply?.updates).toContainEqual(
      expect.objectContaining({ field: 'importance', value: 0.5 }),
    );
  });

  it('does not reduce importance for keep, policy gates, or sub-threshold noise', () => {
    const cases = [
      { action: 'keep' as const, gate: 'belowScore' as const, count: 5 },
      {
        action: 'propose_archive_safety_stale' as const,
        gate: 'belowScore' as const,
        count: 10,
      },
      { action: 'stale' as const, gate: 'budget' as const, count: 10 },
      { action: 'stale' as const, gate: 'belowScore' as const, count: 2 },
    ];

    for (const item of cases) {
      const result = makeLlmResult(makeMemory(), 3, item.action, 35);
      result.valueScore.rejectionGate = item.gate;
      result.valueScore.rejectionCount = item.count;
      const { autoApply } = dispatchAction(result);
      const importanceUpdates = autoApply?.updates.filter((u) => u.field === 'importance') ?? [];
      expect(importanceUpdates).toHaveLength(0);
    }
  });
});

// ── Propose archive ─────────────────────────────────────────────────────

describe('action dispatcher — propose_archive', () => {
  it('lowers confidence to 0.3', () => {
    const m = makeMemory({ confidence: 0.8 });
    const result = makeLlmResult(m, 2, 'propose_archive', 25);
    const { autoApply } = dispatchAction(result);
    const confUpdate = autoApply!.updates.find((u) => u.field === 'confidence');
    expect(confUpdate).toBeDefined();
    expect(confUpdate!.value).toBe(0.3);
  });

  it('creates archive proposal', () => {
    const m = makeMemory({
      text: 'Outdated memory about a removed feature that no longer exists.',
    });
    const result = makeLlmResult(m, 2, 'propose_archive', 25);
    const { proposal } = dispatchAction(result);
    expect(proposal).not.toBeNull();
    expect(proposal!.suggestedAction).toBe('archive');
    expect(proposal!.reason).toContain('LLM rated 2');
  });
});

// ── Safety-gated stale ──────────────────────────────────────────────────

describe('action dispatcher — propose_archive_safety_stale', () => {
  it('marks status stale (safety gate)', () => {
    const m = makeMemory({ status: 'active', importance: 1.0 });
    const result = makeLlmResult(m, 2, 'propose_archive_safety_stale', 25);
    const { autoApply } = dispatchAction(result);
    const statusUpdate = autoApply!.updates.find((u) => u.field === 'status');
    expect(statusUpdate).toBeDefined();
    expect(statusUpdate!.value).toBe('stale');
  });

  it('creates investigate proposal (not archive)', () => {
    const m = makeMemory({ importance: 1.0 });
    const result = makeLlmResult(m, 1, 'propose_archive_safety_stale', 25);
    const { proposal } = dispatchAction(result);
    expect(proposal).not.toBeNull();
    expect(proposal!.suggestedAction).toBe('investigate');
    expect(proposal!.reason).toContain('safety gate');
    expect(proposal!.reason).toContain('human review');
  });

  it('does not re-stale already stale', () => {
    const m = makeMemory({ status: 'stale', importance: 1.0 });
    const result = makeLlmResult(m, 1, 'propose_archive_safety_stale', 25);
    const { autoApply } = dispatchAction(result);
    expect(autoApply).toBeNull();
  });
});

// ── Batch dispatch ──────────────────────────────────────────────────────

describe('batch dispatch', () => {
  it('aggregates multiple results correctly', () => {
    const m1 = makeMemory({ id: 'a', confidence: 0.5 });
    const m2 = makeMemory({ id: 'b', confidence: 0.5, importance: 0.3 });
    const m3 = makeMemory({ id: 'c' });

    const results: LlmTriageResult[] = [
      makeLlmResult(m1, 4, 'keep', 70),
      makeLlmResult(m2, 2, 'propose_archive', 25),
      makeLlmResult(m3, 3, 'stale', 35),
    ];

    const dispatch = dispatchBatch(results);

    expect(dispatch.autoApply).toHaveLength(3); // keep + propose_archive + stale all have updates
    expect(dispatch.proposals).toHaveLength(1); // only the archive
    expect(dispatch.summary.total).toBe(3);
    expect(dispatch.summary.proposals).toBe(1);
  });

  it('counts skipped (no auto-update, no proposal)', () => {
    const m = makeMemory({ confidence: 0.95 });
    const results: LlmTriageResult[] = [makeLlmResult(m, 5, 'keep', 85)];

    const dispatch = dispatchBatch(results);
    expect(dispatch.autoApply).toHaveLength(0); // confidence already >= 0.8
    expect(dispatch.proposals).toHaveLength(0);
    expect(dispatch.summary.skipped).toBe(1);
  });

  it('handles empty batch', () => {
    const dispatch = dispatchBatch([]);
    expect(dispatch.autoApply).toHaveLength(0);
    expect(dispatch.proposals).toHaveLength(0);
    expect(dispatch.summary.total).toBe(0);
  });
});

// ── Memory preview truncation ───────────────────────────────────────────

describe('memory preview', () => {
  it('truncates memory text to 80 chars in autoApply', () => {
    const m = makeMemory({
      text:
        'A'.repeat(200) +
        ' This describes a very specific architectural decision about the caching layer.',
      confidence: 0.5,
    });
    const result = makeLlmResult(m, 5, 'keep');
    const { autoApply } = dispatchAction(result);
    expect(autoApply!.memoryText.length).toBeLessThanOrEqual(80);
  });

  it('truncates memory text to 80 chars in proposals', () => {
    const m = makeMemory({
      text: 'B'.repeat(200) + ' This is outdated.',
      importance: 0.3,
    });
    const result = makeLlmResult(m, 2, 'propose_archive', 25);
    const { proposal } = dispatchAction(result);
    expect(proposal!.memoryText.length).toBeLessThanOrEqual(80);
  });
});

// ── All fields correct ──────────────────────────────────────────────────

describe('update field correctness', () => {
  it('every autoApply update has field, value, reason', () => {
    const m = makeMemory({ confidence: 0.3, importance: 0.3 });
    // keep_llm_override triggers both confidence AND importance updates
    const result = makeLlmResult(m, 4, 'keep_llm_override', 25);
    const { autoApply } = dispatchAction(result);
    expect(autoApply).not.toBeNull();

    for (const update of autoApply!.updates) {
      expect(update.field).toBeTruthy();
      expect(update.value).toBeDefined();
      expect(update.reason).toBeTruthy();
      expect(update.reason.length).toBeGreaterThan(10);
    }
  });

  it('every proposal has memoryId, suggestedAction, reason', () => {
    const m = makeMemory({ importance: 0.3, text: 'Outdated fact about removed feature.' });
    const result = makeLlmResult(m, 2, 'propose_archive', 25);
    const { proposal } = dispatchAction(result);
    expect(proposal).not.toBeNull();
    expect(proposal!.memoryId).toBe('mem_test_dispatch');
    expect(proposal!.suggestedAction).toBe('archive');
    expect(proposal!.reason.length).toBeGreaterThan(10);
  });
});
