import type { HqMcpHealthCheck } from '@wrongstack/hq';
import { describe, expect, it } from 'vitest';
import { checkValue, formatMs } from '../src/features/mcp/model';

describe('MCP model formatting guards', () => {
  it('returns em-dash for non-finite counts and negative durations', () => {
    expect(
      checkValue({ name: 'in-flight-calls', passed: true } as HqMcpHealthCheck, Number.NaN),
    ).toBe('—');
    expect(formatMs(-50)).toBe('—');
    expect(formatMs(250)).toBe('250 ms');
  });
});
