import { describe, expect, it } from 'vitest';
import { compareAutonomyTiers, decideOperationAutonomy } from '../src/autonomy-envelope.js';

describe('autonomy-envelope invalid tier fail-closed', () => {
  it('denies operations when envelope tier is unknown', () => {
    expect(compareAutonomyTiers('INVALID' as never, 'A0')).toBeLessThan(0);
    const decision = decideOperationAutonomy(
      {
        tier: 'INVALID_TIER' as never,
        allowedOperations: ['destructive_external'],
        humanApprovalRequiredFor: [],
        allowedPaths: [],
        deniedPaths: [],
        budget: {
          maxChangedFiles: 1,
          maxChangedLines: 1,
          maxNewDependencies: 0,
          maxRetries: 0,
          maxReplans: 0,
          maxSubagents: 0,
          maxWallClockMs: 1000,
        },
        autoAuthorizePlan: false,
        autoReplanLimit: 0,
        autoResolveReviewFixes: false,
      },
      'destructive_external',
    );
    expect(decision.allowed).toBe(false);
    expect(decision.requiresHumanApproval).toBe(true);
  });
});
