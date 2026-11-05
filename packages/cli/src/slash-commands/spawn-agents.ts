import type { SlashCommand } from '@wrongstack/contracts/types';
import type { SlashCommandContext } from './command-context.js';

// Moved to @wrongstack/runtime/commands: engines serve them through the command bridge.
export { buildDirectorCommand, buildSpawnCommand } from '@wrongstack/runtime/commands';

export function buildAgentsCommand(opts: SlashCommandContext): SlashCommand {
  return {
    name: 'agents',
    category: 'Agent',
    description:
      'Show status of spawned subagents. /agents monitor opens the agents monitor overlay. /agents on|off toggles the overlay.',
    help: [
      'Usage: /agents [monitor|on|off|stream on|stream off]',
      '       /agents          — show subagent status summary',
      '       /agents monitor  — open the agents monitor overlay',
      '       /agents on       — show the agents monitor overlay',
      '       /agents off      — hide the agents monitor overlay',
      '       /agents stream on   — show subagent text output in chat history',
      '       /agents stream off  — hide subagent text output from chat history',
    ].join('\n'),
    async run(args) {
      const arg = args.trim().toLowerCase();
      // "monitor" and "on" both open the overlay
      if (arg === 'monitor' || arg === 'on') {
        opts.agentsMonitorController?.setVisible(true);
        return { message: 'Agents monitor shown.' };
      }
      if (arg === 'off') {
        opts.agentsMonitorController?.setVisible(false);
        return { message: 'Agents monitor hidden.' };
      }
      if (arg === 'stream on') {
        opts.fleetStreamController?.setMode('full');
        return { message: 'Agent stream enabled — subagent activity visible in history.' };
      }
      if (arg === 'stream off') {
        opts.fleetStreamController?.setMode('off');
        return { message: 'Agent stream disabled — subagent activity hidden from history.' };
      }
      // Empty/whitespace → summary; any other non-empty string → specific agent lookup
      if (!opts.onAgents) return { message: 'Multi-agent is not enabled in this session.' };
      const subagentId = arg || undefined;
      return { message: await opts.onAgents(subagentId) };
    },
  };
}
