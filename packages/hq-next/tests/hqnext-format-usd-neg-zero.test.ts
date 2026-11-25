import { describe, expect, it } from 'vitest';
import { formatUsd } from '../src/hq/lib/format';

describe('formatUsd negative-zero suppression (F2276)', () => {
  it('renders tiny negative amounts that round to zero without a minus sign', () => {
    expect(formatUsd(-0.00001)).toBe('$0.0000');
    expect(formatUsd(-1.25)).toBe('-$1.25');
  });
});
