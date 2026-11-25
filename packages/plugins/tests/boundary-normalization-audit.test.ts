import { describe, expect, it } from 'vitest';
import { sanitizePolicyText } from '../src/adversary-mode/policy.js';
import { extractErrorLine, extractFrames } from '../src/error-lens/index.js';
import { analyzeEvidence, type EvidenceAnalyzerProfile } from '../src/evidence-analyzer/index.js';
import { extractToolContent } from '../src/injection-shield/index.js';
import { DesktopNotifier, toastText } from '../src/notify-hub/desktop-notifier.js';
import { readConfig as readRecapConfig } from '../src/session-recap/index.js';
import { topN, truncate } from '../src/session-recap/recap-format.js';

function hasLoneSurrogate(value: string): boolean {
  for (let index = 0; index < value.length; index++) {
    const unit = value.charCodeAt(index);
    if (unit >= 0xd800 && unit <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return true;
      index++;
    } else if (unit >= 0xdc00 && unit <= 0xdfff) return true;
  }
  return false;
}

const profile: EvidenceAnalyzerProfile = {
  name: 'probe',
  toolName: 'probe',
  description: 'probe',
  evidenceHint: 'probe',
  rules: [{ label: 'hit', severity: 'error', pattern: /HIT/, advice: 'x' }],
};

describe('plugin boundary normalization audit regressions', () => {
  it('falls back for non-finite session recap transcript limits', () => {
    expect(
      readRecapConfig({ includeTranscriptTail: Number.POSITIVE_INFINITY }).includeTranscriptTail,
    ).toBe(3);
  });

  it('falls back for non-finite session recap body limits', () => {
    expect(readRecapConfig({ maxBodyChars: Number.POSITIVE_INFINITY }).maxBodyChars).toBe(8_000);
  });

  it('does not split surrogate pairs in recap truncation', () => {
    expect(hasLoneSurrogate(truncate(`${'a'.repeat(99)}😀`, 100))).toBe(false);
  });

  it('keeps the complete recap including its notice within the requested bound', () => {
    expect(truncate('x'.repeat(200), 100).length).toBeLessThanOrEqual(100);
  });

  it('treats a negative top-N limit as zero', () => {
    expect(
      topN(
        new Map([
          ['a', 1],
          ['b', 2],
        ]),
        -1,
      ),
    ).toEqual([]);
  });

  it('does not split surrogate pairs in desktop toast text', () => {
    expect(hasLoneSurrogate(toastText(`${'a'.repeat(98)}😀xx`, 100))).toBe(false);
  });

  it('treats a non-finite toast bound as zero', () => {
    expect(toastText('abc', Number.NaN)).toBe('');
  });

  it('falls back from a non-finite desktop notification interval', () => {
    let calls = 0;
    const exec = (() => {
      calls++;
      return { on() {} };
    }) as never;
    const notifier = new DesktopNotifier({ platform: 'linux', minIntervalMs: Number.NaN, exec });
    notifier.notify('same', 'a', 'b', 1);
    notifier.notify('same', 'a', 'b', 1);
    expect(calls).toBe(1);
  });

  it('does not split surrogate pairs in extracted error lines', () => {
    expect(hasLoneSurrogate(extractErrorLine(`Error: ${'a'.repeat(292)}😀tail`) ?? '')).toBe(false);
  });

  it('treats a negative frame limit as zero', () => {
    expect(extractFrames('at fn (src/a.ts:1:1)\nat fn (src/b.ts:2:1)', -1)).toEqual([]);
  });

  it('does not split surrogate pairs in sanitized adversary policy text', () => {
    expect(hasLoneSurrogate(sanitizePolicyText(`${'a'.repeat(99)}😀`, 100))).toBe(false);
  });

  it('treats a negative adversary policy bound as zero', () => {
    expect(sanitizePolicyText('abc', -1)).toBe('');
  });

  it('does not split surrogate pairs in extracted tool content', () => {
    expect(hasLoneSurrogate(extractToolContent(`${'a'.repeat(99)}😀`, 100))).toBe(false);
  });

  it('treats a NaN tool-content bound as zero', () => {
    expect(extractToolContent('abc', Number.NaN)).toBe('');
  });

  it('does not split surrogate pairs in evidence excerpts', () => {
    const result = analyzeEvidence(`${'a'.repeat(239)}😀 HIT`, profile, 1);
    expect(hasLoneSurrogate(result.findings[0]?.excerpt ?? '')).toBe(false);
  });

  it('honors a zero evidence finding cap', () => {
    expect(analyzeEvidence('HIT', profile, 0).findings).toEqual([]);
  });
});
