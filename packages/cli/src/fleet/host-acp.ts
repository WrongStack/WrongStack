import {
  ACP_AGENT_COMMANDS,
  defaultPermissionPolicy,
  findAgentDescriptor,
  makeACPSubagentRunner,
} from '@wrongstack/acp';
import type { SubagentRunner } from '@wrongstack/core/types';
import { ToolValidationError } from '@wrongstack/core/types';

export function buildAcpSubagentRunner(subagentId: string): Promise<SubagentRunner> {
  let cmd = Object.prototype.hasOwnProperty.call(ACP_AGENT_COMMANDS, subagentId)
    ? ACP_AGENT_COMMANDS[subagentId]
    : undefined;
  if (!cmd) {
    const desc = findAgentDescriptor(subagentId);
    if (desc) {
      cmd = {
        command: desc.acp.command,
        args: [...(desc.acp.args ?? [])],
        role: subagentId,
        ...(desc.acp.env ? { env: desc.acp.env } : {}),
      };
    }
  }
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
