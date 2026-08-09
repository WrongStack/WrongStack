import type { SlashCommand } from '@wrongstack/core/types';
import { toErrorMessage } from '@wrongstack/core/utils';
import { parseSpawnFlags } from '../arg-parser.js';
import type { SlashCommandContext } from './command-context.js';

export function buildSpawnCommand(opts: SlashCommandContext): SlashCommand {
  return {
    name: 'spawn',
    category: 'Agent',
    description: 'Spawn an isolated subagent to handle a task.',
    argsHint: '[--name=<label>] [--model=<id>] <task description>',
    help: [
      'Fire-and-forget subagent spawn. The subagent runs independently; check',
      'its status with /agents or /fleet.',
      '',
      'Usage:',
      '  /spawn <task description>',
      '  /spawn --name=<label> --model=<id> <task description>',
      '',
      'Flags:',
      '  --name=<label>   Display name for the subagent',
      '  --provider=<id>  Override the provider (defaults to leader provider)',
      '  --model=<id>     Override the model (defaults to leader model)',
      '  --tools=a,b,c    Comma-separated list of tool names to grant',
      '',
      'For smart routing (auto-picking the right agent role), use /fleet dispatch.',
      'For explicit role assignment, use /fleet spawn <role>.',
      '',
      'Director mode is always active — spawning is available.',
    ].join('\n'),
    async run(args) {
      const { description, opts: parsed } = parseSpawnFlags(args.trim());
      if (!description)
        return {
          message:
            'Usage: /spawn [--name=<label>] [--model=<id>] <task description>\n\nExamples:\n  /spawn "fix the auth bug in session.ts"\n  /spawn --name=fixer "audit core for null-deref bugs"\n\nDirector Mode is always active.',
        };
      if (!opts.onSpawn) return { message: 'Multi-agent is not enabled in this session.' };
      try {
        const summary =
          Object.keys(parsed).length > 0
            ? await opts.onSpawn(description, parsed)
            : await opts.onSpawn(description);
        return { message: summary };
      } catch (err) {
        return { message: `Spawn failed: ${toErrorMessage(err)}` };
      }
    },
  };
}

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

export function buildDirectorCommand(opts: SlashCommandContext): SlashCommand {
  return {
    name: 'director',
    category: 'Agent',
    description:
      'Promote this session to director mode, enabling fleet orchestration tools. Only works before any subagents are spawned.',
    help: [
      'Director Mode is permanently on — fleet commands are always available.',
      '',
      '  /fleet status|spawn|dispatch|kill|usage',
      '  /spawn "<task>"',
      '  /agents',
    ].join('\n'),
    async run() {
      if (!opts.onDirector)
        return { message: 'Director promotion is not available in this session.' };
      const result = await opts.onDirector();
      if (result === null) {
        return {
          message: 'Director is not available in this session.',
        };
      }
      return { message: result };
    },
  };
}
