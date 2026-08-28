import {
  PROMPT_JOURNAL_RAW_MARKER,
  recordPromptJournalEntry,
  type PromptCategory,
} from '@wrongstack/core/prompts';
import type { ToolCallPipelinePayload, UserInputPayload } from '@wrongstack/core/agent';
import type { TextBlock } from '@wrongstack/core/types';

/**
 * userInput-pipeline middleware that records every submitted user prompt into
 * the project's hierarchical prompt journal (`<projectRoot>/.wrongstack/prompts/`).
 *
 * The TUI's submit path stamps the raw (unrefined) text under
 * `ctx.meta[PROMPT_JOURNAL_RAW_MARKER]` when the refiner rewrote the prompt;
 * this middleware consumes the marker and labels the turn `refined_user` with
 * `rawContent` set. Unmarked turns are `raw_user`. The session's system prompt
 * is recorded once per session as `system_prompt`.
 *
 * Best-effort by design: recording must never block or fail a turn, so writes
 * are fire-and-forget and failures are swallowed (the core writer already
 * treats journal I/O as non-fatal).
 */

// Re-export so the marker key stays importable from this module (the CLI test
// and any host-side stamp sites use it); the authoritative definition lives in
// @wrongstack/core/prompts so the TUI and the CLI cannot drift.
export { PROMPT_JOURNAL_RAW_MARKER };

export interface PromptJournalRecorder {
  name: string;
  handler: (
    payload: UserInputPayload,
    next: (v: UserInputPayload) => Promise<UserInputPayload>,
  ) => Promise<UserInputPayload>;
}

function systemPromptText(blocks: readonly TextBlock[] | undefined): string {
  if (!blocks || blocks.length === 0) return '';
  return blocks
    .map((block) => (block.type === 'text' ? block.text : ''))
    .filter((text) => text.trim().length > 0)
    .join('\n')
    .trim();
}

export function createPromptJournalRecorder(): PromptJournalRecorder {
  const systemPromptRecorded = new Set<string>();
  return {
    name: 'PromptJournalRecorder',
    async handler(payload, next) {
      const ctx = payload.ctx;
      const meta = ctx.meta as Record<string, unknown> | undefined;
      // Consume the raw marker up front so a stale stamp from an aborted turn
      // can never mislabel a later submission.
      const raw = typeof meta?.[PROMPT_JOURNAL_RAW_MARKER] === 'string'
        ? (meta[PROMPT_JOURNAL_RAW_MARKER] as string)
        : undefined;
      if (meta) delete meta[PROMPT_JOURNAL_RAW_MARKER];

      const projectRoot = ctx.projectRoot;
      const text = payload.text.trim();
      if (projectRoot && text) {
        const sessionId = ctx.session?.id ?? ctx.activeRunSessionId ?? 'general';
        const common = {
          projectRoot,
          sessionId,
          model: ctx.model,
          provider: ctx.provider?.id,
          activeTools: ctx.tools?.map((tool) => tool.name) ?? [],
        };

        if (raw !== undefined && raw !== text) {
          void recordPromptJournalEntry({
            ...common,
            category: 'refined_user',
            content: text,
            rawContent: raw,
          }).catch(() => {});
        } else {
          void recordPromptJournalEntry({
            ...common,
            category: 'raw_user',
            content: text,
          }).catch(() => {});
        }

        if (!systemPromptRecorded.has(sessionId)) {
          systemPromptRecorded.add(sessionId);
          const systemText = systemPromptText(ctx.systemPrompt);
          if (systemText) {
            void recordPromptJournalEntry({
              ...common,
              category: 'system_prompt',
              content: systemText,
            }).catch(() => {});
          }
        }
      }

      return next(payload);
    },
  };
}

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
interface PromptJournalToolCallRecorder {
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
