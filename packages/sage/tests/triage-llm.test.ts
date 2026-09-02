/**
 * Tests for SAGE Memory Triage — Phase 3: LLM Evaluator
 *
 * Tests the pluggable LLM evaluation pipeline:
 * - Response parsing (various formats)
 * - Action resolution (all score × det-score combinations)
 * - Safety gate (importance >= 0.9)
 * - Prompt building
 * - Batch evaluation with mock LLM
 * - Error handling
 */

import { describe, expect, it } from 'vitest';
import type { Sage } from '../src/types.js';
import { computeValueScore } from '../src/triage/value-score.js';
import { evaluateMemory, evaluateBatch } from '../src/triage/llm-evaluator.js';
import type { LlmCallFn, TriageAction } from '../src/triage/llm-evaluator.js';

// ── Helpers ─────────────────────────────────────────────────────────────

function makeMemory(overrides: Partial<Sage> = {}): Sage {
  return {
    id: 'mem_test_eval',
    revision: 1,
    scope: 'project',
    kind: 'fact',
    status: 'active',
    persistence: 'long_lived',
    text: 'This is a test memory for LLM evaluation. It describes a moderately useful convention.',
    importance: 0.6,
    confidence: 0.8,
    freshness: 1,
    tags: ['test', 'convention'],
    anchors: [{ type: 'file', path: 'src/foo.ts' }],
    sources: [{ type: 'user' }],
    createdAt: '2026-08-04T12:00:00.000Z',
    updatedAt: '2026-08-04T12:00:00.000Z',
    ...overrides,
  };
}

function mockLlm(response: string): LlmCallFn {
  return async (_system: string, _userPrompt: string) => response;
}

function mockLlmError(message: string): LlmCallFn {
  return async (_system: string, _userPrompt: string) => {
    throw new Error(message);
  };
}

// ── Response parsing ────────────────────────────────────────────────────

describe('LLM evaluator — response parsing', () => {
  it('parses standard "SCORE | REASON" format', async () => {
    const m = makeMemory();
    const vs = computeValueScore(m);
    const result = await evaluateMemory(
      m,
      vs,
      mockLlm('4 | Documents a key architectural invariant'),
    );
    expect(result.evaluation.score).toBe(4);
    expect(result.evaluation.reason).toBe('Documents a key architectural invariant');
    expect(result.evaluation.ok).toBe(true);
  });

  it('parses "SCORE - REASON" format', async () => {
    const m = makeMemory();
    const vs = computeValueScore(m);
    const result = await evaluateMemory(m, vs, mockLlm('2 - Outdated API reference'));
    expect(result.evaluation.score).toBe(2);
    expect(result.evaluation.reason).toBe('Outdated API reference');
  });

  it('parses "SCORE: REASON" format', async () => {
    const m = makeMemory();
    const vs = computeValueScore(m);
    const result = await evaluateMemory(m, vs, mockLlm('5: Critical security invariant'));
    expect(result.evaluation.score).toBe(5);
    expect(result.evaluation.reason).toBe('Critical security invariant');
  });

  it('parses "SCORE. REASON" format', async () => {
    const m = makeMemory();
    const vs = computeValueScore(m);
    const result = await evaluateMemory(m, vs, mockLlm('3. Niche but occasionally useful'));
    expect(result.evaluation.score).toBe(3);
    expect(result.evaluation.reason).toBe('Niche but occasionally useful');
  });

  it('defaults to score 3 on unparseable response', async () => {
    const m = makeMemory();
    const vs = computeValueScore(m);
    const result = await evaluateMemory(m, vs, mockLlm('something completely unexpected'));
    expect(result.evaluation.score).toBe(3);
    expect(result.evaluation.ok).toBe(true);
  });

  it('defaults to score 3 on empty response', async () => {
    const m = makeMemory();
    const vs = computeValueScore(m);
    const result = await evaluateMemory(m, vs, mockLlm(''));
    expect(result.evaluation.score).toBe(3);
    expect(result.evaluation.ok).toBe(false);
  });

  it('handles LLM call failure gracefully', async () => {
    const m = makeMemory();
    const vs = computeValueScore(m);
    const result = await evaluateMemory(m, vs, mockLlmError('Network timeout'));
    expect(result.evaluation.score).toBe(3);
    expect(result.evaluation.ok).toBe(false);
    expect(result.evaluation.error).toContain('Network timeout');
    // On error, we default to keep — never lose a memory to a transient failure
    expect(result.action).toBe('keep');
  });

  it('extracts score even with leading text', async () => {
    const m = makeMemory();
    const vs = computeValueScore(m);
    const result = await evaluateMemory(m, vs, mockLlm('I think this is a 4 | pretty useful'));
    expect(result.evaluation.score).toBe(4);
  });

  it('truncates long reasons to 200 chars', async () => {
    const m = makeMemory();
    const vs = computeValueScore(m);
    const longReason = 'A'.repeat(500);
    const result = await evaluateMemory(m, vs, mockLlm(`3 | ${longReason}`));
    expect(result.evaluation.reason.length).toBeLessThanOrEqual(200);
  });
});

// ── Action resolution — LLM score 5 ────────────────────────────────────

describe('action resolution — LLM score 5 (essential)', () => {
  it('always keep regardless of det score', async () => {
    const m = makeMemory({ importance: 0.3 });
    const vs = { ...computeValueScore(m), total: 10 }; // artificially low
    const result = await evaluateMemory(m, vs, mockLlm('5 | Essential'));
    expect(result.action).toBe('keep');
  });

  it('always keep even with high importance', async () => {
    const m = makeMemory({ importance: 1.0 });
    const vs = computeValueScore(m);
    const result = await evaluateMemory(m, vs, mockLlm('5 | Essential'));
    expect(result.action).toBe('keep');
  });
});

// ── Action resolution — LLM score 4 ────────────────────────────────────

describe('action resolution — LLM score 4 (useful)', () => {
  it('keep when det score >= 40', async () => {
    const m = makeMemory({ importance: 0.4 });
    const vs = { ...computeValueScore(m), total: 60 };
    const result = await evaluateMemory(m, vs, mockLlm('4 | Useful'));
    expect(result.action).toBe('keep');
  });

  it('LLM overrides when det score < 40', async () => {
    const m = makeMemory({ importance: 0.4 });
    const vs = { ...computeValueScore(m), total: 25 };
    const result = await evaluateMemory(m, vs, mockLlm('4 | Useful'));
    expect(result.action).toBe('keep_llm_override');
  });
});

// ── Action resolution — LLM score 3 ────────────────────────────────────

describe('action resolution — LLM score 3 (niche)', () => {
  it('keep when det score >= 50', async () => {
    const m = makeMemory({ importance: 0.5 });
    const vs = { ...computeValueScore(m), total: 65 };
    const result = await evaluateMemory(m, vs, mockLlm('3 | Niche'));
    expect(result.action).toBe('keep');
  });

  it('stale when det score < 50', async () => {
    const m = makeMemory({ importance: 0.5 });
    const vs = { ...computeValueScore(m), total: 35 };
    const result = await evaluateMemory(m, vs, mockLlm('3 | Niche'));
    expect(result.action).toBe('stale');
  });
});

// ── Action resolution — LLM score 2 ────────────────────────────────────

describe('action resolution — LLM score 2 (transient)', () => {
  it('propose_archive when importance < 0.9', async () => {
    const m = makeMemory({ importance: 0.5 });
    const vs = computeValueScore(m);
    const result = await evaluateMemory(m, vs, mockLlm('2 | Transient'));
    expect(result.action).toBe('propose_archive');
  });

  it('safety gate: stale only when importance >= 0.9', async () => {
    const m = makeMemory({ importance: 0.95 });
    const vs = computeValueScore(m);
    const result = await evaluateMemory(m, vs, mockLlm('2 | Transient'));
    expect(result.action).toBe('stale');
    expect(result.actionReason).toContain('safety gate');
  });

  it('safety gate at exact 0.9 boundary', async () => {
    const m = makeMemory({ importance: 0.9 });
    const vs = computeValueScore(m);
    const result = await evaluateMemory(m, vs, mockLlm('2 | Transient'));
    expect(result.action).toBe('stale');
  });
});

// ── Action resolution — LLM score 1 ───────────────────────────────────────

describe('action resolution — LLM score 1 (noise)', () => {
  it('propose_archive when importance < 0.9', async () => {
    const m = makeMemory({ importance: 0.3 });
    const vs = computeValueScore(m);
    const result = await evaluateMemory(m, vs, mockLlm('1 | Noise'));
    expect(result.action).toBe('propose_archive');
  });

  it('safety gate: stale only when importance >= 0.9', async () => {
    const m = makeMemory({ importance: 1.0 });
    const vs = computeValueScore(m);
    const result = await evaluateMemory(m, vs, mockLlm('1 | Noise'));
    expect(result.action).toBe('propose_archive_safety_stale');
    expect(result.actionReason).toContain('safety gate');
  });
});

// ── Batch evaluation ───────────────────────────────────────────────────

describe('batch evaluation', () => {
  it('evaluates multiple memories sequentially', async () => {
    const memories = [
      makeMemory({ id: 'a', text: 'Memory A describes useful fact' }),
      makeMemory({ id: 'b', text: 'Memory B is transient noise' }),
      makeMemory({ id: 'c', text: 'Memory C is essential knowledge' }),
    ];

    const valueScores = new Map(memories.map((m) => [m.id, computeValueScore(m)]));

    let callCount = 0;
    const mockCall: LlmCallFn = async (_sys, prompt) => {
      callCount++;
      if (prompt.includes('Memory A')) return '4 | Useful fact';
      if (prompt.includes('Memory B')) return '2 | Transient noise';
      if (prompt.includes('Memory C')) return '5 | Essential knowledge';
      return '3 | Default';
    };

    const results = await evaluateBatch(memories, valueScores, mockCall);

    expect(results).toHaveLength(3);
    expect(callCount).toBe(3);
    expect(results[0]!.action).toBe('keep');
    expect(results[1]!.action).toBe('propose_archive');
    expect(results[2]!.action).toBe('keep');
  });

  it('skips memories without value scores', async () => {
    const memories = [makeMemory({ id: 'a' }), makeMemory({ id: 'b' })];

    const valueScores = new Map([
      ['a', computeValueScore(memories[0]!)],
      // 'b' intentionally missing
    ]);

    let callCount = 0;
    const mockCall: LlmCallFn = async () => {
      callCount++;
      return '4 | ok';
    };

    const results = await evaluateBatch(memories, valueScores, mockCall);
    expect(results).toHaveLength(1);
    expect(callCount).toBe(1);
  });

  it('respects maxBatchSize', async () => {
    const many = Array.from({ length: 10 }, (_, i) =>
      makeMemory({ id: `mem_${i}`, text: `Memory ${i}` }),
    );
    const valueScores = new Map(many.map((m) => [m.id, computeValueScore(m)]));

    let callCount = 0;
    const mockCall: LlmCallFn = async () => {
      callCount++;
      return '4 | ok';
    };

    const results = await evaluateBatch(many, valueScores, mockCall, { maxBatchSize: 3 });
    expect(results).toHaveLength(3);
    expect(callCount).toBe(3);
  });
});

// ── Prompt content ──────────────────────────────────────────────────────

describe('prompt content', () => {
  it('includes memory text (truncated), anchors, kind, and stats', async () => {
    const m = makeMemory({
      text: 'Very long text '.repeat(50),
      anchors: [
        { type: 'file', path: 'packages/core/src/auth.ts' },
        { type: 'symbol', symbol: 'verifySession', path: 'packages/core/src/auth.ts' },
      ],
      kind: 'convention',
      injectionCount: 12,
      useCount: 3,
      importance: 0.65,
    });
    const vs = computeValueScore(m);

    let capturedPrompt = '';
    const mockCall: LlmCallFn = async (_sys, prompt) => {
      capturedPrompt = prompt;
      return '4 | useful';
    };

    await evaluateMemory(m, vs, mockCall);

    expect(capturedPrompt).toContain('TEXT:');
    expect(capturedPrompt).toContain('ANCHORS:');
    expect(capturedPrompt).toContain('KIND: convention');
    expect(capturedPrompt).toContain('INJECTED: 12x');
    expect(capturedPrompt).toContain('USED: 3x');
    expect(capturedPrompt).toContain('AGE:');
    expect(capturedPrompt).toContain('SCORE:');
    expect(capturedPrompt).toContain('IMPORTANCE: 0.7'); // 0.65 rounds to 0.7
    // Text should be truncated
    expect(capturedPrompt.length).toBeLessThan(600);
  });

  it('shows "none" for no anchors', async () => {
    const m = makeMemory({ anchors: [] });
    const vs = computeValueScore(m);

    let capturedPrompt = '';
    const mockCall: LlmCallFn = async (_sys, prompt) => {
      capturedPrompt = prompt;
      return '3 | meh';
    };

    await evaluateMemory(m, vs, mockCall);
    expect(capturedPrompt).toContain('ANCHORS: none');
  });
});

// ── All TriageAction values covered ─────────────────────────────────────

describe('action coverage', () => {
  it('all 6 TriageAction values are reachable', async () => {
    const actionsSeen = new Set<string>();

    const testCases: Array<{
      imp: number;
      detScore: number;
      llmResponse: string;
      expectedAction: TriageAction;
    }> = [
      { imp: 0.6, detScore: 10, llmResponse: '5 | essential', expectedAction: 'keep' },
      { imp: 0.6, detScore: 60, llmResponse: '4 | useful', expectedAction: 'keep' },
      {
        imp: 0.3,
        detScore: 25,
        llmResponse: '4 | useful override',
        expectedAction: 'keep_llm_override',
      },
      { imp: 0.4, detScore: 35, llmResponse: '3 | niche low', expectedAction: 'stale' },
      { imp: 0.5, detScore: 40, llmResponse: '2 | transient', expectedAction: 'propose_archive' },
      {
        imp: 0.95,
        detScore: 40,
        llmResponse: '1 | noise',
        expectedAction: 'propose_archive_safety_stale',
      },
    ];

    for (const tc of testCases) {
      const m = makeMemory({ importance: tc.imp });
      const vs = { ...computeValueScore(m), total: tc.detScore };
      const result = await evaluateMemory(m, vs, mockLlm(tc.llmResponse));
      actionsSeen.add(result.action);
      expect(result.action).toBe(tc.expectedAction);
    }

    expect(actionsSeen.size).toBe(5);
  });
});
