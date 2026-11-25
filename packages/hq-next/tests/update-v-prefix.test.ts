import { describe, expect, it } from 'vitest';
import { updateNotice } from '../src/features/update/model';

describe('updateNotice v-prefix normalization', () => {
  it('returns null when current and latest differ only by a leading v prefix', () => {
    expect(
      updateNotice({ current: 'v1.2.3', latest: '1.2.3', outdated: true, checkFailed: false }),
    ).toBeNull();
    expect(
      updateNotice({ current: '1.2.3', latest: 'v1.2.3', outdated: true, checkFailed: false }),
    ).toBeNull();
    expect(
      updateNotice({ current: 'v1.2.3', latest: '1.3.0', outdated: true, checkFailed: false })
        ?.latest,
    ).toBe('1.3.0');
  });
});
