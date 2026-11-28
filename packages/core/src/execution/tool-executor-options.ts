/**
 * Construction options for the `ToolExecutor` implementation. These name
 * concrete runtime collaborators (registry, hook runner, event bus), so they
 * live beside the executor rather than in the `types/` contracts.
 */

import type { ConfirmAwaiter } from '@wrongstack/contracts/types/tool-executor';

export interface ToolExecutorOptions {
  permissionPolicy: import('@wrongstack/contracts/types/permission').PermissionPolicy;
  secretScrubber: import('@wrongstack/contracts/types/secret-scrubber').SecretScrubber;
  renderer?: import('@wrongstack/contracts/types/renderer').Renderer | undefined;
  /**
   * Optional event bus. When provided, the executor emits `tool.started`
   * before invoking each tool's `execute()`. Closes the observability gap
   * between "model decided to call tool" and "tool finished".
   */
  events?: import('@wrongstack/contracts/kernel/events').EventBus | undefined;
  /**
   * Optional tracer. When provided, every tool execution opens a
   * `tool.<name>` span with attributes for tool name, permission decision,
   * input size, output size, and outcome. Spans are no-op by default.
   */
  tracer?: import('@wrongstack/contracts/types/observability').Tracer | undefined;
  /**
   * Optional structured logger for production diagnostics. Tool execution logs
   * include correlation IDs and metadata only — never raw tool inputs or output.
   */
  logger?: import('@wrongstack/contracts/types/logger').Logger | undefined;
  /**
   * Optional async callback the executor awaits inline when a tool call needs
   * user confirmation (the REPL supplies one). When omitted, `authorizeToolUse`
   * returns a `tool_confirm_pending` result instead of running the tool, and
   * the tool handler (`core/agent-tools.ts`) emits `tool.confirm_needed` for a
   * UI to answer. A run with no listener for that event answers `no` instead
   * of hanging, so the call is reported as denied.
   */
  confirmAwaiter?: ConfirmAwaiter | undefined;
  iterationTimeoutMs?: number | undefined;
  /** Hard upper bound for a single tool call timeout. Defaults to 5 minutes. */
  maxToolTimeoutMs?: number | undefined;
  /** Maximum tools started concurrently by parallel/smart batches. Defaults to 4. */
  maxParallelTools?: number | undefined;
  perIterationOutputCapBytes?: number | undefined;
  /**
   * Optional lifecycle hook runner. When present, `PreToolUse` hooks run
   * before the permission check (and can block the call or rewrite its input)
   * and `PostToolUse` hooks run after the tool returns (and can append context
   * to the result the model sees).
   */
  hookRunner?: import('../hooks/runner.js').HookRunner | undefined;
  /** Hard-block product mutations outside a ready, running strict Kanban contract. */
  requireKanbanGovernance?: boolean | undefined;
  /**
   * Per-tool on-screen result render mode map (`tools.resultRenderMode[name]`).
   * When set, the executor reads this map to decide whether the next
   * `writeToolResult` call should render in `simple` (meta only) or `extend`
   * (full preview) mode. Independent of the LLM-side `descriptionMode`.
   */
  resultRenderModes?:
    | import('@wrongstack/contracts/types/config').ToolResultRenderModeConfig
    | undefined;
}

export interface ToolExecutorInit {
  registry: import('../registry/tool-registry.js').ToolRegistry;
  options: ToolExecutorOptions;
}
