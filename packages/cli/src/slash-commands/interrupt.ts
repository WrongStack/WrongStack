import { color } from '@wrongstack/core/utils';
import type { SlashCommand } from '@wrongstack/core/types';
import type { SlashCommandContext } from './command-context.js';

/**
 * `/interrupt` (aliases `/stop`, `/int`) — stop the current run and every
 * subagent without reaching for ESC / Ctrl+C. Aborts the in-flight leader run
 * via the surface-installed `interruptController` and kills the whole fleet via
 * `onFleetKill`. `/interrupt all` is the same thing, spelled explicitly.
 *
 * In the TUI and WebUI a slash command dispatches even mid-run, so this stops a
 * run that is wedged retrying a 429. In the plain REPL the prompt is blocked
 * while a run is in flight, so there `/interrupt` is mostly useful at the prompt
 * (Ctrl+C remains the mid-run path — it now also stops the fleet).
 */
interface InterruptAllResult {
  aborted: boolean;
  killed: number;
}

/**
 * Stop every producer that can still mutate the current session. Keeping this
 * in one helper makes `/interrupt all` and destructive session boundaries such
 * as `/clear` share the same cancellation path and ordering.
 */
export async function interruptAll(opts: SlashCommandContext): Promise<InterruptAllResult> {
  const aborted = opts.interruptController?.abortLeader() ?? false;
  const killed = opts.onFleetKill ? await opts.onFleetKill() : 0;
  return { aborted, killed };
}

export function buildInterruptCommand(opts: SlashCommandContext): SlashCommand {
  return {
    name: 'interrupt',
    aliases: ['stop', 'int'],
    category: 'Run',
    description: 'Stop the current run and all subagents (leader + fleet).',
    argsHint: '[all]',
    help: [
      'Usage:',
      '  /interrupt        Abort the current leader run and stop all subagents',
      '  /interrupt all    Same — stop everything (leader + fleet)',
      '',
      'Aliases: /stop, /int. In the TUI/WebUI this works mid-run; in the plain',
      'REPL use it at the prompt (Ctrl+C interrupts a run in flight).',
    ].join('\n'),
    async run() {
      const { aborted, killed } = await interruptAll(opts);

      if (!aborted && killed === 0) {
        return { message: color.dim('  Nothing to interrupt — no run in progress.') };
      }

      const parts: string[] = [];
      if (aborted) parts.push('leader run');
      if (killed > 0) parts.push(`${killed} subagent${killed === 1 ? '' : 's'}`);
      return { message: color.yellow(`  ↯ Interrupted ${parts.join(' + ')}.`) };
    },
  };
}
