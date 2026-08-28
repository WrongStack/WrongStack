export const AUTONOMY_TIERS = ['A0', 'A1', 'A2', 'A3', 'A4'] as const;

export type AutonomyTier = (typeof AUTONOMY_TIERS)[number];

export const GOVERNED_OPERATIONS = [
  'repository_read',
  'file_edit',
  'focused_check',
  'shell_restricted',
  'subagent_spawn',
  'git_local_write',
  'shell_arbitrary',
  'package_install',
  'public_api_change',
  'schema_change',
  'network_access',
  'secret_access',
  'git_push',
  'publish',
  'deploy',
  'destructive_external',
] as const;

export type GovernedOperation = (typeof GOVERNED_OPERATIONS)[number];

interface ChangeBudget {
  readonly maxChangedFiles: number;
  readonly maxChangedLines: number;
  readonly maxNewDependencies: number;
  readonly maxRetries: number;
  readonly maxReplans: number;
  readonly maxSubagents: number;
  readonly maxWallClockMs: number;
}

export interface AutonomyEnvelope {
  readonly tier: AutonomyTier;
  readonly allowedOperations: readonly GovernedOperation[];
  readonly humanApprovalRequiredFor: readonly GovernedOperation[];
  readonly allowedPaths: readonly string[];
  readonly deniedPaths: readonly string[];
  readonly budget: ChangeBudget;
  readonly autoAuthorizePlan: boolean;
  readonly autoReplanLimit: number;
  readonly autoResolveReviewFixes: boolean;
}

export type OperationAutonomyDecision =
  | {
      readonly allowed: true;
      readonly requiresHumanApproval: false;
      readonly operation: GovernedOperation;
      readonly minimumTier: AutonomyTier;
    }
  | {
      readonly allowed: false;
      readonly requiresHumanApproval: true;
      readonly operation: GovernedOperation;
      readonly minimumTier: AutonomyTier;
      readonly reason: 'operation_not_allowed' | 'explicit_approval_required' | 'tier_exceeded';
    };

const TIER_RANK: Readonly<Record<AutonomyTier, number>> = {
  A0: 0,
  A1: 1,
  A2: 2,
  A3: 3,
  A4: 4,
};

export const OPERATION_MINIMUM_TIER: Readonly<Record<GovernedOperation, AutonomyTier>> = {
  repository_read: 'A0',
  file_edit: 'A1',
  focused_check: 'A1',
  shell_restricted: 'A1',
  subagent_spawn: 'A2',
  git_local_write: 'A2',
  shell_arbitrary: 'A3',
  package_install: 'A3',
  public_api_change: 'A3',
  schema_change: 'A3',
  network_access: 'A3',
  secret_access: 'A4',
  git_push: 'A4',
  publish: 'A4',
  deploy: 'A4',
  destructive_external: 'A4',
};

export function compareAutonomyTiers(left: AutonomyTier, right: AutonomyTier): number {
  return TIER_RANK[left] - TIER_RANK[right];
}

export function decideOperationAutonomy(
  envelope: AutonomyEnvelope,
  operation: GovernedOperation,
): OperationAutonomyDecision {
  const minimumTier = OPERATION_MINIMUM_TIER[operation];

  if (!envelope.allowedOperations.includes(operation)) {
    return {
      allowed: false,
      requiresHumanApproval: true,
      operation,
      minimumTier,
      reason: 'operation_not_allowed',
    };
  }

  if (envelope.humanApprovalRequiredFor.includes(operation)) {
    return {
      allowed: false,
      requiresHumanApproval: true,
      operation,
      minimumTier,
      reason: 'explicit_approval_required',
    };
  }

  if (compareAutonomyTiers(envelope.tier, minimumTier) < 0) {
    return {
      allowed: false,
      requiresHumanApproval: true,
      operation,
      minimumTier,
      reason: 'tier_exceeded',
    };
  }

  return {
    allowed: true,
    requiresHumanApproval: false,
    operation,
    minimumTier,
  };
}
