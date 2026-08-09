import { afterEach, describe, expect, it } from 'vitest';
import { configureGoalPolicy, isGoalCommandAllowed, resetGoalPolicy } from '../src/goal-host.js';

describe('goal command policy', () => {
  afterEach(() => resetGoalPolicy());

  it('ships only the narrow package-manager base by default', () => {
    for (const cmd of ['pnpm', 'npm', 'yarn', 'bun']) {
      expect(isGoalCommandAllowed(cmd)).toBe(true);
    }
    // Build tools are NOT in the base — goal runs without confirmation, so
    // it must not autonomously run arbitrary build scripts unless opted in.
    for (const cmd of ['go', 'cargo', 'make', 'dotnet']) {
      expect(isGoalCommandAllowed(cmd)).toBe(false);
    }
  });

  it('extends the base with the user explicit exec.allow opt-ins', () => {
    configureGoalPolicy({ allow: ['go', 'cargo'] });
    expect(isGoalCommandAllowed('go')).toBe(true);
    expect(isGoalCommandAllowed('cargo')).toBe(true);
    expect(isGoalCommandAllowed('pnpm')).toBe(true); // base preserved
    expect(isGoalCommandAllowed('make')).toBe(false); // not opted in
  });

  it('honors deny (can remove even a base command)', () => {
    configureGoalPolicy({ allow: ['go'], deny: ['bun'] });
    expect(isGoalCommandAllowed('go')).toBe(true);
    expect(isGoalCommandAllowed('bun')).toBe(false);
  });

  it('is rebuilt from the base each call (not cumulative)', () => {
    configureGoalPolicy({ allow: ['go'] });
    expect(isGoalCommandAllowed('go')).toBe(true);
    configureGoalPolicy({}); // no allow → go gone again
    expect(isGoalCommandAllowed('go')).toBe(false);
    expect(isGoalCommandAllowed('pnpm')).toBe(true);
  });

  it('resetGoalPolicy restores the base', () => {
    configureGoalPolicy({ allow: ['go'], deny: ['pnpm'] });
    resetGoalPolicy();
    expect(isGoalCommandAllowed('go')).toBe(false);
    expect(isGoalCommandAllowed('pnpm')).toBe(true);
  });
});
