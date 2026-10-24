/**
 * `session_rename` — the model names the session it is working in.
 *
 * Sessions are listed by their first prompt until someone names them, and
 * "fix it" or "continue" says nothing about what a session was for. The model
 * knows once the work has taken shape, so it can give the session a short
 * title — the same name `/sessions rename` and the WebUI history list set.
 *
 * Only the CURRENT session: the id comes from the run, never from the model,
 * so a tool call cannot relabel some other conversation in the history.
 */

import type { EventBus } from '@wrongstack/contracts/kernel/events';
import { ToolValidationError } from '@wrongstack/contracts/types/errors';
import type { JSONSchema, Tool } from '@wrongstack/contracts/types/tool';
import { ToolCapabilities } from '@wrongstack/core/security';

export const SESSION_RENAME_TOOL_NAME = 'session_rename';

/** Longest name kept; history lists show one line per session. */
const SESSION_NAME_MAX_CHARS = 120;

export interface SessionRenameToolOptions {
  /** The session store's rename (`SessionStore.rename`). */
  rename: (sessionId: string, name: string) => Promise<unknown>;
  /** Bus to announce `session.renamed` on, so open history lists refresh. */
  events?: EventBus | undefined;
}

const SCHEMA: JSONSchema = {
  type: 'object',
  properties: {
    name: {
      type: 'string',
      description: `Short title for this session — what the work is about (max ${SESSION_NAME_MAX_CHARS} characters).`,
    },
  },
  required: ['name'],
  additionalProperties: false,
};

/** One line, collapsed whitespace, capped. */
function normalizeSessionName(raw: string): string {
  const oneLine = raw.replace(/\s+/g, ' ').trim();
  if (oneLine.length <= SESSION_NAME_MAX_CHARS) return oneLine;
  return `${oneLine.slice(0, SESSION_NAME_MAX_CHARS - 1).trimEnd()}…`;
}

export function createSessionRenameTool(
  opts: SessionRenameToolOptions,
): Tool<{ name: string }, string> {
  return {
    name: SESSION_RENAME_TOOL_NAME,
    description:
      'Give the current session a short descriptive title, shown in session history and ' +
      'resume lists. Use it once the task is clear, or when the work has moved on to ' +
      'something the old title no longer describes. Renames only this session.',
    category: 'session',
    inputSchema: SCHEMA,
    permission: 'auto',
    mutating: true,
    riskTier: 'safe',
    capabilities: [ToolCapabilities.SESSION_RENAME],
    icon: 'settings',

    async execute(input, ctx) {
      const name = normalizeSessionName(typeof input.name === 'string' ? input.name : '');
      if (!name) {
        throw new ToolValidationError({ message: 'name must not be empty', field: 'name' });
      }
      const sessionId = ctx.eventSessionId();
      await opts.rename(sessionId, name);
      opts.events?.emit('session.renamed', { sessionId, name });
      return `Session renamed to "${name}".`;
    },
  };
}
