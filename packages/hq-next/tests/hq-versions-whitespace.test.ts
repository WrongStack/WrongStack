import type { HqClientRecord } from '@wrongstack/hq';
import { describe, expect, it } from 'vitest';
import { compareVersions, versionDrift } from '../src/features/attention/versions';

describe('attention/versions (F2203)', () => {
  it('trims padded version strings and ignores whitespace-only client versions', () => {
    expect(compareVersions(' 1.2.3 ', '1.2.3')).toBe(0);
    const drift = versionDrift(
      [{ connected: true, version: '   ' } as unknown as HqClientRecord],
      ' 1.2.3 ',
    );
    expect(drift.hub).toBe('1.2.3');
    expect(drift.reporting).toBe(0);
    expect(drift.versions).toEqual([]);
  });
});
