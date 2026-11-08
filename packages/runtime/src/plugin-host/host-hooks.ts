import type { Config, Logger, TextBlock } from '@wrongstack/contracts/types';
import type { AgentPipelines, UserInputPayload } from '@wrongstack/core/agent';
import type { AgentExtension } from '@wrongstack/core/extension';
import { countShellHooks, HookRegistry, HookRunner, shellHooksEqual } from '@wrongstack/core/hooks';

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
 * One instance per agent: the "first run" flag is that agent's.
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

export interface HostHooksOptions {
  /** The boot config; its `hooks` block is loaded into the registry. */
  config: Pick<Config, 'hooks'>;
  /**
   * False under `--no-hooks` / `--safe-mode`: only `policy: true` shell hooks
   * load, and the runner skips every non-policy entry (plugin hooks included).
   */
  hooksEnabled: boolean;
  /** Receives the UserPromptSubmit middleware (after any journal recorder). */
  pipelines: Pick<AgentPipelines, 'userInput'>;
  logger: Logger;
  /** Active session id for the `HookInput` payload. */
  sessionId: () => string;
  /** Hot-reloads `config.hooks`. Omitted: the boot hooks stay until restart. */
  configStore?:
    | { watch(cb: (next: Readonly<Config>, prev: Readonly<Config>) => void): () => void }
    | undefined;
}

export interface HostHooks {
  /** User shell hooks plus whatever plugins and the host register in-process. */
  hookRegistry: HookRegistry;
  /** The runner the host's tool executor and lifecycle extensions call. */
  hookRunner: HookRunner;
  /** Stops the `config.hooks` hot-reload watch. */
  dispose(): void;
}

/**
 * The user's `config.hooks`, as every host loads them: one registry, one
 * runner gated by `hooksEnabled`, the UserPromptSubmit interception point on
 * `pipelines.userInput`, and hot-reload when the hooks block changes.
 *
 * `--no-hooks` disables ordinary automation, not trusted enforcement:
 * explicit `policy: true` hooks stay active and never ask for approval; they
 * only allow/mutate silently or deny with a model-visible reason. The
 * dispatch point is installed even with hooks off, because policy hooks may
 * be registered later by a plugin and still need a live UserPromptSubmit
 * interception point.
 *
 * Callers that journal raw prompts install that recorder on `userInput`
 * BEFORE calling this: a blocking hook short-circuits the chain, so a
 * recorder after it would miss the prompt (and an allowed hook's
 * additionalContext would leak into the journal as submitted input).
 *
 * Project-level config never reaches here with hooks in it: the in-project
 * `.wrongstack/config.json` layer is untrusted and its `hooks` are stripped
 * at load (`stripUnsafeInProjectFields`), on every host.
 */
export function installHostHooks(options: HostHooksOptions): HostHooks {
  const { hooksEnabled, logger } = options;
  const hookRegistry = new HookRegistry();
  hookRegistry.loadShellHooks(options.config.hooks, { policyOnly: !hooksEnabled });
  const hookRunner = new HookRunner({
    registry: hookRegistry,
    logger,
    allowNonPolicy: hooksEnabled,
    sessionId: options.sessionId,
  });
  options.pipelines.userInput.use(createUserPromptSubmitMiddleware(hookRunner));

  // Hot-reload configured hooks, preserving the --no-hooks policy filter.
  const unwatch = options.configStore?.watch((next, prev) => {
    if (shellHooksEqual(next.hooks, prev.hooks)) return;
    try {
      hookRegistry.replaceShellHooks(next.hooks, { policyOnly: !hooksEnabled });
      logger.info(
        `Hooks reloaded (${countShellHooks(next.hooks)} configured entries across ${
          Object.keys(next.hooks ?? {}).length
        } events)`,
      );
    } catch (err) {
      logger.warn(`Hook hot-reload failed: ${(err as Error).message ?? String(err)}`);
    }
  });
  return {
    hookRegistry,
    hookRunner,
    dispose: () => {
      unwatch?.();
    },
  };
}
