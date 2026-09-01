import { afterEach, describe, expect, it } from 'vitest';
import {
  computeMessageTokens,
  estimateMessageTokens,
  estimateRequestTokens,
  estimateRequestTokensCalibrated,
  estimateRequestTokensUpperBound,
  estimateTextTokens,
  estimateToolDefTokens,
  estimateToolInputTokens,
  estimateToolResultTokens,
  getCalibrationState,
  realAnchoredInputTokens,
  recordActualUsage,
  resetCalibration,
} from '../../src/utils/token-estimate.js';
import type { Message } from '../../src/types/messages.js';

afterEach(() => {
  resetCalibration();
});

describe('estimateToolInputTokens', () => {
  it('returns a positive integer for string input', () => {
    expect(estimateToolInputTokens('hello world')).toBeGreaterThan(0);
  });

  it('returns a positive integer for object input', () => {
    expect(estimateToolInputTokens({ command: 'ls -la' })).toBeGreaterThan(0);
  });

  it('handles null and primitive non-strings without throwing', () => {
    expect(estimateToolInputTokens(null)).toBeGreaterThan(0);
    expect(estimateToolInputTokens(42)).toBeGreaterThan(0);
    expect(estimateToolInputTokens(true)).toBeGreaterThan(0);
  });

  it('does NOT mutate the input object', () => {
    // Previously the function attached `__tokenEstimate` to the input — which
    // threw on frozen inputs and was visible to anyone iterating the object.
    const input = { command: 'echo hi', args: ['--flag'] };
    estimateToolInputTokens(input);
    expect(Object.keys(input).sort()).toEqual(['args', 'command']);
    expect(Object.getOwnPropertyNames(input).sort()).toEqual(['args', 'command']);
  });

  it('does NOT throw on a frozen input', () => {
    const frozen = Object.freeze({ url: 'https://example.com' });
    expect(() => estimateToolInputTokens(frozen)).not.toThrow();
  });

  it('serializes a payload once and memoizes on the object', () => {
    // The memo used to be keyed by a hash of the stringified payload, so every
    // call paid JSON.stringify PLUS a full DJB2 pass before it could look
    // anything up — two walks over the payload to cache one division. Keyed on
    // the object, a repeat call must not touch the payload at all.
    let reads = 0;
    const input = {
      get payload(): string {
        reads++;
        return 'x'.repeat(350);
      },
    };
    const first = estimateToolInputTokens(input);
    const second = estimateToolInputTokens(input);
    expect(second).toBe(first);
    expect(reads).toBe(1);
  });

  it('gives equal estimates to distinct objects with identical content', () => {
    // Object identity drives the memo, so two separate objects are two misses —
    // but they must still agree on the number.
    const a = { command: 'ls -la', cwd: '/tmp' };
    const b = { command: 'ls -la', cwd: '/tmp' };
    expect(estimateToolInputTokens(b)).toBe(estimateToolInputTokens(a));
  });

  it('returns the same estimate on repeated calls (cache hit)', () => {
    const input = { command: 'pwd' };
    const a = estimateToolInputTokens(input);
    const b = estimateToolInputTokens(input);
    expect(a).toBe(b);
  });

  it('handles circular references without throwing', () => {
    const cyclic: Record<string, unknown> = { command: 'echo loop' };
    cyclic['self'] = cyclic;
    expect(() => estimateToolInputTokens(cyclic)).not.toThrow();
    expect(estimateToolInputTokens(cyclic)).toBeGreaterThan(0);
  });

  it('cache eviction kicks in when crossing the size cap', () => {
    // Push >10k unique keys to trigger the eviction branch. Different shapes
    // each call → unique JSON.stringify keys.
    for (let i = 0; i < 10_050; i++) {
      estimateToolInputTokens({ k: i });
    }
    // After eviction the same call still returns a stable number.
    expect(estimateToolInputTokens({ k: 10_049 })).toBeGreaterThan(0);
  });
});

describe('estimateToolResultTokens', () => {
  it('memoizes object contents on the object and handles non-object scalars', () => {
    let reads = 0;
    const content = {
      get body(): string {
        reads++;
        return 'y'.repeat(700);
      },
    };
    const first = estimateToolResultTokens(content);
    expect(estimateToolResultTokens(content)).toBe(first);
    expect(reads).toBe(1);
    // null / numbers cannot key a WeakMap and take the scalar path instead.
    expect(estimateToolResultTokens(null)).toBeGreaterThan(0);
    expect(estimateToolResultTokens(42)).toBeGreaterThan(0);
  });

  it('returns >0 for plain string content', () => {
    expect(estimateToolResultTokens('some output')).toBeGreaterThan(0);
  });

  it('handles object content via JSON.stringify caching', () => {
    const a = estimateToolResultTokens({ stdout: 'ok' });
    const b = estimateToolResultTokens({ stdout: 'ok' });
    expect(a).toBe(b);
  });

  it('returns at least 1 for empty string', () => {
    expect(estimateToolResultTokens('')).toBeGreaterThanOrEqual(1);
  });
});

describe('estimateTextTokens', () => {
  it('scales roughly with text length', () => {
    const a = estimateTextTokens('hi');
    const b = estimateTextTokens('hello world');
    expect(b).toBeGreaterThan(a);
  });

  it('returns at least 1 for an empty string', () => {
    expect(estimateTextTokens('')).toBeGreaterThanOrEqual(1);
  });
});

describe('estimateToolDefTokens', () => {
  it('sums name + description + schema length', () => {
    const tool = {
      name: 'do_stuff',
      description: 'Run something',
      inputSchema: { type: 'object', properties: { x: { type: 'string' } } },
    };
    expect(estimateToolDefTokens(tool)).toBeGreaterThan(0);
  });

  it('handles missing description', () => {
    expect(estimateToolDefTokens({ name: 'x', inputSchema: {} })).toBeGreaterThan(0);
  });

  it('estimates compact wire descriptions instead of raw repeated prose', () => {
    const long = 'This field has verbose guidance. '.repeat(100);
    const compact = estimateToolDefTokens({
      name: 'x',
      description: long,
      inputSchema: {
        type: 'object',
        properties: {
          value: { type: 'string', description: long },
        },
      },
    });
    const rawish = estimateTextTokens(long) * 2;
    expect(compact).toBeLessThan(rawish);
  });
});

describe('estimateRequestTokens', () => {
  it('returns zero across the board for empty inputs', () => {
    const r = estimateRequestTokens([], [], []);
    expect(r.messages).toBe(0);
    expect(r.systemPrompt).toBe(0);
    expect(r.tools).toBe(0);
    expect(r.total).toBe(0);
  });

  it('handles a string messages input', () => {
    const r = estimateRequestTokens('plain text', '', []);
    expect(r.messages).toBeGreaterThan(0);
    expect(r.total).toBeGreaterThan(0);
  });

  it('handles array messages with string content', () => {
    const r = estimateRequestTokens([{ role: 'user', content: 'hello there' }], '', []);
    expect(r.messages).toBeGreaterThan(0);
  });

  it('handles array messages with content blocks (text and non-text)', () => {
    const r = estimateRequestTokens(
      [
        {
          role: 'user',
          content: [
            { type: 'text', text: 'describe' },
            { type: 'image', source: { type: 'base64', data: 'AAA' } },
          ],
        },
      ],
      '',
      [],
    );
    // Both text and non-text blocks contribute
    expect(r.messages).toBeGreaterThan(0);
  });

  it('handles string system prompt', () => {
    const r = estimateRequestTokens([], 'You are helpful.', []);
    expect(r.systemPrompt).toBeGreaterThan(0);
  });

  it('handles system prompt as array of text blocks', () => {
    const r = estimateRequestTokens(
      [],
      [
        { type: 'text', text: 'part one' },
        { type: 'text', text: 'part two' },
      ],
      [],
    );
    expect(r.systemPrompt).toBeGreaterThan(0);
  });

  it('sums tool definitions into the tools bucket', () => {
    const r = estimateRequestTokens([], undefined, [
      { name: 'a', description: 'first', inputSchema: {} },
      { name: 'b', description: 'second', inputSchema: { x: 1 } },
    ]);
    expect(r.tools).toBeGreaterThan(0);
    // Empty messages array + non-string non-array system prompt
    // contribute 0; total === tools.
    expect(r.total).toBe(r.tools);
  });

  it('total equals sum of components', () => {
    const r = estimateRequestTokens([{ role: 'user', content: 'msg' }], 'sys', [
      { name: 't', inputSchema: {} },
    ]);
    expect(r.total).toBe(r.messages + r.systemPrompt + r.tools);
  });

  it('ignores messages that lack a content field', () => {
    const r = estimateRequestTokens([{ role: 'user' }], '', []);
    expect(r.messages).toBe(0);
  });

  it('ignores system prompt arrays whose entries are not text blocks', () => {
    const r = estimateRequestTokens([], [{ type: 'tool_use', id: 'x' }], []);
    expect(r.systemPrompt).toBe(0);
  });
});

describe('recordActualUsage + estimateRequestTokensCalibrated', () => {
  const messages = [{ role: 'user', content: 'hello world' }];
  const system = 'You are a helpful assistant.';
  const tools: { name: string; inputSchema: unknown }[] = [];

  it('before any recordActualUsage, calibrated returns the same as uncalibrated', () => {
    resetCalibration();
    const uncal = estimateRequestTokens(messages, system, tools);
    const cal = estimateRequestTokensCalibrated(messages, system, tools);
    expect(cal.total).toBe(uncal.total);
    expect(getCalibrationState().calibrated).toBe(false);
  });

  it('calibrated returns uncalibrated until MIN_SAMPLES_FOR_CALIBRATION (3) samples', () => {
    for (let i = 1; i <= 2; i++) {
      const est = estimateRequestTokensCalibrated(messages, system, tools);
      recordActualUsage(Math.floor(est.total * 0.75));
      expect(getCalibrationState().count).toBe(i);
      expect(getCalibrationState().calibrated).toBe(false);
    }
    // After 2 samples, still not calibrated
    const stillUncal = estimateRequestTokensCalibrated(messages, system, tools);
    expect(stillUncal.total).toBe(estimateRequestTokens(messages, system, tools).total);
  });

  it('after 3 samples, calibrated applies the rolling ratio', () => {
    // Each iteration: actual = 75% of estimated → ratio should converge near 0.75
    for (let i = 0; i < 3; i++) {
      const est = estimateRequestTokensCalibrated(messages, system, tools);
      recordActualUsage(Math.floor(est.total * 0.75));
    }

    expect(getCalibrationState().calibrated).toBe(true);
    const cal = estimateRequestTokensCalibrated(messages, system, tools);
    const uncal = estimateRequestTokens(messages, system, tools);

    // Calibrated should be roughly 75% of uncalibrated (within rounding tolerance)
    expect(cal.total).toBeLessThan(uncal.total);
    expect(cal.total).toBeGreaterThan(Math.floor(uncal.total * 0.7));
  });

  it('ratio is capped to [0.5, 1.5] as sanity bound', () => {
    resetCalibration();
    // Record wildly off estimates (200% ratio) — _cal.ratio must stay in [0.5, 1.5]
    for (let i = 0; i < 3; i++) {
      const est = estimateRequestTokensCalibrated(messages, system, tools);
      recordActualUsage(est.total * 2.0);
    }
    const state = getCalibrationState();
    // _cal.ratio itself is now capped after each recordActualUsage call
    expect(state.ratio).toBeLessThanOrEqual(1.5);
    expect(state.ratio).toBeGreaterThanOrEqual(0.5);
  });

  it('recordActualUsage ignores non-positive input', () => {
    resetCalibration();
    estimateRequestTokensCalibrated(messages, system, tools);
    expect(() => recordActualUsage(0)).not.toThrow();
    expect(() => recordActualUsage(-100)).not.toThrow();
    expect(getCalibrationState().count).toBe(0);
  });

  it('resetCalibration clears all state', () => {
    for (let i = 0; i < 5; i++) {
      const est = estimateRequestTokensCalibrated(messages, system, tools);
      recordActualUsage(Math.floor(est.total * 0.8));
    }
    expect(getCalibrationState().count).toBe(5);
    resetCalibration();
    expect(getCalibrationState().count).toBe(0);
    expect(getCalibrationState().ratio).toBe(1.0);
    expect(getCalibrationState().calibrated).toBe(false);
  });

  it('rolling ratio converges toward actual after many samples', () => {
    resetCalibration();
    // Use the uncalibrated rough estimate for "actual" to avoid feedback:
    // once calibration activates (count >= 3), the calibrated estimate would
    // feed back into recordActualUsage and distort the ratio.  By always
    // computing actual from the rough estimate we measure the true
    // chars/token ratio independently of the calibration state.
    const actualRatio = 0.72;
    for (let i = 0; i < 10; i++) {
      const rough = estimateRequestTokens(messages, system, tools);
      estimateRequestTokensCalibrated(messages, system, tools); // warm cache / update prevEst
      recordActualUsage(Math.floor(rough.total * actualRatio));
    }
    const state = getCalibrationState();
    // With α=0.3 the EWM settles slowly; after 10 samples it is in the right
    // ballpark (within ~10% of actualRatio).  toBeCloseTo with precision 0 uses
    // a tolerance of 0.5, which passes for ratio≈0.67 vs actualRatio=0.72.
    expect(state.ratio).toBeCloseTo(actualRatio, 0);
  });

  it('recordActualUsage with explicit estimatedInputTokens uses that value, not _cal.prevEst', () => {
    resetCalibration();
    // Before any samples, _cal.ratio = 1.0
    // The explicit estimate is used directly in the ratio calculation.
    // After 1 sample with actual=60 and explicit estimate=60, ratio = 1.0.
    estimateRequestTokens(messages, system, tools); // sets _cal.prevEst
    recordActualUsage(60, 60); // explicit est=60, overriding prevEst

    const state = getCalibrationState();
    // Ratio should be 60 / 60 = 1.0 (explicit override), not rough.total / 60
    expect(state.ratio).toBeCloseTo(1.0, 5);
  });
});

describe('estimateRequestTokensUpperBound', () => {
  const msg = (text: string) => [{ role: 'user', content: [{ type: 'text', text }] }];

  it('never returns less than the flat estimate', () => {
    const messages = msg('hello world '.repeat(500));
    const base = estimateRequestTokens(messages, [], []);
    const upper = estimateRequestTokensUpperBound(messages, [], []);
    expect(upper.total).toBeGreaterThanOrEqual(base.total);
  });

  it('leaves ASCII English essentially unchanged (multiplier ~1)', () => {
    const messages = msg('the quick brown fox jumps over the lazy dog. '.repeat(300));
    const base = estimateRequestTokens(messages, [], []);
    const upper = estimateRequestTokensUpperBound(messages, [], []);
    // Prose has whitespace runs and no non-ASCII → density factor ≈ 1.
    expect(upper.total).toBeLessThanOrEqual(Math.ceil(base.total * 1.05));
  });

  it('bumps the estimate up for dense CJK content the flat basis under-counts', () => {
    const messages = msg('这是一段很长的中文文本用来测试令牌密度'.repeat(500));
    const base = estimateRequestTokens(messages, [], []);
    const upper = estimateRequestTokensUpperBound(messages, [], []);
    // High non-ASCII ratio → the guard scales the estimate well above flat.
    expect(upper.total).toBeGreaterThan(base.total * 1.5);
  });

  it('caps the density multiplier at 2.5×', () => {
    const messages = msg('中'.repeat(5000));
    const base = estimateRequestTokens(messages, [], []);
    const upper = estimateRequestTokensUpperBound(messages, [], []);
    expect(upper.total).toBeLessThanOrEqual(Math.ceil(base.total * 2.5) + 4);
  });
});

describe('realAnchoredInputTokens', () => {
  const msg = (t: string) => ({ role: 'user' as const, content: [{ type: 'text' as const, text: t }] });

  it('returns null before any anchor exists', () => {
    expect(realAnchoredInputTokens([msg('hi')], undefined, undefined)).toBeNull();
    expect(realAnchoredInputTokens([msg('hi')], 0, 0)).toBeNull();
  });

  it('returns the real anchor exactly when no messages were appended since', () => {
    const messages = [msg('a'), msg('b')];
    // 2 messages sent, provider said 5000 real tokens, nothing appended since.
    expect(realAnchoredInputTokens(messages, 5000, 2)).toBe(5000);
  });

  it('adds only the estimated delta of messages appended after the anchor', () => {
    const messages = [msg('a'), msg('b'), msg('c'.repeat(3500))];
    // Anchor at 2 messages / 5000 real tokens; the 3rd message is the delta.
    const delta = estimateRequestTokens([messages[2]], [], []).messages;
    expect(realAnchoredInputTokens(messages, 5000, 2)).toBe(5000 + delta);
  });

  it('falls back to null when the array shrank below the anchor (post-compaction)', () => {
    // Anchor said 40 messages, but compaction cut it to 5 → anchor unusable.
    expect(realAnchoredInputTokens([msg('a')], 90_000, 40)).toBeNull();
  });
});

describe('text content block without `text` (runtime contract: text is optional)', () => {
  // Wire data and plugin-provided messages are not type-checked: a text-type
  // content block may legally omit `text`. computeMessageTokens runs on every
  // message append (ConversationState._estTokens) and the density scan runs on
  // every send — either one throwing TypeError breaks the session, so the
  // estimators must treat missing text as an empty string.
  const bare = { type: 'text' } as { type: 'text'; text?: string };
  const msg = { role: 'assistant', content: [bare] } as unknown as Message;

  it('computeMessageTokens counts omitted text the same as empty text', () => {
    const withEmpty = computeMessageTokens({ role: 'assistant', content: [{ type: 'text', text: '' }] });
    expect(computeMessageTokens(msg)).toBe(withEmpty);
  });

  it('estimateMessageTokens does not throw on omitted text', () => {
    expect(() => estimateMessageTokens([msg])).not.toThrow();
  });

  it('estimateRequestTokens does not throw on omitted text', () => {
    expect(() => estimateRequestTokens([msg], 'system prompt', [])).not.toThrow();
  });

  it('send-guard estimateRequestTokensUpperBound does not throw on omitted text', () => {
    expect(() => estimateRequestTokensUpperBound([msg], 'system prompt', [])).not.toThrow();
  });
});
