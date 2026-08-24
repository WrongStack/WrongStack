import type { Context } from '@wrongstack/core/agent';
import { color, estimateMessageTokens } from '@wrongstack/core/utils';

export type { ProjectFacts } from '../services/project-facts.js';
export { detectProjectFacts, renderAgentsTemplate } from '../services/project-facts.js';

/**
 * Parse a slash command's args string into subcommand + rest tokens.
 *
 *   /fleet spawn bug-hunter 2  ->  { cmd: 'spawn', rest: ['bug-hunter', '2'] }
 *   /mcp                      ->  { cmd: '', rest: [] }
 *   /goal set build the API   ->  { cmd: 'set', rest: ['build', 'the', 'API'] }
 *
 * Used by ~20 multi-subcommand slash commands to replace the repetitive
 * `args.trim().split(/\s+/)` preamble.
 */
export function parseSubcommand(args: string): { cmd: string; rest: string[] } {
  const parts = args.trim().split(/\s+/);
  return { cmd: (parts[0] ?? '').toLowerCase(), rest: parts.slice(1) };
}

/**
 * Generate a consistent "unknown subcommand" message for the `default` branch
 * of a subcommand switch.
 *
 *   unknownSubcommand('frobulate', ['status', 'kill', 'usage'], 'fleet')
 *   // -> 'Unknown subcommand "frobulate" for /fleet. Valid: status, kill, usage.'
 */
export function unknownSubcommand(cmd: string, valid: string[], name?: string): string {
  const list = valid.join(', ');
  return name
    ? `Unknown subcommand "${cmd}" for /${name}. Valid: ${list}.`
    : `Unknown subcommand "${cmd}". Valid: ${list}.`;
}

export function countTurnPairs(messages: Context['messages']): number {
  let count = 0;
  for (const m of messages) {
    // Tool-result frames come back as role:'user' messages (one per tool
    // round-trip). Counting them here would inflate the pair count by every
    // tool call, so exclude them — a "pair" is one normal user prompt plus
    // the assistant exchange that answers it.
    if (m.role === 'assistant') count++;
    else if (m.role === 'user' && !isToolResultMessage(m)) count++;
  }
  return Math.floor(count / 2);
}

/** True when a message is a tool-result frame (role 'user', only tool_result blocks). */
function isToolResultMessage(message: Context['messages'][number]): boolean {
  return (
    message.role === 'user' &&
    Array.isArray(message.content) &&
    message.content.length > 0 &&
    message.content.every((block) => block.type === 'tool_result')
  );
}

export function countToolUses(messages: Context['messages']): number {
  let count = 0;
  for (const m of messages) {
    if (Array.isArray(m.content)) count += m.content.filter((b) => b.type === 'tool_use').length;
  }
  return count;
}

export function countToolResults(messages: Context['messages']): number {
  let count = 0;
  for (const m of messages) {
    if (Array.isArray(m.content)) count += m.content.filter((b) => b.type === 'tool_result').length;
  }
  return count;
}

/** Messages-only token estimate. Delegates to the canonical shared estimator so
 *  `/context` shows the same number compaction and the context bar work with. */
export function estimateTokens(messages: Context['messages']): number {
  return estimateMessageTokens(messages);
}

export function statusIcon(status: string): string {
  if (status === 'healthy') return color.green('\u25cf');
  if (status === 'degraded') return color.yellow('\u25cf');
  return color.red('\u25cf');
}
