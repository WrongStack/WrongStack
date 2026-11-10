/**
 * Slash commands in an ACP prompt (ACP "Slash Commands"): the client sends
 * `/<name> <args>` as an ordinary `session/prompt`; the agent recognizes the
 * name and runs the command instead of a model turn. The command's output goes
 * back as the turn's message. A command may ask for a model turn afterwards
 * (`runText`), which then runs with that text in place of the command.
 */
import type { Agent } from '@wrongstack/core/agent';
import type { RunTurnApi, RunTurnInput } from './protocol-handler.js';

/** What a command answered: its message, and a follow-up prompt when it asks for one. */
export interface PromptCommandResult {
  message: string;
  runText?: string | undefined;
}

/** A parsed `/name args` at the start of a prompt. */
export interface PromptCommand {
  name: string;
  args: string;
}

/**
 * Run the command a prompt names, or answer `undefined` when `name` is not one
 * of the session's commands (the prompt then runs as an ordinary turn).
 */
export type RunPromptCommand = (
  agent: Agent,
  sessionId: string,
  command: PromptCommand,
  turn: { signal: AbortSignal; api?: RunTurnApi | undefined; emit: (update: unknown) => void },
) => Promise<PromptCommandResult | undefined>;

/** The longest command message a turn sends; the rest is cut with a note. */
const MESSAGE_LIMIT = 64_000;

/**
 * The command the prompt's first text block names. Only `/<name>` followed by
 * whitespace or the end counts, so a prompt that merely starts with a path
 * (`/usr/bin/x fails`) is a prompt.
 */
function parsePromptCommand(
  prompt: RunTurnInput['prompt'],
): (PromptCommand & { index: number }) | undefined {
  const index = prompt.findIndex((block) => block.type === 'text');
  if (index < 0) return undefined;
  const text = (prompt[index] as { text?: unknown }).text;
  if (typeof text !== 'string') return undefined;
  const match = /^\/([A-Za-z][\w:-]*)(?:\s+([\s\S]*))?$/.exec(text.trim());
  if (!match?.[1]) return undefined;
  return { name: match[1], args: (match[2] ?? '').trim(), index };
}

/**
 * Run a prompt's command, if it names one. `'done'` ends the turn with the
 * command's message (sent already, and handed back to record); `'continue'` hands back the prompt to run as a model turn
 * (the command's `runText` in place of its text block, the other blocks kept).
 */
export async function runPromptCommand(
  run: RunPromptCommand,
  agent: Agent,
  input: RunTurnInput,
  turn: { signal: AbortSignal; api?: RunTurnApi | undefined; emit: (update: unknown) => void },
): Promise<
  | { kind: 'done'; message: string }
  | { kind: 'continue'; prompt: RunTurnInput['prompt'] }
  | { kind: 'none' }
> {
  const command = parsePromptCommand(input.prompt);
  if (!command) return { kind: 'none' };
  const result = await run(
    agent,
    input.sessionId,
    { name: command.name, args: command.args },
    turn,
  );
  if (!result) return { kind: 'none' };
  const message =
    result.message.length > MESSAGE_LIMIT
      ? `${result.message.slice(0, MESSAGE_LIMIT)}\n… (${result.message.length - MESSAGE_LIMIT} more characters)`
      : result.message;
  if (message && !turn.signal.aborted) {
    turn.emit({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: message } });
  }
  if (!result.runText || turn.signal.aborted) return { kind: 'done', message };
  const prompt = input.prompt.slice();
  prompt[command.index] = { type: 'text', text: result.runText };
  return { kind: 'continue', prompt };
}
