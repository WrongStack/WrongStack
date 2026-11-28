import { describe, expect, it } from 'vitest';
import { compactAge, markHue, monogram } from '../src/mark-hue';

describe('list marks', () => {
  it('tints a name the same way every time, within the hue circle', () => {
    expect(markHue('WrongStack UI')).toBe(markHue('WrongStack UI'));
    expect(markHue('WrongStack UI')).toBeGreaterThanOrEqual(0);
    expect(markHue('WrongStack UI')).toBeLessThan(360);
  });

  it('takes a whole first grapheme for the monogram', () => {
    expect(monogram('  wrongstack')).toBe('W');
    expect(monogram('𝒜lpha')).toBe('𝒜');
    expect(monogram('')).toBe('?');
  });

  it('says how long ago in one short unit', () => {
    const now = 1_800_000_000_000;
    const say = (unit: string, count: number) => `${count}${unit[0]}`;
    expect(compactAge(now - 20_000, say, now)).toBe('0n');
    expect(compactAge(now - 5 * 60_000, say, now)).toBe('5m');
    expect(compactAge(now - 3 * 3_600_000, say, now)).toBe('3h');
    expect(compactAge(now - 50 * 3_600_000, say, now)).toBe('2d');
    // A clock that runs behind the host never reads as the future.
    expect(compactAge(now + 60_000, say, now)).toBe('0n');
  });
});
