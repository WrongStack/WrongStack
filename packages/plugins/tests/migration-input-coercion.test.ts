import { describe, expect, it } from 'vitest';
import { resolveMigrationPlanInput } from '../src/migration-planner/migration-plan-input.js';

describe('resolveMigrationPlanInput string validation', () => {
  it('rejects non-string objects and falls back past whitespace-only primary fields', () => {
    expect(() =>
      resolveMigrationPlanInput({
        packageName: { bad: 1 } as never,
        fromVersion: '1.0.0',
        toVersion: '2.0.0',
      }),
    ).toThrow(/required/);

    const res = resolveMigrationPlanInput({
      packageName: '   ',
      package: 'react',
      fromVersion: '18.0.0',
      toVersion: '19.0.0',
    } as never);
    expect(res.packageName).toBe('react');
  });
});
