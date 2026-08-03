/**
 * Requirements Intake MCP — capability tiers.
 *
 * Mirrors the Kanban MCP policy shape: read-only tooling is always exposed;
 * mutation (filing + submitting intake records) requires the writable tier.
 */

export const REQUIREMENT_INTAKE_READ_TOOLS = ['requirement_intake_list'] as const;

export const REQUIREMENT_INTAKE_WRITE_TOOLS = ['requirement_intake_submit'] as const;

export type RequirementIntakeMcpToolName =
  | (typeof REQUIREMENT_INTAKE_READ_TOOLS)[number]
  | (typeof REQUIREMENT_INTAKE_WRITE_TOOLS)[number];

export interface RequirementIntakeMcpPolicyOptions {
  /** Expose the writable `requirement_intake_submit` tool. Default: read-only. */
  writable?: boolean;
}

export interface RequirementIntakeMcpToolPolicy {
  name: RequirementIntakeMcpToolName;
}

export function selectRequirementIntakeTools(
  opts: RequirementIntakeMcpPolicyOptions = {},
): RequirementIntakeMcpToolPolicy[] {
  const tools: RequirementIntakeMcpToolPolicy[] = [{ name: 'requirement_intake_list' }];
  if (opts.writable === true) {
    tools.push({ name: 'requirement_intake_submit' });
  }
  return tools;
}
