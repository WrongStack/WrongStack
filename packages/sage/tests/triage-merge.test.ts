/**
 * Tests for SAGE Memory Triage — Phase 4: Merge Detection
 */

import { describe, expect, it } from 'vitest';
import type { Sage } from '../src/types.js';
import type { LlmCallFn } from '../src/triage/llm-evaluator.js';
import { detectMerges } from '../src/triage/merge-detection.js';

// ── Helpers ─────────────────────────────────────────────────────────────

function makeMem(id: string, text: string, overrides: Partial<Sage> = {}): Sage {
  return {
    id,
    revision: 1,
    scope: 'project',
    kind: 'fact',
    status: 'active',
    persistence: 'long_lived',
    text,
    importance: 0.6,
    confidence: 0.8,
    freshness: 1,
    tags: [],
    anchors: [],
    sources: [{ type: 'user' }],
    createdAt: '2026-08-04T12:00:00.000Z',
    updatedAt: '2026-08-04T12:00:00.000Z',
    ...overrides,
  };
}

// ── Clustering ──────────────────────────────────────────────────────────

describe('merge detection — clustering', () => {
  it('clusters by shared file anchor', async () => {
    const m1 = makeMem('a', 'Auth module uses bcrypt', {
      anchors: [{ type: 'file', path: 'src/auth.ts' }],
    });
    const m2 = makeMem('b', 'Auth module integrates with OAuth', {
      anchors: [{ type: 'file', path: 'src/auth.ts' }],
    });

    const mockLlm: LlmCallFn = async () => 'NO';
    const result = await detectMerges([m1, m2], mockLlm);

    expect(result.summary.clusters).toBeGreaterThanOrEqual(1);
    expect(result.summary.pairsGenerated).toBeGreaterThanOrEqual(1);
  });

  it('clusters by shared symbol anchor', async () => {
    const m1 = makeMem('a', 'verifySession normalizes exp to ms', {
      anchors: [{ type: 'symbol', symbol: 'verifySession', path: 'src/auth.ts' }],
    });
    const m2 = makeMem('b', 'verifySession throws on expired tokens', {
      anchors: [{ type: 'symbol', symbol: 'verifySession', path: 'src/auth.ts' }],
    });

    const mockLlm: LlmCallFn = async () => 'NO';
    const result = await detectMerges([m1, m2], mockLlm);

    expect(result.summary.clusters).toBeGreaterThanOrEqual(1);
  });

  it('clusters by 3+ shared tags', async () => {
    const m1 = makeMem('a', 'Node process safety: never kill node.exe', {
      tags: ['safety', 'node', 'process-management', 'windows'],
    });
    const m2 = makeMem('b', 'Do not terminate node.exe processes directly', {
      tags: ['safety', 'node', 'process-management', 'kill'],
    });

    const mockLlm: LlmCallFn = async () => 'NO';
    const result = await detectMerges([m1, m2], mockLlm);

    expect(result.summary.clusters).toBeGreaterThanOrEqual(1);
  });

  it('skips clusters larger than 5 members', async () => {
    const memories: Sage[] = [];
    for (let i = 0; i < 6; i++) {
      memories.push(
        makeMem(`m${i}`, `Memory ${i} about auth`, {
          anchors: [{ type: 'file', path: 'src/auth.ts' }],
        }),
      );
    }

    const mockLlm: LlmCallFn = async () => 'NO';
    const result = await detectMerges(memories, mockLlm);

    // The auth.ts cluster has 6 members → skipped
    expect(result.summary.pairsGenerated).toBe(0);
  });

  it('no clusters when no shared anchors/tags', async () => {
    const m1 = makeMem('a', 'Completely unrelated memory A', {
      anchors: [{ type: 'file', path: 'src/foo.ts' }],
      tags: ['x'],
    });
    const m2 = makeMem('b', 'Completely unrelated memory B', {
      anchors: [{ type: 'file', path: 'src/bar.ts' }],
      tags: ['y'],
    });

    const mockLlm: LlmCallFn = async () => 'NO';
    const result = await detectMerges([m1, m2], mockLlm);

    expect(result.summary.clusters).toBe(0);
    expect(result.summary.pairsGenerated).toBe(0);
  });
});

// ── LLM verdict parsing ─────────────────────────────────────────────────

describe('merge detection — verdict parsing', () => {
  it('YES → merge', async () => {
    const m1 = makeMem('a', 'Session timeout is 30 minutes', {
      anchors: [{ type: 'file', path: 'src/session.ts' }],
      createdAt: '2026-07-01T00:00:00.000Z', // older
    });
    const m2 = makeMem('b', 'Session timeout set to 30 minutes', {
      anchors: [{ type: 'file', path: 'src/session.ts' }],
      createdAt: '2026-08-01T00:00:00.000Z', // newer
    });

    const mockLlm: LlmCallFn = async () => 'YES';
    const result = await detectMerges([m1, m2], mockLlm);

    expect(result.merges).toHaveLength(1);
    expect(result.merges[0]!.supersededId).toBe('a'); // older gets superseded
    expect(result.merges[0]!.keeperId).toBe('b'); // newer survives
  });

  it('OVERLAP → proposal', async () => {
    const m1 = makeMem('a', 'Session timeout is 30 min', {
      anchors: [{ type: 'file', path: 'src/session.ts' }],
    });
    const m2 = makeMem('b', 'JWT refresh window is 5 min', {
      anchors: [{ type: 'file', path: 'src/session.ts' }],
    });

    const mockLlm: LlmCallFn = async () => 'OVERLAP';
    const result = await detectMerges([m1, m2], mockLlm);

    expect(result.overlaps).toHaveLength(1);
    expect(result.merges).toHaveLength(0);
  });

  it('NO → nothing', async () => {
    const m1 = makeMem('a', 'Authentication uses bcrypt', {
      anchors: [{ type: 'file', path: 'src/auth.ts' }],
    });
    const m2 = makeMem('b', 'Rate limiting is per-IP', {
      anchors: [{ type: 'file', path: 'src/auth.ts' }],
    });

    const mockLlm: LlmCallFn = async () => 'NO';
    const result = await detectMerges([m1, m2], mockLlm);

    expect(result.merges).toHaveLength(0);
    expect(result.overlaps).toHaveLength(0);
    expect(result.summary.mergeNo).toBe(1);
  });

  it('case-insensitive parsing', async () => {
    const m1 = makeMem('a', 'X', {
      anchors: [{ type: 'file', path: 'src/x.ts' }],
      createdAt: '2026-07-01T00:00:00.000Z',
    });
    const m2 = makeMem('b', 'X again', {
      anchors: [{ type: 'file', path: 'src/x.ts' }],
      createdAt: '2026-08-01T00:00:00.000Z',
    });

    const mockLlm: LlmCallFn = async () => 'yes'; // lowercase
    const result = await detectMerges([m1, m2], mockLlm);
    expect(result.merges).toHaveLength(1);
  });
});

// ── Error handling ──────────────────────────────────────────────────────

describe('merge detection — error handling', () => {
  it('LLM failure → treated as NO', async () => {
    const m1 = makeMem('a', 'X', { anchors: [{ type: 'file', path: 'src/x.ts' }] });
    const m2 = makeMem('b', 'Y', { anchors: [{ type: 'file', path: 'src/x.ts' }] });

    const mockLlm: LlmCallFn = async () => {
      throw new Error('Network timeout');
    };

    const result = await detectMerges([m1, m2], mockLlm);
    expect(result.summary.errors).toBe(1);
    expect(result.merges).toHaveLength(0);
    expect(result.overlaps).toHaveLength(0);
  });

  it('garbage response → NO', async () => {
    const m1 = makeMem('a', 'X', { anchors: [{ type: 'file', path: 'src/x.ts' }] });
    const m2 = makeMem('b', 'Y', { anchors: [{ type: 'file', path: 'src/x.ts' }] });

    const mockLlm: LlmCallFn = async () => 'gibberish 12345 !@#$%';

    const result = await detectMerges([m1, m2], mockLlm);
    expect(result.merges).toHaveLength(0);
    expect(result.overlaps).toHaveLength(0);
  });
});

// ── Deduplication across clusters ───────────────────────────────────────

describe('merge detection — deduplication', () => {
  it('same pair appearing in multiple clusters is evaluated once', async () => {
    const m1 = makeMem('a', 'Auth config', {
      anchors: [
        { type: 'file', path: 'src/auth.ts' },
        { type: 'symbol', symbol: 'init', path: 'src/auth.ts' },
      ],
      tags: ['auth', 'security', 'config'],
    });
    const m2 = makeMem('b', 'Auth setup', {
      anchors: [
        { type: 'file', path: 'src/auth.ts' },
        { type: 'symbol', symbol: 'init', path: 'src/auth.ts' },
      ],
      tags: ['auth', 'security', 'config'],
    });

    let callCount = 0;
    const mockLlm: LlmCallFn = async () => {
      callCount++;
      return 'NO';
    };

    await detectMerges([m1, m2], mockLlm);
    // Even though {a,b} appears in file, symbol, and tag clusters,
    // it should only be evaluated once
    expect(callCount).toBe(1);
  });
});

// ── Merge ordering ──────────────────────────────────────────────────────

describe('merge detection — ordering', () => {
  it('older memory gets superseded, newer survives', async () => {
    const older = makeMem('old', 'Session config', {
      anchors: [{ type: 'file', path: 'src/session.ts' }],
      createdAt: '2026-01-01T00:00:00.000Z',
    });
    const newer = makeMem('new', 'Session configuration updated', {
      anchors: [{ type: 'file', path: 'src/session.ts' }],
      createdAt: '2026-07-01T00:00:00.000Z',
    });

    const mockLlm: LlmCallFn = async () => 'YES';
    const result = await detectMerges([older, newer], mockLlm);

    expect(result.merges[0]!.supersededId).toBe('old');
    expect(result.merges[0]!.keeperId).toBe('new');
  });
});

describe('merge detection — quality-based keeper selection', () => {
  it('longer text wins over older memory', async () => {
    const older = makeMem('old', 'short fact', {
      anchors: [{ type: 'file', path: 'src/x.ts' }],
      createdAt: '2026-01-01T00:00:00.000Z',
    });
    const newer = makeMem('new', 'A'.repeat(500), {
      anchors: [{ type: 'file', path: 'src/x.ts' }],
      createdAt: '2026-07-01T00:00:00.000Z',
    });

    const mockLlm: LlmCallFn = async () => 'YES';
    const result = await detectMerges([older, newer], mockLlm);

    // Older has short text (low text score) — newer wins on quality
    expect(result.merges[0]!.keeperId).toBe('new');
    expect(result.merges[0]!.supersededId).toBe('old');
  });

  it('more anchors wins over older memory', async () => {
    // Same anchor required for cluster membership — both share src/auth.ts
    const older = makeMem('old', 'Fact about auth', {
      anchors: [{ type: 'file', path: 'src/auth.ts' }],
      createdAt: '2026-01-01T00:00:00.000Z',
    });
    const newer = makeMem('new', 'Fact about auth', {
      anchors: [
        { type: 'file', path: 'src/auth.ts' },
        { type: 'symbol', symbol: 'verifySession', path: 'src/auth.ts' },
        { type: 'command', command: 'pnpm test' },
      ],
      createdAt: '2026-07-01T00:00:00.000Z',
    });

    const mockLlm: LlmCallFn = async () => 'YES';
    const result = await detectMerges([older, newer], mockLlm);

    // Older has 1 anchor (low anchor score) — newer with 3 anchors wins
    expect(result.merges[0]!.keeperId).toBe('new');
  });

  it('higher confidence wins when other signals are equal', async () => {
    const older = makeMem('old', 'Same length text fact here', {
      anchors: [{ type: 'file', path: 'src/x.ts' }],
      confidence: 0.5,
      createdAt: '2026-01-01T00:00:00.000Z',
    });
    const newer = makeMem('new', 'Same length text fact here', {
      anchors: [{ type: 'file', path: 'src/x.ts' }],
      confidence: 1.0,
      createdAt: '2026-07-01T00:00:00.000Z',
    });

    const mockLlm: LlmCallFn = async () => 'YES';
    const result = await detectMerges([older, newer], mockLlm);

    // Same text length, same anchor count — newer wins on confidence
    expect(result.merges[0]!.keeperId).toBe('new');
  });

  it('equal quality scores → newer memory wins (tiebreaker)', async () => {
    const older = makeMem('old', 'Identical text content', {
      anchors: [{ type: 'file', path: 'src/x.ts' }],
      confidence: 0.8,
      createdAt: '2026-01-01T00:00:00.000Z',
    });
    const newer = makeMem('new', 'Identical text content', {
      anchors: [{ type: 'file', path: 'src/x.ts' }],
      confidence: 0.8,
      createdAt: '2026-07-01T00:00:00.000Z',
    });

    const mockLlm: LlmCallFn = async () => 'YES';
    const result = await detectMerges([older, newer], mockLlm);

    // Same length, anchors, confidence, tags, revision — newest wins
    // (the most recent statement of the same fact is the most authoritative)
    expect(result.merges[0]!.keeperId).toBe('new');
    expect(result.merges[0]!.supersededId).toBe('old');
  });

  it('produces flat merge output (no 3+ deep chains)', async () => {
    // Three memories: all share the same anchor, all flagged YES.
    // b is clearly the highest-quality memory (longest, most anchors, highest confidence).
    // The quality-based selection ensures b is NOT superseded by anything —
    // i.e., there are no multi-hop chains like a→c→b.
    const a = makeMem('m_a', 'x', {
      anchors: [{ type: 'file', path: 'src/auth.ts' }],
      confidence: 0.0,
      createdAt: '2026-01-01T00:00:00.000Z',
    });
    const b = makeMem('m_b', 'A'.repeat(300), {
      anchors: [
        { type: 'file', path: 'src/auth.ts' },
        { type: 'symbol', symbol: 'verifySession', path: 'src/auth.ts' },
      ],
      confidence: 1.0,
      createdAt: '2026-03-01T00:00:00.000Z',
    });
    const c = makeMem('m_c', 'y', {
      anchors: [{ type: 'file', path: 'src/auth.ts' }],
      confidence: 0.0,
      createdAt: '2026-06-01T00:00:00.000Z',
    });

    const mockLlm: LlmCallFn = async () => 'YES';
    const result = await detectMerges([a, b, c], mockLlm);

    // b is the highest-quality memory — it must NOT be superseded by anything.
    // The old (date-based) logic would have produced a chain where b gets
    // superseded by c (newer), then c gets superseded by even-newer memories.
    // The new quality logic ensures b (highest quality) survives all pairwise merges.
    const bAsSuperseded = result.merges.some((m) => m.supersededId === 'm_b');
    expect(bAsSuperseded).toBe(false);

    // b should be among the keepers (highest-quality memory wins)
    const keeperIds = new Set(result.merges.map((m) => m.keeperId));
    expect(keeperIds.has('m_b')).toBe(true);
  });
});

// ── Summary correctness ─────────────────────────────────────────────────

describe('merge detection — summary', () => {
  it('summary reflects actual counts', async () => {
    const m1 = makeMem('id_m1', 'Session timeout is exactly 30 minutes', {
      anchors: [{ type: 'file', path: 'src/x.ts' }],
      createdAt: '2026-01-01T00:00:00.000Z',
    });
    const m2 = makeMem('id_m2', 'Session timeout is set to 30 minutes', {
      anchors: [{ type: 'file', path: 'src/x.ts' }],
      createdAt: '2026-06-01T00:00:00.000Z',
    });
    const m3 = makeMem('id_m3', 'JWT refresh window and token lifecycle', {
      anchors: [{ type: 'file', path: 'src/x.ts' }],
    });
    const m4 = makeMem('id_m4', 'Completely unrelated configuration flag', {
      anchors: [{ type: 'file', path: 'src/x.ts' }],
    });

    let callIdx = 0;
    const mockLlm: LlmCallFn = async (_sys, _prompt) => {
      // First call: m1↔m2 → YES
      // Second call: m1↔m3 → OVERLAP
      // Remaining calls: NO
      if (callIdx === 0) {
        callIdx++;
        return 'YES';
      }
      if (callIdx === 1) {
        callIdx++;
        return 'OVERLAP';
      }
      callIdx++;
      return 'NO';
    };

    const result = await detectMerges([m1, m2, m3, m4], mockLlm);

    expect(result.summary.totalMemories).toBe(4);
    expect(result.summary.pairsEvaluated).toBe(6); // n*(n-1)/2 = 6 for 4 members
    expect(result.summary.mergeYes).toBe(1);
    expect(result.summary.overlap).toBe(1);
    expect(result.summary.mergeNo).toBe(4);
    expect(result.summary.errors).toBe(0);
  });
});

// ── Empty input ─────────────────────────────────────────────────────────

describe('merge detection — edge cases', () => {
  it('empty input', async () => {
    const mockLlm: LlmCallFn = async () => 'NO';
    const result = await detectMerges([], mockLlm);
    expect(result.summary.totalMemories).toBe(0);
    expect(result.summary.clusters).toBe(0);
    expect(result.merges).toHaveLength(0);
  });

  it('single memory', async () => {
    const m = makeMem('a', 'Only one');
    const mockLlm: LlmCallFn = async () => 'NO';
    const result = await detectMerges([m], mockLlm);
    expect(result.summary.pairsGenerated).toBe(0);
  });

  it('respects maxPairs limit', async () => {
    const memories: Sage[] = [];
    for (let i = 0; i < 5; i++) {
      memories.push(
        makeMem(`m${i}`, `Memory ${i}`, {
          anchors: [{ type: 'file', path: 'src/shared.ts' }],
          createdAt: `2026-0${i + 1}-01T00:00:00.000Z`,
        }),
      );
    }

    let callCount = 0;
    const mockLlm: LlmCallFn = async () => {
      callCount++;
      return 'NO';
    };

    // 5 members = 10 pairs, cap at 3
    const result = await detectMerges(memories, mockLlm, { maxPairs: 3 });
    expect(callCount).toBe(3);
    expect(result.summary.pairsEvaluated).toBe(3);
  });
});
