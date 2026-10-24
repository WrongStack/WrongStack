import type { ToolResultBlock, ToolUseBlock } from './blocks.js';
import type { Tool, ToolSettlement } from './tool.js';

/** Context.meta key installed by ToolExecutor for governed calls made by meta-tools. */
export const GOVERNED_TOOL_EXECUTOR_META_KEY = 'toolExecutor.executeGoverned';

/** Result returned to meta-tools after a nested call traverses the normal executor. */
export interface GovernedToolExecutionResult {
  success: boolean;
  result?: unknown | undefined;
  error?: string | undefined;
}

/** Governed execution bridge exposed to meta-tools through Context.meta. */
export type GovernedToolExecutor = (
  toolName: string,
  input: Record<string, unknown>,
) => Promise<GovernedToolExecutionResult>;

/**
 * Input for a single tool execution, scoped to a single iteration's budget.
 */
export interface ToolExecution {
  toolUse: ToolUseBlock;
  result: ToolResultBlock;
  /** True if the tool was not found in the registry. */
  unknownTool?: boolean | undefined;
  /** True if the tool execution threw an exception. */
  threw?: boolean | undefined;
}

/**
 * Output from a single tool execution.
 */
export interface ToolExecutionOutput {
  result: ToolResultBlock | ToolConfirmPendingResult;
  tool?: Tool | undefined;
  durationMs: number;
  /**
   * How the call settled, when the executor knows better than `is_error`
   * (denied, declined, blocked, invalid, aborted). Absent on a pending
   * confirmation; consumers fall back to `completed` / `failed`.
   */
  settlement?: ToolSettlement | undefined;
}

/**
 * Result of running a batch of tools for a single agent iteration.
 */
export interface ToolBatchResult {
  outputs: ToolExecutionOutput[];
  remainingBudget: number;
}

export type ConfirmAwaiter = (
  tool: Tool,
  input: unknown,
  toolUseId: string,
  suggestedPattern: string,
) => Promise<'yes' | 'no' | 'always' | 'always-exact' | 'always-command' | 'always-tool' | 'deny'>;

/**
 * Result returned by executeBatch when a tool needs confirmation and
 * no confirmAwaiter is available. The TUI catches this and surfaces a
 * confirmation dialog; once resolved the tool is re-executed.
 * The string tag identifies it as a "pending confirm" result so callers
 * can distinguish it from an error without inspecting content strings.
 */
export interface ToolConfirmPendingResult {
  type: 'tool_confirm_pending';
  toolUseId: string;
  toolName: string;
  input: unknown;
  preToolContext?: { text: string; contextAs: 'inline' | 'separate' } | undefined;
  suggestedPattern: string;
  decisionSource?: import('./permission.js').PermissionDecision['source'] | undefined;
  riskTier?: import('./tool.js').RiskTier | undefined;
  /** Real write destinations from `Tool.writeTargets`, when declared (VULN-001 Phase 2). */
  writeTargets?: string[] | undefined;
  /** Present when approval is required specifically by a Kanban scope. */
  boundaryReason?: string | undefined;
}

export type ToolExecutorStrategy = 'parallel' | 'sequential' | 'smart';

/**
 * Minimal contract for tool execution.
 *
 * Defined here (in `types/`) so `core/` does not need to import the
 * concrete `ToolExecutor` class from `execution/`. Callers that create
 * the executor (e.g. CLI wiring) implement this interface.
 *
 * Only the methods actually called by `Agent` are included — keeping the
 * interface narrow prevents unnecessary coupling.
 */
export interface ToolExecutorLike {
  /**
   * Execute a batch of tool uses. The strategy controls whether tools run
   * sequentially, in parallel, or smart (parallel non-mutating + sequential mutating).
   */
  executeBatch(
    toolUses: import('./blocks.js').ToolUseBlock[],
    ctx: import('./context.js').AgentContext,
    strategy: ToolExecutorStrategy,
  ): Promise<ToolBatchResult>;

  /**
   * Clear the interactive confirm awaiter so the executor returns
   * `ToolConfirmPendingResult` instead of blocking.
   */
  clearConfirmAwaiter(): void;

  /**
   * Execute a single tool with timeout and output capping.
   * Used by the agent when it needs to run one tool at a time.
   *
   * Returns the rendered `ToolResultBlock` plus the exact byte count it
   * consumed against the iteration output cap. The caller subtracts
   * `bytes` from the running budget — no second `Buffer.byteLength`
   * walk, and no `JSON.stringify` fallback for structured results.
   */
  executeTool(
    tool: Tool,
    use: ToolUseBlock,
    ctx: import('./context.js').AgentContext,
    budget: number,
    preToolContext?: { text: string; contextAs: 'inline' | 'separate' },
  ): Promise<{ block: ToolResultBlock; bytes: number }>;
  /**
   * A `tool_confirm_pending` call was rejected or aborted: PreToolUse already
   * ran, the tool never will. Optional so minimal executors stay valid.
   */
  abandonTool?(
    tool: Tool,
    use: ToolUseBlock,
    ctx: import('./context.js').AgentContext,
    reason: string,
  ): Promise<void>;
}
