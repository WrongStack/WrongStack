import type { TextBlock } from '@wrongstack/contracts/types';
import type { UserInputPayload } from '@wrongstack/core/agent';
import { PROMPT_JOURNAL_RAW_MARKER, recordPromptJournalEntry } from '@wrongstack/core/prompts';

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
      const raw =
        typeof meta?.[PROMPT_JOURNAL_RAW_MARKER] === 'string'
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

// The toolCall recorder is shared with the standalone engine (desktop/WebUI).
export { createPromptJournalToolCallRecorder } from '@wrongstack/runtime/prompt-journal';
