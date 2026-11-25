import { describe, expect, it } from 'vitest';
import { toolDisplayName } from '../src/hq/domain/transcript-format';

describe('toolDisplayName blank name guard (F2280)', () => {
  it('returns "tool" for whitespace-only tool names and trims valid names', () => {
    expect(toolDisplayName('   ')).toBe('tool');
    expect(toolDisplayName(' mcp__git__status ')).toBe('git:status');
  });
});
