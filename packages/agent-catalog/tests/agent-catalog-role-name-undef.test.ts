import { describe, expect, it } from 'vitest';
import { isProjectAgentRoleName } from '../src/project-agent-paths.js';

describe('isProjectAgentRoleName non-string guard (F2268)', () => {
  it('returns false for non-string inputs instead of coercing undefined to "undefined"', () => {
    expect(isProjectAgentRoleName(undefined as unknown as string)).toBe(false);
    expect(isProjectAgentRoleName('reviewer')).toBe(true);
  });
});
