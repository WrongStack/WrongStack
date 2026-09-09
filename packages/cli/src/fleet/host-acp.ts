import {
  type AcpAgentCommandOverrides,
  type AcpLiveCatalog,
  defaultPermissionPolicy,
  makeACPSubagentRunner,
  resolveAcpAgentCommand,
} from '@wrongstack/acp';
import type { SubagentRunner } from '@wrongstack/core/types';
import { ToolValidationError } from '@wrongstack/core/types';

export interface BuildAcpSubagentRunnerOptions {
  overrides?: AcpAgentCommandOverrides | undefined;
  live?: AcpLiveCatalog | undefined;
}

/**
 * Same command resolution as `wstack acp spawn` / `/acp` — user override,
 * bundled catalog, synced registry, then the legacy map. Director / `--bg`
 * must not use a different argv than the CLI spawn path.
 */
export function buildAcpSubagentRunner(
  subagentId: string,
  options?: BuildAcpSubagentRunnerOptions,
): Promise<SubagentRunner> {
  const cmd = resolveAcpAgentCommand(subagentId, options?.overrides, options?.live);
  if (!cmd) {
    throw new ToolValidationError({
      message: `Unknown ACP agent: ${subagentId}`,
      field: 'subagentId',
      context: { requested: subagentId },
    });
  }
  // CLI /spawn and Director fan-out are trusted local agents (see
  // host-acp-runner-cache.ts) — pass the auto-approve policy explicitly.
  // Without it ACPSession falls back to readOnlyPermissionPolicy and
  // denies every file write / command the subagent requests.
  return makeACPSubagentRunner({ ...cmd, permissionPolicy: defaultPermissionPolicy });
}
