import type { EngineCommand } from './engine-operations';

/** What an engine command printed, or why it could not run. */
export interface CommandOutcome {
  text: string;
  error?: string | undefined;
}

/**
 * Runs one engine command by name, the way the composer's `/name args` does, and returns the
 * text it printed. `sessionId` names the conversation a session-scoped command acts on.
 */
export async function runEngineText(
  command: EngineCommand,
  name: string,
  args: string,
  sessionId?: string | undefined,
): Promise<CommandOutcome> {
  try {
    const reply = await command(
      'command.run',
      { name, args, ...(sessionId ? { sessionId } : {}) },
      ['command.result'],
    );
    if (typeof reply['error'] === 'string') return { text: '', error: reply['error'] };
    return { text: typeof reply['message'] === 'string' ? reply['message'].trim() : '' };
  } catch (error) {
    return { text: '', error: error instanceof Error ? error.message : String(error) };
  }
}
