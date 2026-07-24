import { pendingBtwCount, setBtwNote } from '@wrongstack/core/agent';
import type { SlashCommand } from '@wrongstack/core/types';
import type { SlashCommandContext } from './command-context.js';

/**
 * `/btw <note>` — non-aborting mid-run steering ("by the way").
 *
 * Stashes a short note on the live run context. Unlike `/steer` (which aborts
 * the iteration and prepends a heavy STEERING preamble), `/btw` lets the agent
 * keep working and folds the note in at the start of its next iteration —
 * between tool batches. If no run is active, the note rides along on the next
 * turn the agent takes.
 */
export function buildBtwCommand(opts: SlashCommandContext): SlashCommand {
  return {
    name: 'btw',
    category: 'Agent',
    description:
      'Drop a "by the way" note for the running agent without interrupting it — delivered at the next step',
    argsHint: '<note>',
    help: [
      '/btw <note>   Stash a note; the agent reads it at the start of its next',
      '              iteration (between tool calls) without restarting.',
      '/btw          Show how many notes are pending.',
      '',
      'Use `/steer` instead when you need to abort the current work immediately.',
    ].join('\n'),
    async run(args) {
      const ctx = opts.context;
      if (!ctx) {
        return { message: 'No active session — start a turn first, then use /btw to nudge it.' };
      }

      const text = args.trim();
      if (!text) {
        const n = pendingBtwCount(ctx);
        return {
          message:
            n === 0
              ? 'No notes pending. Usage: /btw <note>'
              : `${n} note(s) pending — will reach the agent at its next step.`,
        };
      }

      const pending = setBtwNote(ctx, text);
      return {
        message: `↯ Noted (${pending} pending) — the agent will fold this in at its next step:\n  ${text}`,
      };
    },
  };
}
