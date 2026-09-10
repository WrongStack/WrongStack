import { randomUUID } from 'node:crypto';
import type { Context } from '@wrongstack/core/agent';
import { toErrorMessage } from '@wrongstack/core/utils';
import type { BrainArbiter } from '@wrongstack/core/coordination';
import type { ToolExecutor } from '@wrongstack/core/execution';
import type { EventBus } from '@wrongstack/core/kernel';
import type { PermissionPolicy, ToolConfirmPendingResult } from '@wrongstack/core/types';
import { type PackageOperation, toLanguagePackageInput } from '@wrongstack/techstack';

const HUMAN_APPROVAL_TIMEOUT_MS = 120_000;

export function createPackageOperationExecutor(options: {
  toolExecutor: ToolExecutor;
  context: Context;
  events: EventBus;
  permissionPolicy: PermissionPolicy;
  brain?: BrainArbiter | undefined;
}): (operation: PackageOperation, workspace?: string) => Promise<{ detail: string }> {
  const { toolExecutor, context, events, permissionPolicy, brain } = options;
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
      const pending = output.result as ToolConfirmPendingResult;
      const confirmTool = output.tool;
      if (!confirmTool) throw new Error('Permission confirmation is missing its tool');
      if (events.listenerCount('tool.confirm_needed') === 0) {
        throw new Error('No permission confirmation surface is connected');
      }
      const decision = await new Promise<'yes' | 'no' | 'always' | 'deny'>((resolve) => {
        let settled = false;
        const deadlineAt = Date.now() + HUMAN_APPROVAL_TIMEOUT_MS;
        const settle = (choice: 'yes' | 'no' | 'always' | 'deny') => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          resolve(choice);
        };
        const timer = setTimeout(() => {
          void (async () => {
            let choice: 'yes' | 'no' = 'no';
            let rationale = 'No Brain arbiter is available; denied by default.';
            if (brain) {
              try {
                const result = await brain.decide({
                  id: `tool-approval-timeout:${pending.toolUseId}`,
                  sessionId: context.session.id,
                  source: 'tool',
                  question:
                    'The human did not answer within 120 seconds. Should this package operation run once?',
                  context: JSON.stringify({
                    tool: confirmTool.name,
                    suggestedPattern: pending.suggestedPattern,
                    riskTier: pending.riskTier,
                    boundaryReason: pending.boundaryReason,
                  }),
                  options: [
                    { id: 'approve', label: 'Approve this tool call once', risk: 'high' },
                    { id: 'reject', label: 'Reject this tool call', risk: 'low' },
                  ],
                  risk: pending.riskTier === 'destructive' ? 'critical' : 'high',
                  fallback: 'ask_human',
                  allowHumanEscalation: false,
                });
                choice = result.type === 'answer' && result.optionId === 'approve' ? 'yes' : 'no';
                rationale =
                  result.type === 'deny'
                    ? result.reason
                    : result.type === 'answer'
                      ? (result.rationale ?? result.text)
                      : (result.rationale ?? result.prompt);
              } catch (err) {
                // WS-SEC-09: `toErrorMessage` redacts credentials; the
                // hand-inlined form does not. This rationale is surfaced to
                // the user and logged, and the throw came from a provider
                // call, so an error carrying a key would land in both.
                rationale = `Brain approval failed; denied by default: ${toErrorMessage(err)}`;
              }
            }
            if (settled) return;
            events.emit('tool.confirm_resolved', {
              sessionId: context.session.id,
              toolUseId: pending.toolUseId,
              toolName: confirmTool.name,
              decision: choice,
              source: 'brain_timeout',
              rationale,
            });
            settle(choice);
          })();
        }, HUMAN_APPROVAL_TIMEOUT_MS);
        timer.unref?.();
        events.emit('tool.confirm_needed', {
          sessionId: context.session.id,
          tool: confirmTool,
          input: pending.input,
          toolUseId: pending.toolUseId,
          suggestedPattern: pending.suggestedPattern,
          decisionSource: pending.decisionSource,
          riskTier: pending.riskTier,
          boundaryReason: pending.boundaryReason,
          deadlineAt,
          resolve: settle,
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
