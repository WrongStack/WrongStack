import { describe, expect, it } from 'vitest';
import { estimateTextTokens } from '../../src/utils/token-estimate.js';
import { sizeSignals } from '../../src/utils/tool-output-serializer.js';

/**
 * `sizeSignals` documents "tokens: standard ~3.5 chars/token heuristic", and
 * the chip beside every tool result plus the model-facing context-evidence
 * digest read this number. It used UTF-8 BYTES with `Math.round`, so short
 * ASCII under-counted ("abcd" → 1 instead of 2) and CJK over-counted
 * ("東京" → 2 instead of 1) relative to every other token estimate.
 *
 * Regression: the token signal must be the canonical chars-based estimate.
 */
describe('sizeSignals token estimate', () => {
  it('matches the canonical chars-based estimator for ASCII, CJK and emoji', () => {
    for (const content of ['abcd', '東京', 'fix 東京 bug', '🙂🙂', 'a'.repeat(100)]) {
      expect(sizeSignals('bash', content).outputTokens).toBe(estimateTextTokens(content));
    }
  });

  it('keeps the byte and line signals on their own definitions', () => {
    expect(sizeSignals('bash', '東京').outputBytes).toBe(Buffer.byteLength('東京', 'utf8'));
    expect(sizeSignals('read', '1→a\n2→b').outputLines).toBe(2);
    expect(sizeSignals('bash', 'a\nb').outputLines).toBe(2);
    expect(sizeSignals('read', '')).toEqual({
      outputBytes: 0,
      outputTokens: 0,
      outputLines: undefined,
    });
  });
});
