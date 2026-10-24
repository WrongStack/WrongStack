/**
 * The System One compaction selector: turn-aligned ranges, a guaranteed tail,
 * budget packing in code, and a hand-off to the wrapped selector whenever it
 * cannot decide.
 */

import type { Message } from '@wrongstack/contracts/types/messages';
import type { MessageSelector } from '@wrongstack/contracts/types/selector';
import { describe, expect, it, vi } from 'vitest';
import { SystemOneSelector } from '../src/models/system-one-selector.js';
import type { TypeSafeJudge } from '../src/typesafe/index.js';

function turns(n: number): Message[] {
  const messages: Message[] = [];
  for (let i = 0; i < n; i++) {
    messages.push({ role: 'user', content: `task ${i} ${'x'.repeat(200)}` });
    messages.push({ role: 'assistant', content: `done ${i} ${'y'.repeat(200)}` });
  }
  return messages;
}

const levelAnswer = (level: number) => ({
  type: 'score' as const,
  score: level,
  confidence: 0.9,
  probabilities: {
    0: level === 0 ? 0.9 : 0.05,
    1: level === 1 ? 0.9 : 0.05,
    2: level === 2 ? 0.9 : 0.05,
  },
  legend: {},
});

function judge(levels: number[] | Error): TypeSafeJudge {
  return {
    feature: 'compaction',
    model: 'jev-test',
    client: {
      systemOne: vi.fn(async () => {
        if (levels instanceof Error) throw levels;
        return {
          answers: Object.fromEntries(levels.map((l, i) => [`t${i}`, levelAnswer(l)])),
          usage: { inputTokens: 1, outputTokens: 0 },
        };
      }),
    },
  };
}

const fallback = (): MessageSelector & { select: ReturnType<typeof vi.fn> } => ({
  select: vi.fn(async () => ({ kept: [], collapsed: [], reasoning: 'fallback' })),
});

describe('SystemOneSelector', () => {
  it('keeps the tail and needed turns, collapses the rest on turn boundaries', async () => {
    // 6 turns: head(0), middle 1..3, tail 4..5. Middle rated: not needed, needed, background.
    const inner = fallback();
    const selector = new SystemOneSelector({ getJudge: () => judge([0, 2, 1]), fallback: inner });
    const result = await selector.select(turns(6), 100_000);
    expect(inner.select).not.toHaveBeenCalled();
    expect(result.collapsed).toEqual([{ from: 2, to: 3 }]);
    const keptIdx = result.kept.flatMap((r) => [r.from, r.to]);
    expect(keptIdx).toContain(11);
    expect(result.kept.some((r) => r.from === 0)).toBe(true);
    // Ranges never split a turn: every boundary is a user message.
    for (const r of [...result.kept, ...result.collapsed]) expect(r.from % 2).toBe(0);
  });

  it('drops lower-rated turns first when the budget is tight', async () => {
    const selector = new SystemOneSelector({
      getJudge: () => judge([1, 2, 1]),
      fallback: fallback(),
    });
    const messages = turns(6);
    // Room for the tail, the head and roughly one more turn.
    const result = await selector.select(messages, 520);
    const keptMiddle = result.kept.filter((r) => r.from > 0 && r.from < 8);
    expect(keptMiddle.every((r) => r.importance === 'high')).toBe(true);
  });

  it('hands off to the wrapped selector when the host fails', async () => {
    const inner = fallback();
    const selector = new SystemOneSelector({
      getJudge: () => judge(new Error('resting')),
      fallback: inner,
    });
    const result = await selector.select(turns(6), 100_000);
    expect(result.reasoning).toBe('fallback');
  });
});
