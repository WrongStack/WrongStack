import type { UserInputPayload } from '@wrongstack/core/agent';
import type { AgentExtension } from '@wrongstack/core/extension';
import type { HookRunner } from '@wrongstack/core/hooks';
import type { TextBlock } from '@wrongstack/core/types';

/** Raised by the UserPromptSubmit middleware to block a turn before it runs. */
export class HookBlockedError extends Error {
  constructor(reason: string) {
    super(`Prompt blocked by hook: ${reason}`);
    this.name = 'HookBlockedError';
  }
}

interface UserInputMiddleware {
  name: string;
  handler: (
    payload: UserInputPayload,
    next: (v: UserInputPayload) => Promise<UserInputPayload>,
  ) => Promise<UserInputPayload>;
}

/**
 * `userInput` pipeline middleware for `UserPromptSubmit` hooks. A `block`
 * outcome throws `HookBlockedError`, which the userInput pipeline's
 * (core-owned) error boundary rethrows — propagating to `Agent.run` so the
 * turn ends without a model call. `additionalContext` is appended to the user
 * message. Owner is left unset so the boundary treats it as core (rethrow).
 */
export function createUserPromptSubmitMiddleware(hookRunner: HookRunner): UserInputMiddleware {
  return {
    name: 'UserPromptSubmitHooks',
    handler: async (payload, next) => {
      const prompt = payload.text;
      if (prompt && hookRunner.has('UserPromptSubmit')) {
        const r = await hookRunner.userPromptSubmit(prompt, payload.ctx);
        if (r.block) throw new HookBlockedError(r.reason ?? 'no reason given');
        if (r.additionalContext) {
          const block: TextBlock = { type: 'text', text: r.additionalContext };
          payload.content = [...payload.content, block];
          payload.text = `${prompt}\n\n${r.additionalContext}`;
        }
      }
      return next(payload);
    },
  };
}

/**
 * Agent extension for the `SessionStart` and `Stop` lifecycle hooks.
 * `SessionStart` fires once on the first run of the session; its
 * `additionalContext` is appended to `ctx.systemPrompt` as a one-time text
 * block (persists for the session). `Stop` fires at the end of every turn.
 */
export function createLifecycleHooksExtension(hookRunner: HookRunner): AgentExtension {
  let started = false;
  return {
    name: 'lifecycle-hooks',
    beforeRun: async (ctx) => {
      if (started) return;
      started = true;
      if (!hookRunner.has('SessionStart')) return;
      const r = await hookRunner.sessionStart(ctx);
      if (r.additionalContext) {
        ctx.systemPrompt.push({ type: 'text', text: r.additionalContext });
      }
    },
    afterRun: async (ctx) => {
      if (hookRunner.has('Stop')) await hookRunner.stop(ctx);
    },
  };
}
