import {
  ACP_AGENT_COMMANDS,
  findAgentDescriptor,
  makeACPSubagentRunner,
} from '@wrongstack/acp';
import type { SubagentRunner } from '@wrongstack/core/types';
import { ToolValidationError } from '@wrongstack/core/types';

export function buildAcpSubagentRunner(subagentId: string): Promise<SubagentRunner> {
  let cmd = ACP_AGENT_COMMANDS[subagentId];
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
  return makeACPSubagentRunner({ ...cmd });
}
