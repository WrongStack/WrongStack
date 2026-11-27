import { describe, expect, it } from 'vitest';
import { formatCompactBytes } from '../src/components/SystemHealthChip';

const MiB = 1024 ** 2;
const GiB = 1024 ** 3;

describe('formatCompactBytes', () => {
  it('keeps values that do not round up to the next unit', () => {
    expect(formatCompactBytes(512)).toBe('512 B');
    expect(formatCompactBytes(300 * MiB)).toBe('300 MB');
    expect(formatCompactBytes(2 * GiB)).toBe('2.0 GB');
  });

  it('promotes to the next unit when the rounded value reaches 1024', () => {
    // A server RSS just under 1 GiB rendered "RAM 1024 MB".
    expect(formatCompactBytes(GiB - 0.5 * MiB)).toBe('1.0 GB');
    expect(formatCompactBytes(MiB - 512)).toBe('1 MB');
    expect(formatCompactBytes(1023.6)).toBe('1 KB');
  });
});
