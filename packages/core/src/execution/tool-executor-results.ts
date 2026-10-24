import type { ToolResultBlock, ToolUseBlock } from '@wrongstack/contracts/types/blocks';
import type { Message } from '@wrongstack/contracts/types/messages';
import type { Tool } from '@wrongstack/contracts/types/tool';

/**
 * How far back an earlier copy of a tool's contract still counts as in view.
 * Older tool results are elided by compaction (see `findPreserveStart`), so a
 * reference to one would dangle.
 */
const CONTRACT_LOOKBACK_MESSAGES = 12;

function contractInView(tool: Tool, history: readonly Message[] | undefined): boolean {
  if (!history) return false;
  const marker = `Registered usage for "${tool.name}":`;
  for (const message of history.slice(-CONTRACT_LOOKBACK_MESSAGES)) {
    if (message.role !== 'user' || typeof message.content === 'string') continue;
    for (const block of message.content) {
      if (block.type !== 'tool_result') continue;
      if (block.content.includes(marker) && block.content.includes('Input schema:')) return true;
    }
  }
  return false;
}

/** Above this, the correction carries only the fields the failure is about. */
const SCHEMA_INLINE_MAX_CHARS = 4_000;

/**
 * The schema to show beside a failure. A wide flat schema (kanban: ~150
 * fields, ~23k chars) pasted whole put ~7k tokens of durable history behind a
 * single bad call; the fix needs only the required fields and the ones that
 * failed. The full schema stays one exact-name `tool_search` away.
 */
function schemaForCorrection(tool: Tool, failingPaths: readonly string[]): string {
  const full = JSON.stringify(tool.inputSchema);
  const properties = tool.inputSchema.properties ?? {};
  if (full.length <= SCHEMA_INLINE_MAX_CHARS) return full;
  const keep = new Set([
    ...(tool.inputSchema.required ?? []),
    ...failingPaths.map((path) => path.split(/[.[]/)[0] ?? ''),
  ]);
  const subset = Object.fromEntries(Object.entries(properties).filter(([name]) => keep.has(name)));
  return (
    `${JSON.stringify({ ...tool.inputSchema, properties: subset })}\n` +
    `(Trimmed to the required and failing fields; the full schema has ${Object.keys(properties).length} fields — ` +
    `call tool_search with the exact name "${tool.name}" to see all of them.)`
  );
}

/**
 * Give the model the registered contract on the failing call itself — once.
 * The correction is durable history: when an intact copy for the same tool is
 * still in the recent window, a repeat failure gets a pointer to it instead of
 * a second ~1.5k-char copy.
 */
export function toolInputCorrection(
  tool: Tool,
  history?: readonly Message[],
  failingPaths: readonly string[] = [],
): string {
  if (contractInView(tool, history)) {
    return (
      `\n\nThe registered contract for "${tool.name}" (fields, schema, usage) is in your earlier failed call above. ` +
      'Apply it to the validation errors here; do not repeat the same arguments unchanged.'
    );
  }
  const declared = Object.keys(tool.inputSchema.properties ?? {});
  const required = tool.inputSchema.required ?? [];
  const selection = tool.selection;
  return (
    `\n\nRegistered usage for "${tool.name}":\n` +
    `${tool.description}` +
    (tool.usageHint ? `\nUsage: ${tool.usageHint}` : '') +
    (declared.length > 0 ? `\nDeclared top-level fields: ${declared.join(', ')}` : '') +
    (required.length > 0 ? `\nRequired top-level fields: ${required.join(', ')}` : '') +
    (selection
      ? `\nDo not use this tool when: ${selection.doNotUseWhen}` +
        (selection.useInstead?.length ? `\nUse instead: ${selection.useInstead.join(', ')}` : '')
      : '') +
    `\nInput schema: ${schemaForCorrection(tool, failingPaths)}\n` +
    `Recovery steps: First check whether this tool actually fits the task. ` +
    `If it does, apply the validation error above: remove unsupported fields, add missing required fields, and correct types or values using the schema and usage hint. ` +
    `Do not repeat the same arguments unchanged. If the tool is wrong for the task, choose a registered alternative. ` +
    `If a required value cannot be determined, ask for that value instead of inventing it.`
  );
}

export function unknownToolResult(use: ToolUseBlock, listFns: () => string[]): ToolResultBlock {
  return {
    type: 'tool_result',
    tool_use_id: use.id,
    content: `Tool "${use.name}" is not registered. Available tools: ${listFns().join(', ')}`,
    is_error: true,
  };
}

export function malformedInputResult(
  use: ToolUseBlock,
  tool: Tool,
  raw?: string,
  history?: readonly Message[],
): ToolResultBlock {
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
  content += toolInputCorrection(tool, history);
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
