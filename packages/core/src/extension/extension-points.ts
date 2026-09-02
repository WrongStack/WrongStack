/**
 * Extension points for the Agent lifecycle.
 *
 * Each extension point is a hook that gets called at a specific phase.
 * Extensions are always optional and failures are isolated — a failing
 * extension never aborts the agent run.
 *
 * Plugins register extensions via `PluginAPI.extensions`, not by
 * directly importing this module. The Agent calls the registry in
 * order at each phase.
 */

import type { RunResult, UserInputPayload } from '../core/agent.js';
import type { Context } from '../core/context.js';
import type { ToolUseBlock } from '../types/blocks.js';
import type { Request, Response } from '../types/provider.js';
import type { ToolExecutionOutput } from '../types/tool-executor.js';

// ── Core lifecycle hooks ────────────────────────────────────────────

/**
 * Called before Agent.run() begins the main iteration loop.
 * Returns `false` or throws to prevent the run from starting.
 */
export type BeforeRunHook = (ctx: Context, input: UserInputPayload) => void | Promise<void>;

/**
 * Called after Agent.run() completes (or fails/aborts).
 * Receives the final RunResult, always called regardless of outcome.
 */
export type AfterRunHook = (ctx: Context, result: RunResult) => void | Promise<void>;

/**
 * Called right before each iteration of the agent loop.
 * The context is live (messages, signal, etc.) and can be inspected.
 * Modifications to ctx (e.g. ctx.messages, ctx.model) take effect
 * for the upcoming iteration.
 */
export type BeforeIterationHook = (ctx: Context, iterationIndex: number) => void | Promise<void>;

/**
 * Called after each iteration completes (tool results appended,
 * compaction done, but before the next loop iteration check).
 */
export type AfterIterationHook = (ctx: Context, iterationIndex: number) => void | Promise<void>;

/**
 * Called when the agent encounters an error during the provider call
 * or tool execution phase. The hook can return a modified context
 * or signal that recovery should be attempted.
 *
 * Return `{ action: 'retry', model?: string | undefined }` to retry the turn
 * (possibly with a different model).
 * Return `{ action: 'fail' }` to propagate the error.
 * Return `{ action: 'continue' }` to skip and continue the loop.
 */
export type OnErrorHook = (
  ctx: Context,
  err: unknown,
  phase: 'provider' | 'tool' | 'agent',
  iterationIndex: number,
) =>
  | { action: 'retry'; model?: string | undefined }
  | { action: 'fail' }
  | { action: 'continue' }
  | void
  | Promise<
      | { action: 'retry'; model?: string | undefined }
      | { action: 'fail' }
      | { action: 'continue' }
      | void
    >;

// ── Provider runner extension ───────────────────────────────────────

/**
 * The default provider runner function signature — what the Agent's
 * built-in provider runner looks like. Extensions that wrap the provider
 * runner receive this as the `inner` parameter they can delegate to.
 */
export type ProviderRunnerFn = (ctx: Context, request: Request) => Promise<Response>;

/**
 * Wrap or replace the provider call in the agent loop.
 *
 * The `inner` function is the default provider runner (with retries).
 * The extension can call it, modify the request/response, add caching,
 * or bypass it entirely.
 */
export type ProviderRunnerWrapper = (
  ctx: Context,
  request: Request,
  inner: ProviderRunnerFn,
) => Promise<Response>;

// ── Tool execution extension ────────────────────────────────────────

/**
 * Called before a batch of tools is executed. Can modify or reject
 * the tool list. Return the (possibly filtered/modified) tool uses.
 */
export type BeforeToolExecutionHook = (
  ctx: Context,
  toolUses: ToolUseBlock[],
) => ToolUseBlock[] | Promise<ToolUseBlock[]>;

/**
 * Called after a batch of tools has been executed and results
 * are available. The extension can inspect or transform results
 * before they're appended to context.
 */
export type AfterToolExecutionHook = (
  ctx: Context,
  outputs: ToolExecutionOutput[],
) => void | Promise<void>;

// ── Aggregate extension type ────────────────────────────────────────

/**
 * An extension registered by a plugin or the host application.
 *
 * Every hook is optional — implement only the phases you need.
 * Hooks are called in registration order. A hook failure is
 * caught, logged, and does not prevent subsequent hooks from running.
 *
 * @example
 * ```ts
 * const myExt: AgentExtension = {
 *   name: 'my-plugin-ext',
 *   beforeIteration: async (ctx, idx) => {
 *     console.log('Starting iteration', idx);
 *   },
 * };
 * api.extensions.register(myExt);
 * ```
 */
export interface AgentExtension {
  /** Unique name for this extension. Used in diagnostics and logging. */
  name: string;
  /** Optional owner tag (plugin name or host identifier). */
  owner?: string | undefined;

  beforeRun?: BeforeRunHook | undefined;
  afterRun?: AfterRunHook | undefined;
  beforeIteration?: BeforeIterationHook | undefined;
  afterIteration?: AfterIterationHook | undefined;
  onError?: OnErrorHook | undefined;
  wrapProviderRunner?: ProviderRunnerWrapper | undefined;
  beforeToolExecution?: BeforeToolExecutionHook | undefined;
  afterToolExecution?: AfterToolExecutionHook | undefined;
}
