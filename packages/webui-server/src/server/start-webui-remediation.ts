import { randomUUID } from 'node:crypto';
import type { Context } from '@wrongstack/core/agent';
import type { ToolExecutor } from '@wrongstack/core/execution';
import type { EventBus } from '@wrongstack/core/kernel';
import type { PermissionPolicy } from '@wrongstack/core/types';
import { type PackageOperation, toLanguagePackageInput } from '@wrongstack/techstack';

export function createPackageOperationExecutor(options: {
  toolExecutor: ToolExecutor;
  context: Context;
  events: EventBus;
  permissionPolicy: PermissionPolicy;
}): (operation: PackageOperation, workspace?: string) => Promise<{ detail: string }> {
  const { toolExecutor, context, events, permissionPolicy } = options;
  return async (operation: PackageOperation, workspace?: string) => {
    const input = toLanguagePackageInput(operation, workspace);
    const use = {
      type: 'tool_use' as const,
      id: `techstack-remediation-${randomUUID()}`,
      name: 'language_package',
      input: { ...input },
    };
    const execute = async () => {
      const { outputs } = await toolExecutor.executeBatch([use], context, 'sequential');
      const output = outputs[0];
      if (!output) throw new Error('language_package returned no result');
      return output;
    };
    let output = await execute();
    if (output.result.type === 'tool_confirm_pending') {
      const pending = output.result as any;
      const confirmTool = output.tool;
      if (!confirmTool) throw new Error('Permission confirmation is missing its tool');
      if (events.listenerCount('tool.confirm_needed') === 0) {
        throw new Error('No permission confirmation surface is connected');
      }
      const decision = await new Promise<'yes' | 'no' | 'always' | 'deny'>((resolve) => {
        events.emit('tool.confirm_needed', {
          sessionId: context.session.id,
          tool: confirmTool,
          input: pending.input,
          toolUseId: pending.toolUseId,
          suggestedPattern: pending.suggestedPattern,
          decisionSource: pending.decisionSource,
          riskTier: pending.riskTier,
          boundaryReason: pending.boundaryReason,
          resolve,
        });
      });
      const rule = { tool: 'language_package', pattern: pending.suggestedPattern };
      if (decision === 'always') await permissionPolicy.trust(rule);
      else if (decision === 'yes') permissionPolicy.allowOnce(rule);
      else if (decision === 'deny') await permissionPolicy.deny(rule);
      else permissionPolicy.denyOnce(rule);
      if (decision === 'deny' || decision === 'no') throw new Error('Package operation was denied');
      output = await execute();
    }
    if (output.result.type === 'tool_confirm_pending') {
      throw new Error('Package operation still requires confirmation');
    }
    if (output.result.is_error)
      throw new Error(output.result.content ?? 'Package operation failed');
    return { detail: output.result.content ?? '' };
  };
}
