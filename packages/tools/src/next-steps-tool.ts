import {
  MAX_PENDING_NEXT_STEPS,
  type PendingNextStep,
  writePendingNextSteps,
} from '@wrongstack/core/agent';
import type { Tool } from '@wrongstack/core/types';

/**
 * Structured alternative to typing a `<nextsteps>` block into the final message.
 *
 * Both routes are equally valid and produce the same result — the runtime folds
 * whatever this tool parks into the turn-ending response (see
 * `next-steps-slot.ts` in core), so every surface reads it through the same
 * parser it already uses. What the tool buys is that the schema enforces the
 * shape: a block cannot arrive unbalanced, `auto` cannot land on the wrong
 * item, and item count cannot drift past the contract.
 *
 * Opt-in via `tools.nextsteps.enabled`; registered for the leader only.
 */

export interface NextStepsInput {
  steps: Array<{ text: string; auto?: boolean }>;
}

export interface NextStepsOutput {
  accepted: number;
  auto: boolean;
}

export const nextStepsTool: Tool<NextStepsInput, NextStepsOutput> = {
  name: 'nextsteps',
  category: 'Session',
  description:
    'Record the after-task follow-on suggestions for this turn. Equivalent to ending your final ' +
    'message with a <nextsteps> block — use whichever you prefer. The list is fully replaced on ' +
    'every call (not appended).',
  usageHint:
    'Call this at most once, on the turn you are finishing the work — not mid-task.\n' +
    '- Each `text` is the **exact prompt message** that gets submitted back to you when the user picks it. Write agent-directed work ("Run the parser tests and fix any failures"), never a chore for the user to do by hand.\n' +
    '- Order by priority; 1-4 items. Do not pad with filler or invent work to fill the list.\n' +
    '- `auto: true` is honored on the first item only. Set it when that prompt is safe to run unattended — YOLO+auto executes it verbatim, so it must be complete and self-contained.\n' +
    '- Omit the call entirely while any todo is still `pending` or `in_progress`; suggestions recorded in that state are discarded.\n' +
    '- If you also write a <nextsteps> block in your message, that block wins.',
  permission: 'auto',
  mutating: false, // mutates only turn-scoped conversation state — no confirmation needed
  timeoutMs: 5_000,
  capabilities: ['session.nextsteps'],
  icon: 'todo',
  inputSchema: {
    type: 'object',
    properties: {
      steps: {
        type: 'array',
        minItems: 1,
        maxItems: MAX_PENDING_NEXT_STEPS,
        items: {
          type: 'object',
          properties: {
            text: {
              type: 'string',
              description:
                'The exact natural-language prompt message to submit back to the agent when the user selects this item.',
            },
            auto: {
              type: 'boolean',
              description:
                'Safe to run unattended. Honored on the first item only; ignored elsewhere.',
            },
          },
          required: ['text'],
        },
        description: `The complete suggestion list (1-${MAX_PENDING_NEXT_STEPS} items), highest priority first. Replaces any previous list for this turn.`,
      },
    },
    required: ['steps'],
  },
  async execute(input, ctx) {
    if (!Array.isArray(input?.steps)) {
      throw new Error('nextsteps: steps must be an array');
    }
    const steps: PendingNextStep[] = input.steps
      .filter((s): s is { text: string; auto?: boolean } => typeof s?.text === 'string')
      .map((s) => (s.auto === true ? { text: s.text, auto: true } : { text: s.text }));

    if (steps.length === 0) {
      throw new Error('nextsteps: steps must contain at least one item with a non-empty text');
    }

    // The slot does the trimming, the 1-item-only `auto` rule, and the cap, so
    // the same normalization applies no matter who writes to it.
    writePendingNextSteps(ctx, steps);

    const accepted = Math.min(steps.length, MAX_PENDING_NEXT_STEPS);
    return { accepted, auto: steps[0]?.auto === true };
  },
};
