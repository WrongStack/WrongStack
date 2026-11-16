/**
 * Triage Phases 3/4 with a TypeSafe System One front.
 *
 * The contract under test is the cascade: a decisive judgment settles the
 * memory or pair without an LLM call, and everything else — a flat
 * distribution, a failing or resting host — reaches the LLM exactly as it
 * did before the front existed.
 */

import type { TypeSafeJudge } from '@wrongstack/core/typesafe';
import { describe, expect, it, vi } from 'vitest';
import { evaluateBatch } from '../src/triage/llm-evaluator.js';
import { detectMerges } from '../src/triage/merge-detection.js';
import { createSystemOneTriage } from '../src/triage/system-one.js';
import { computeValueScore } from '../src/triage/value-score.js';
import type { Sage } from '../src/types.js';

function makeMemory(overrides: Partial<Sage> = {}): Sage {
  return {
    id: 'mem_s1',
    revision: 1,
    scope: 'project',
    kind: 'fact',
    status: 'active',
    persistence: 'long_lived',
    text: 'The live Config object is frozen; mutate it through patchConfig.',
    importance: 0.6,
    confidence: 0.8,
    freshness: 1,
    tags: ['config'],
    anchors: [{ type: 'file', path: 'src/config.ts' }],
    sources: [{ type: 'user' }],
    createdAt: '2026-08-04T12:00:00.000Z',
    updatedAt: '2026-08-04T12:00:00.000Z',
    ...overrides,
  };
}

function judgeWith(answer: unknown | Error): TypeSafeJudge {
  return {
    feature: 'memoryTriage',
    model: 'jev-test',
    client: {
      systemOne: vi.fn(async () => {
        if (answer instanceof Error) throw answer;
        return { answers: { q: answer as never }, usage: { inputTokens: 1, outputTokens: 0 } };
      }),
    },
  };
}

const score = (probabilities: Record<string, number>, confidence: number) => ({
  type: 'score',
  score: 0,
  confidence,
  probabilities,
  legend: {},
});

describe('System One triage — Phase 3', () => {
  it('uses a decisive rating and skips the LLM', async () => {
    const m = makeMemory();
    const callLlm = vi.fn(async () => '1 | noise');
    const systemOne = createSystemOneTriage({
      judge: judgeWith(score({ 0: 0.02, 1: 0.03, 2: 0.05, 3: 0.2, 4: 0.7 }, 0.8)),
    });
    const [result] = await evaluateBatch([m], new Map([[m.id, computeValueScore(m)]]), callLlm, {
      systemOne,
    });
    expect(result?.evaluation.score).toBe(5);
    expect(result?.evaluation.raw).toBe('system-one:5');
    expect(callLlm).not.toHaveBeenCalled();
  });

  it('asks the LLM when the rating is not concentrated', async () => {
    const m = makeMemory();
    const callLlm = vi.fn(async () => '4 | useful');
    const systemOne = createSystemOneTriage({
      judge: judgeWith(score({ 0: 0.2, 1: 0.2, 2: 0.2, 3: 0.2, 4: 0.2 }, 0.1)),
    });
    const [result] = await evaluateBatch([m], new Map([[m.id, computeValueScore(m)]]), callLlm, {
      systemOne,
    });
    expect(result?.evaluation.score).toBe(4);
    expect(callLlm).toHaveBeenCalledTimes(1);
  });

  it('asks the LLM when the host fails', async () => {
    const m = makeMemory();
    const callLlm = vi.fn(async () => '3 | niche');
    const systemOne = createSystemOneTriage({ judge: judgeWith(new Error('resting')) });
    const [result] = await evaluateBatch([m], new Map([[m.id, computeValueScore(m)]]), callLlm, {
      systemOne,
    });
    expect(result?.evaluation.score).toBe(3);
    expect(callLlm).toHaveBeenCalledTimes(1);
  });
});

describe('System One triage — Phase 4', () => {
  const pair = [
    makeMemory({ id: 'a', text: 'Config is frozen; use patchConfig.' }),
    makeMemory({ id: 'b', text: 'Never assign to the live Config; call patchConfig instead.' }),
  ];

  it('needs a strong YES to merge without the LLM', async () => {
    const callLlm = vi.fn(async () => 'NO');
    // Winning level is "same fact" but only at 0.6: not enough to merge.
    const weak = createSystemOneTriage({
      judge: judgeWith(score({ 0: 0.1, 1: 0.3, 2: 0.6 }, 0.6)),
    });
    await detectMerges(pair, callLlm, { systemOne: weak });
    expect(callLlm).toHaveBeenCalled();

    callLlm.mockClear();
    const strong = createSystemOneTriage({
      judge: judgeWith(score({ 0: 0.02, 1: 0.08, 2: 0.9 }, 0.85)),
    });
    const result = await detectMerges(pair, callLlm, { systemOne: strong });
    expect(callLlm).not.toHaveBeenCalled();
    expect(result.merges).toHaveLength(1);
  });

  it('falls back cleanly when score answers omit probabilities (F450)', async () => {
    const { probeMemoryValue } = await import('../src/triage/system-one.js');
    const m = makeMemory();
    await expect(
      probeMemoryValue(judgeWith({ type: 'score', score: 0, confidence: 0.7 }), m),
    ).resolves.toBeUndefined();
  });
});
