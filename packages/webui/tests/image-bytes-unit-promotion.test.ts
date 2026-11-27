import { describe, expect, it } from 'vitest';
import { formatImageBytes } from '../src/lib/project-image';

describe('formatImageBytes', () => {
  it('keeps values that do not round up to the next unit', () => {
    expect(formatImageBytes(undefined)).toBe('');
    expect(formatImageBytes(512)).toBe('512 B');
    expect(formatImageBytes(12_595)).toBe('12.3 KiB');
    expect(formatImageBytes(3 * 1024 * 1024)).toBe('3.0 MiB');
  });

  it('promotes to MiB when the rounded KiB value reaches 1024', () => {
    // 1_048_575 B rendered "1024.0 KiB".
    expect(formatImageBytes(1_048_575)).toBe('1.0 MiB');
    expect(formatImageBytes(1_048_525)).toBe('1.0 MiB');
    expect(formatImageBytes(1_048_473)).toBe('1023.9 KiB');
  });
});
