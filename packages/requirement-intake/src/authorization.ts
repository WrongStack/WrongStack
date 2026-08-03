/**
 * Requirements Intake — authorization.
 *
 * The module enforces authorization through an injected `IntakeAuthorizer`.
 * Hosts wire their own policy (session user, project membership, agent
 * permissions). The service awaits `isAllowed` on every operation and throws
 * `IntakeAuthorizationError` on denial, so a misconfigured host fails closed
 * unless it explicitly installs an allow-all policy.
 */
import type { IntakeContext, RequirementIntakeRecord } from './types.js';

export const INTAKE_OPERATIONS = [
  'create',
  'read',
  'list',
  'update',
  'answer',
  'attach',
  'suggest',
  'accept_suggestion',
  'reject_suggestion',
  'submit',
  'cancel',
  'archive',
] as const;

export type IntakeOperation = (typeof INTAKE_OPERATIONS)[number];

export interface IntakeAuthorizer {
  /**
   * Decide whether `actor` may perform `operation` in `ctx.projectId`,
   * optionally against the target record. May return a Promise for
   * async resolvers. Implementations must deny cross-project access:
   * the record's `projectId` must equal `ctx.projectId`.
   */
  isAllowed(
    operation: IntakeOperation,
    ctx: IntakeContext,
    record?: RequirementIntakeRecord | undefined,
  ): boolean | Promise<boolean>;
}

/** Permissive policy — every operation is allowed. For embedded/single-user hosts. */
export class AllowAllIntakeAuthorizer implements IntakeAuthorizer {
  isAllowed(
    _operation: IntakeOperation,
    _ctx: IntakeContext,
    _record?: RequirementIntakeRecord | undefined,
  ): boolean {
    return true;
  }
}

/** Fail-closed policy — every operation is denied. Default safety net. */
export class DenyAllIntakeAuthorizer implements IntakeAuthorizer {
  isAllowed(
    _operation: IntakeOperation,
    _ctx: IntakeContext,
    _record?: RequirementIntakeRecord | undefined,
  ): boolean {
    return false;
  }
}

export interface ProjectMembershipIntakeAuthorizerOptions {
  /** Resolve which projects an actor belongs to. */
  projectsOf: (
    actorId: string,
    actorType: string,
  ) => Promise<ReadonlySet<string>> | ReadonlySet<string>;
  /** Operations that additionally require the actor to own the record. */
  ownerOnlyOperations?: ReadonlySet<IntakeOperation> | undefined;
}

/**
 * Membership-based policy: an actor may operate on a project only when the
 * `projectsOf` resolver lists it. Cross-project access is always denied.
 * `ownerOnlyOperations` (e.g. `submit`) can additionally require
 * `record.requestedBy === actor.id`.
 */
export class ProjectMembershipIntakeAuthorizer implements IntakeAuthorizer {
  private readonly projectsOf: ProjectMembershipIntakeAuthorizerOptions['projectsOf'];
  private readonly ownerOnly: ReadonlySet<IntakeOperation>;

  constructor(options: ProjectMembershipIntakeAuthorizerOptions) {
    this.projectsOf = options.projectsOf;
    this.ownerOnly = options.ownerOnlyOperations ?? new Set();
  }

  async isAllowed(
    operation: IntakeOperation,
    ctx: IntakeContext,
    record?: RequirementIntakeRecord | undefined,
  ): Promise<boolean> {
    if (record && record.projectId !== ctx.projectId) return false;
    const memberships = await this.projectsOf(ctx.id, ctx.type);
    if (!memberships.has(ctx.projectId)) return false;
    if (this.ownerOnly.has(operation) && record) {
      return record.requestedBy === ctx.id;
    }
    return true;
  }
}
