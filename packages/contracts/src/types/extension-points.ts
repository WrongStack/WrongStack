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

import type { TextBlock, ToolUseBlock } from './blocks.js';
import type { AgentRunContext } from './context.js';
import type { Logger } from './logger.js';
import type { UserInputPayload } from './pipeline-payloads.js';
import type { Request, Response } from './provider.js';
import type { RunResult } from './run-result.js';
import type { SystemPromptContributor } from './system-prompt-contributor.js';
import type { ToolExecutionOutput } from './tool-executor.js';

// ── Core lifecycle hooks ────────────────────────────────────────────

/**
 * Called before Agent.run() begins the main iteration loop.
 * Returns `false` or throws to prevent the run from starting.
 */
export type BeforeRunHook = (ctx: AgentRunContext, input: UserInputPayload) => void | Promise<void>;

/**
 * Called after Agent.run() completes (or fails/aborts).
 * Receives the final RunResult, always called regardless of outcome.
 */
export type AfterRunHook = (ctx: AgentRunContext, result: RunResult) => void | Promise<void>;

/**
 * Called right before each iteration of the agent loop.
 * The context is live (messages, signal, etc.) and can be inspected.
 * Modifications to ctx (e.g. ctx.messages, ctx.model) take effect
 * for the upcoming iteration.
 */
export type BeforeIterationHook = (
  ctx: AgentRunContext,
  iterationIndex: number,
) => void | Promise<void>;

/**
 * Called after each iteration completes (tool results appended,
 * compaction done, but before the next loop iteration check).
 */
export type AfterIterationHook = (
  ctx: AgentRunContext,
  iterationIndex: number,
) => void | Promise<void>;

/**
 * Called when the model answers without tool calls, i.e. tries to end the
 * turn. Return a steering message to keep the loop going instead: it is
 * queued as a steer and the model gets another iteration. Return nothing to
 * let the turn end. The loop caps how often a run can be held this way, so a
 * guard that never clears cannot trap the turn.
 */
export type BeforeTurnEndHook = (
  ctx: AgentRunContext,
  iterationIndex: number,
) => string | undefined | Promise<string | undefined>;

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
  ctx: AgentRunContext,
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
export type ProviderRunnerFn = (ctx: AgentRunContext, request: Request) => Promise<Response>;

/**
 * Wrap or replace the provider call in the agent loop.
 *
 * The `inner` function is the default provider runner (with retries).
 * The extension can call it, modify the request/response, add caching,
 * or bypass it entirely.
 */
export type ProviderRunnerWrapper = (
  ctx: AgentRunContext,
  request: Request,
  inner: ProviderRunnerFn,
) => Promise<Response>;

// ── Tool execution extension ────────────────────────────────────────

/**
 * Called before a batch of tools is executed. Can modify or reject
 * the tool list. Return the (possibly filtered/modified) tool uses.
 */
export type BeforeToolExecutionHook = (
  ctx: AgentRunContext,
  toolUses: ToolUseBlock[],
) => ToolUseBlock[] | Promise<ToolUseBlock[]>;

/**
 * Called after a batch of tools has been executed and results
 * are available. The extension can inspect or transform results
 * before they're appended to context.
 */
export type AfterToolExecutionHook = (
  ctx: AgentRunContext,
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
  beforeTurnEnd?: BeforeTurnEndHook | undefined;
  onError?: OnErrorHook | undefined;
  wrapProviderRunner?: ProviderRunnerWrapper | undefined;
  beforeToolExecution?: BeforeToolExecutionHook | undefined;
  afterToolExecution?: AfterToolExecutionHook | undefined;
}

// ── Registry contract ────────────────────────────────────────────────

/**
 * The extension registry as plugins and hosts see it (`PluginAPI.extensions`,
 * `Agent.extensions`). Implementation: `extension/registry.ts`.
 */
export interface ExtensionRegistryPort {
  setLogger(log: Logger): void;
  /** Register a system-prompt contributor. Returns an unsubscribe function. */
  registerSystemPromptContributor(c: SystemPromptContributor): () => void;
  buildSystemPromptContributions(ctx: Parameters<SystemPromptContributor>[0]): Promise<TextBlock[]>;
  listSystemPromptContributors(): readonly SystemPromptContributor[];
  /** Register an extension. Throws when the name is taken; returns an unsubscribe function. */
  register(ext: AgentExtension): () => void;
  registerOrReplace(ext: AgentExtension): () => void;
  registerOrReplaceScoped(ext: AgentExtension): () => void;
  unregister(name: string): boolean;
  list(): readonly string[];
  has(name: string): boolean;
  clear(): void;
  runBeforeRun(...args: Parameters<BeforeRunHook>): Promise<void>;
  runAfterRun(...args: Parameters<AfterRunHook>): Promise<void>;
  runBeforeIteration(...args: Parameters<BeforeIterationHook>): Promise<void>;
  runAfterIteration(...args: Parameters<AfterIterationHook>): Promise<void>;
  runBeforeTurnEnd(...args: Parameters<BeforeTurnEndHook>): Promise<string | undefined>;
  runOnError(
    ...args: Parameters<OnErrorHook>
  ): Promise<
    | { action: 'retry'; model?: string | undefined }
    | { action: 'fail' }
    | { action: 'continue' }
    | void
  >;
  wrapProviderRunner(
    inner: ProviderRunnerFn,
    options?: { exclude?: readonly string[] | undefined },
  ): ProviderRunnerFn;
  runBeforeToolExecution(
    ...args: Parameters<BeforeToolExecutionHook>
  ): Promise<Parameters<BeforeToolExecutionHook>[1]>;
  runAfterToolExecution(...args: Parameters<AfterToolExecutionHook>): Promise<void>;
}
