import type { ToolErrorCategory, ToolErrorInfo } from '../types/tool.js';
import { ToolErrorCategory as Cat } from '../types/tool.js';
import type { ToolResultBlock, ToolUseBlock } from '../types/blocks.js';
import { classifyToolError } from './tool-executor-support.js';

/**
 * Format a tool execution error into a ToolResultBlock with structured
 * ToolErrorInfo attached. The agent sees both a human-readable message
 * and a machine-readable category/retryable pair so it can decide
 * whether to retry, adjust arguments, or abandon the approach.
 *
 * Every tool-originated error flows through this function so the output
 * shape is identical regardless of which path produced the error
 * (exec, bash, runtime, subagent, permission denial, hook block, etc.).
 */
export function toolErrorResult(
  use: ToolUseBlock,
  err: unknown,
  opts: { scrubber?: (s: string) => string } = {},
): ToolResultBlock {
  const { category, retryable, detail } = classifyToolError(err);

  // Build the user-facing message.
  const rawMessage =
    err instanceof Error ? err.message : typeof err === 'string' ? err : 'Unknown error';

  const userMessage = opts.scrubber ? opts.scrubber(rawMessage) : rawMessage;

  const info: ToolErrorInfo = {
    category,
    retryable,
    userMessage,
    ...(detail !== undefined ? { detail } : {}),
  };

  // Format the content string with the category prefix so the LLM
  // can pattern-match on the error kind.
  const prefix = formatErrorPrefix(category, retryable);
  const detailSuffix = detail ? ` [${detail}]` : '';

  return {
    type: 'tool_result',
    tool_use_id: use.id,
    content: `${prefix}: ${userMessage}${detailSuffix}`,
    is_error: true,
    // Attach structured info for programmatic consumers (retry logic,
    // audit log, observability).
    _toolErrorInfo: info,
  };
}

/**
 * Create a tool error result from a pre-classified category + message.
 * Used by permission denials, hook blocks, and validation errors that
 * don't flow through classifyToolError (they're known at the call site).
 */
export function classifiedToolErrorResult(
  use: ToolUseBlock,
  category: ToolErrorCategory,
  message: string,
  opts: { retryable?: boolean; detail?: string } = {},
): ToolResultBlock {
  const retryable = opts.retryable ?? isCategoryRetryable(category);
  const info: ToolErrorInfo = {
    category,
    retryable,
    userMessage: message,
    ...(opts.detail !== undefined ? { detail: opts.detail } : {}),
  };

  const prefix = formatErrorPrefix(category, retryable);
  const detailSuffix = opts.detail ? ` [${opts.detail}]` : '';

  return {
    type: 'tool_result',
    tool_use_id: use.id,
    content: `${prefix}: ${message}${detailSuffix}`,
    is_error: true,
    _toolErrorInfo: info,
  };
}

/**
 * Extract structured ToolErrorInfo from a ToolResultBlock if present.
 * Returns undefined for non-error results or results without the
 * structured extension.
 */
export function getToolErrorInfo(block: ToolResultBlock): ToolErrorInfo | undefined {
  if (!block.is_error) return undefined;
  return (block as ToolResultBlock & { _toolErrorInfo?: ToolErrorInfo })._toolErrorInfo;
}

function formatErrorPrefix(category: ToolErrorCategory, retryable: boolean): string {
  const label = CATEGORY_LABELS[category] ?? 'Error';
  return retryable ? `${label} (retryable)` : label;
}

function isCategoryRetryable(category: ToolErrorCategory): boolean {
  return category === Cat.TRANSIENT;
}

const CATEGORY_LABELS: Readonly<Record<ToolErrorCategory, string>> = {
  [Cat.TRANSIENT]: 'Transient error',
  [Cat.NOT_FOUND]: 'Not found',
  [Cat.PERMISSION]: 'Permission denied',
  [Cat.VALIDATION]: 'Validation error',
  [Cat.FATAL]: 'Error',
};
