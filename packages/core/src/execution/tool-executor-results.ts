import type { ToolResultBlock, ToolUseBlock } from '../types/blocks.js';

export function unknownToolResult(use: ToolUseBlock, listFns: () => string[]): ToolResultBlock {
  return {
    type: 'tool_result',
    tool_use_id: use.id,
    content: `Tool "${use.name}" is not registered. Available tools: ${listFns().join(', ')}`,
    is_error: true,
  };
}

export function malformedInputResult(use: ToolUseBlock, raw?: string): ToolResultBlock {
  let content =
    `Tool "${use.name}" received arguments that were not a valid JSON object, so they ` +
    `could not be parsed. Re-issue the call with the arguments encoded as a single ` +
    `well-formed JSON object matching the tool's input schema.`;
  if (raw) {
    const max = 800;
    const excerpt =
      raw.length > max ? `${raw.slice(0, max)}… (truncated, ${raw.length} chars total)` : raw;
    content +=
      ` Common cause: a string field (e.g. code in old_string/new_string) ` +
      `contains literal newlines, quotes, or backslashes that must be JSON-escaped, ` +
      `or the payload was cut off mid-stream. The raw arguments received were:\n${excerpt}`;
  }
  return {
    type: 'tool_result',
    tool_use_id: use.id,
    content,
    is_error: true,
  };
}

export function deniedResult(use: ToolUseBlock, reason?: string): ToolResultBlock {
  return {
    type: 'tool_result',
    tool_use_id: use.id,
    content: `Tool "${use.name}" denied: ${reason ?? 'policy'}`,
    is_error: true,
  };
}

export function blockedByHookResult(use: ToolUseBlock, reason?: string): ToolResultBlock {
  return {
    type: 'tool_result',
    tool_use_id: use.id,
    content: `Tool "${use.name}" was blocked by a PreToolUse hook: ${reason ?? 'no reason given'}`,
    is_error: true,
  };
}
