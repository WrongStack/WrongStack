/**
 * `context.keepTokens` — a token-denominated verbatim tail on top of the
 * `preserveK` pair floor. It only ever keeps MORE, is capped so a pass can
 * still make room, and never reaches the hard-budget emergency trim.
 */

import { resolveContextWindowPolicy } from '@wrongstack/contracts/types/context-window';
import type { Message } from '@wrongstack/contracts/types/messages';
import { describe, expect, it } from 'vitest';
import type { Context } from '../../src/core/context.js';
import { widenTailCut } from '../../src/execution/compaction-tail.js';
import { HybridCompactor } from '../../src/execution/compactor.js';
import { validateConfigBehavior } from '../../src/storage/config-loader/validation.js';
import { estimateMessageTokens } from '../../src/utils/token-estimate.js';

function fakeContext(messages: Message[], meta: Record<string, unknown> = {}): Context {
  const ctx = { messages, meta } as never as Context;
  (ctx as never as { state: unknown }).state = {
    replaceMessages(next: Message[]) {
      messages.length = 0;
      messages.splice(0, 0, ...next);
    },
    appendMessage(m: Message) {
      messages.push(m);
    },
  };
  return ctx;
}

function policy(extra: Record<string, unknown>) {
  return {
    contextWindowPolicy: {
      preserveK: 3,
      eliseThreshold: 1_000,
      targetLoad: 0.65,
      thresholds: { warn: 0.55, soft: 0.7, hard: 0.85 },
      ...extra,
    },
  };
}

function chat(turns: number): Message[] {
  const messages: Message[] = [];
  for (let i = 0; i < turns; i++) {
    messages.push({ role: 'user', content: `t${i} ${'x'.repeat(500)}` });
    messages.push({ role: 'assistant', content: 'ok' });
  }
  return messages;
}

/** Turn numbers still present as their own user message (not folded into a digest). */
function verbatimTurns(messages: readonly Message[]): number[] {
  return messages
    .filter((m) => m.role === 'user' && typeof m.content === 'string')
    .map((m) => Number(/^t(\d+) /.exec(m.content as string)?.[1]))
    .filter((n) => Number.isFinite(n));
}

describe('tail helpers', () => {
  const messages = chat(10);
  const perPair = estimateMessageTokens(messages.slice(0, 2));

  /** Where the newest `keepTokens` begin, with no count floor in the way. */
  const tailStart = (keepTokens: number, meta: Record<string, unknown> = {}) =>
    widenTailCut(
      fakeContext(messages, { ...policy({ keepTokens }), ...meta }),
      messages,
      messages.length,
    );

  it('finds where the newest N tokens begin', () => {
    expect(tailStart(1)).toBe(messages.length - 1);
    // Three pairs' worth reaches back to the start of the third-last pair.
    expect(tailStart(perPair * 3)).toBe(messages.length - 6);
    expect(tailStart(10_000_000)).toBe(0);
  });

  it('widenTailCut only moves the cut earlier and is a no-op when unset', () => {
    const unset = fakeContext(messages, policy({}));
    expect(widenTailCut(unset, messages, 12)).toBe(12);
    const small = fakeContext(messages, policy({ keepTokens: 1 }));
    expect(widenTailCut(small, messages, 12)).toBe(12);
    const wide = fakeContext(messages, policy({ keepTokens: perPair * 8 }));
    expect(widenTailCut(wide, messages, 12)).toBe(messages.length - 16);
  });

  it('caps the tail at half the target load of the active window', () => {
    // 10 pairs at targetLoad 0.5 of a window of 4 pairs → cap = 1 pair.
    const capped = widenTailCut(
      fakeContext(messages, {
        ...policy({ keepTokens: 1_000_000, targetLoad: 0.5 }),
        effectiveMaxContext: perPair * 4,
      }),
      messages,
      messages.length,
    );
    expect(capped).toBe(messages.length - 2);
    expect(tailStart(-5)).toBe(messages.length);
  });
});

describe('HybridCompactor with keepTokens', () => {
  it('keeps the token tail verbatim through an aggressive collapse', async () => {
    const plain = chat(30);
    await new HybridCompactor({ preserveK: 3 }).compact(fakeContext(plain, policy({})), {
      aggressive: true,
    });
    expect(verbatimTurns(plain)).toEqual([27, 28, 29]);

    const kept = chat(30);
    const perPair = estimateMessageTokens(kept.slice(0, 2));
    await new HybridCompactor({ preserveK: 3 }).compact(
      fakeContext(kept, policy({ keepTokens: perPair * 10 })),
      { aggressive: true },
    );
    const survivors = verbatimTurns(kept);
    expect(survivors.at(-1)).toBe(29);
    expect(survivors.length).toBeGreaterThanOrEqual(10);
    // Older turns were still collapsed — the pass made room.
    expect(survivors).not.toContain(0);
  });

  it('still collapses when keepTokens is larger than the window allows', async () => {
    const messages = chat(30);
    await new HybridCompactor({ preserveK: 3 }).compact(
      fakeContext(messages, {
        ...policy({ keepTokens: 10_000_000, targetLoad: 0.5 }),
        effectiveMaxContext: 4_000,
      }),
      { aggressive: true },
    );
    expect(verbatimTurns(messages)).not.toContain(0);
  });

  it('does not elide tool output inside the kept tail', async () => {
    const big = 'y'.repeat(4_000);
    const build = (): Message[] => {
      const messages: Message[] = [];
      for (let i = 0; i < 20; i++) {
        messages.push({ role: 'user', content: `q${i}` });
        messages.push({
          role: 'assistant',
          content: [{ type: 'tool_use', id: `t${i}`, name: 'read', input: {} }],
        });
        messages.push({
          role: 'user',
          content: [{ type: 'tool_result', tool_use_id: `t${i}`, content: big }],
        });
      }
      return messages;
    };
    const resultFor = (messages: Message[], id: string) =>
      messages
        .flatMap((m) => (Array.isArray(m.content) ? m.content : []))
        .find((b) => b.type === 'tool_result' && b.tool_use_id === id) as
        | { content: string }
        | undefined;

    const plain = build();
    await new HybridCompactor({ preserveK: 2 }).compact(
      fakeContext(plain, policy({ preserveK: 2 })),
    );
    expect(resultFor(plain, 't15')?.content).not.toBe(big);

    const kept = build();
    const perCall = estimateMessageTokens(kept.slice(0, 3));
    await new HybridCompactor({ preserveK: 2 }).compact(
      fakeContext(kept, policy({ preserveK: 2, keepTokens: perCall * 6 })),
    );
    expect(resultFor(kept, 't15')?.content).toBe(big);
    expect(resultFor(kept, 't2')?.content).not.toBe(big);
  });
});

describe('keepTokens configuration', () => {
  it('flows from config into the resolved policy, and stays unset by default', () => {
    expect(resolveContextWindowPolicy({ keepTokens: 12_000 }).keepTokens).toBe(12_000);
    expect('keepTokens' in resolveContextWindowPolicy({})).toBe(false);
  });

  it('drops an invalid value at load and floors a fractional one', () => {
    const warnings: string[] = [];
    const bad = {
      version: 1 as const,
      context: {
        warnThreshold: 0.5,
        softThreshold: 0.7,
        hardThreshold: 0.9,
        preserveK: 3,
        eliseThreshold: 1000,
        keepTokens: -1,
      },
    };
    validateConfigBehavior(bad as never, (m) => warnings.push(m));
    expect('keepTokens' in bad.context).toBe(false);
    expect(warnings[0]).toContain('context.keepTokens');

    const fractional = { ...bad, context: { ...bad.context, keepTokens: 1500.7 } };
    validateConfigBehavior(fractional as never, () => {});
    expect(fractional.context.keepTokens).toBe(1500);
  });
});
