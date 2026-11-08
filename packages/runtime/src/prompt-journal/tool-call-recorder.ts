import type { ToolCallPipelinePayload } from '@wrongstack/core/agent';
import { type PromptCategory, recordPromptJournalEntry } from '@wrongstack/core/prompts';

/**
 * toolCall-pipeline middleware that records the agent-driven journal
 * categories — `clarify_interaction`, `subagent_delegation` and
 * `autonomous_next_step` — by recognising the tools that produce them.
 *
 * This complements the userInput recorder (raw/refined/system prompts) so the
 * journal captures more than user submissions. Every executed tool call flows
 * through the `toolCall` pipeline (`agent-tools.ts`), so one middleware sees
 * all three emission points:
 *
 *   - `clarify`                  → `clarify_interaction`  (content: question)
 *   - `delegate`                 → `subagent_delegation`  (content: task)
 *   - `continue_to_next_iteration` → `autonomous_next_step` (content: marker)
 *
 * Best-effort by design, same as the userInput recorder: writes are
 * fire-and-forget and failures are swallowed.
 */
export interface PromptJournalToolCallRecorder {
  name: string;
  handler: (
    payload: ToolCallPipelinePayload,
    next: (v: ToolCallPipelinePayload) => Promise<ToolCallPipelinePayload>,
  ) => Promise<ToolCallPipelinePayload>;
}

const TOOL_CATEGORY: Readonly<Record<string, PromptCategory>> = {
  clarify: 'clarify_interaction',
  delegate: 'subagent_delegation',
  continue_to_next_iteration: 'autonomous_next_step',
};

export function createPromptJournalToolCallRecorder(): PromptJournalToolCallRecorder {
  return {
    name: 'PromptJournalToolCallRecorder',
    async handler(payload, next) {
      const ctx = payload.ctx;
      const projectRoot = ctx.projectRoot;
      const toolName = payload.toolUse?.name;
      const category = toolName ? TOOL_CATEGORY[toolName] : undefined;
      if (projectRoot && category) {
        const input = payload.toolUse.input as Record<string, unknown> | undefined;
        const sessionId = ctx.session?.id ?? ctx.activeRunSessionId ?? 'general';
        const common = {
          projectRoot,
          sessionId,
          model: ctx.model,
          provider: ctx.provider?.id,
          activeTools: ctx.tools?.map((tool) => tool.name) ?? [],
        };
        let content = '';
        let decisionReason: string | undefined;
        if (toolName === 'clarify') {
          content = typeof input?.question === 'string' ? input.question : '';
          decisionReason = typeof input?.context === 'string' ? input.context : undefined;
        } else if (toolName === 'delegate') {
          content = typeof input?.task === 'string' ? input.task : '';
          decisionReason =
            typeof input?.role === 'string'
              ? `delegated to ${input.role}`
              : typeof input?.name === 'string'
                ? `delegated to ${input.name}`
                : undefined;
        } else {
          content = 'Autonomous continue to the next iteration';
        }
        if (content.trim()) {
          void recordPromptJournalEntry({
            ...common,
            category,
            content,
            decisionReason,
          }).catch(() => {});
        }
      }
      return next(payload);
    },
  };
}
