/**
 * `/agents` — agent monitoring and timeline streaming commands.
 *
 * Commands:
 *   /agents               — Show legacy subagent status
 *   /agents help          — Show detailed help
 *   /agents stream on     — Show agent conversations in the main chat timeline
 *   /agents stream off    — Hide agent conversations from the main chat
 *   /agents stream status — Show current stream state
 *   /agents list          — List all active subagents
 *   /agents show <id>     — Show transcript for a specific agent
 */
import type { SlashCommand } from '@wrongstack/core';
import type { AgentMonitorService, AgentVirtualSession, AgentTimelineEntry } from '@wrongstack/core/coordination';
import { parseSubcommand } from './helpers.js';
import type { SlashCommandContext } from './index.js';

function formatAgentLine(a: { subagentId: string; agentName: string; status: string; task?: string }): string {
  const statusIcon: Record<string, string> = {
    spawned: '\u{1F7E2}',
    running: '\u{1F7E2}',
    completed: '\u{2705}',
    failed: '\u{274C}',
    timeout: '\u{23F0}',
    stopped: '\u{23F9}',
    budget_exhausted: '\u{1F4B0}',
  };
  const icon = statusIcon[a.status] ?? '\u{26AA}';
  const task = a.task ? ` \u{2014} ${a.task.slice(0, 80)}` : '';
  return `${icon} **${a.agentName}** (\`${a.subagentId.slice(0, 12)}\u{2026}\`) _${a.status}_${task}`;
}

export function buildAgentsCommand(opts: SlashCommandContext): SlashCommand {
  return {
    name: 'agents',
    category: 'Agent',
    description:
      'Monitor subagent activity: /agents [stream on|off|status|list|show <id>]',
    async run(args) {
      // TUI mode: bare /agents or /agents list opens the agents monitor.
      if ((!args.trim() || args.trim() === 'list') && opts.onPanelOpen?.current) {
        const opened = opts.onPanelOpen.current('toggleAgentsMonitor');
        if (opened) return { message: '' };
      }
      const monitor = (opts as unknown as Record<string, unknown>).agentMonitor as AgentMonitorService | undefined;
      const { cmd, rest } = parseSubcommand(args);
      const restJoined = rest.join(' ').trim();

      if (cmd === '' || cmd === 'legacy') {
        // No args — legacy behavior: delegate to onAgents callback.
        const agentsInfo = (opts as unknown as Record<string, unknown>).onAgents;
        const msg = typeof agentsInfo === 'function' ? agentsInfo() : 'Use `/agents list` or `/agents help`.';
        return { message: msg };
      }

      switch (cmd) {
        case 'help': {
          return {
            message: [
              '**/agents \u{2014} Subagent Monitoring**',
              '',
              '`/agents stream on`     \u{2014} Show agent conversations inline in chat',
              '`/agents stream off`    \u{2014} Hide agent conversations from chat',
              '`/agents stream status` \u{2014} Show current stream state',
              '`/agents list`          \u{2014} List all active/known subagents',
              '`/agents show <id>`     \u{2014} Show transcript for a specific subagent',
            ].join('\n'),
          };
        }
        case 'status': {
          if (monitor) {
            const enabled = monitor.streamEnabled;
            return { message: `Agent stream is **${enabled ? 'ON' : 'OFF'}**. Use \`/agents list\` to see active subagents.` };
          }
          const agentsInfo = (opts as unknown as Record<string, unknown>).onAgents;
          const msg = typeof agentsInfo === 'function' ? agentsInfo() : 'No agent monitor active.';
          return { message: msg };
        }

        case 'stream': {
          if (!monitor) return { message: 'No agent monitor active. Start a fleet first (`/fleet` or `/spawn`).' };

          const sub = rest[0]?.toLowerCase() ?? '';
          switch (sub) {
            case 'on': {
              monitor.setStreamEnabled(true);
              return { message: 'Agent stream enabled. Subagent conversations will appear in the timeline.' };
            }
            case 'off': {
              monitor.setStreamEnabled(false);
              return { message: 'Agent stream disabled. Subagent conversations hidden from timeline.' };
            }
            case 'status': {
              const enabled = monitor.streamEnabled;
              return {
                message: `Agent stream is **${enabled ? 'ON' : 'OFF'}**. ${
                  enabled
                    ? 'Subagent conversations appear in the main chat timeline.'
                    : 'Subagent conversations are recorded but hidden from the main chat.'
                }`,
              };
            }
            default: {
              return { message: 'Usage: `/agents stream on|off|status`' };
            }
          }
        }

        case 'list': {
          if (!monitor) return { message: 'No agent monitor active.' };

          const sessions = monitor.getAllSessions();
          if (sessions.length === 0) return { message: 'No subagents have been spawned yet.' };

          const lines = sessions.map((s: AgentVirtualSession) =>
            formatAgentLine({ subagentId: s.subagentId, agentName: s.agentName, status: s.status, ...(s.task !== undefined ? { task: s.task } : {}) }),
          );
          return {
            message: [`**Known subagents (${sessions.length})**`, '', ...lines].join('\n'),
          };
        }

        case 'show': {
          if (!monitor) return { message: 'No agent monitor active.' };

          if (!restJoined) return { message: 'Usage: `/agents show <subagentId>`\nUse `/agents list` to find IDs.' };

          const allSessions = monitor.getAllSessions();
          let match: AgentVirtualSession | undefined = allSessions.find(
            (s: AgentVirtualSession) => s.subagentId === restJoined || s.subagentId.startsWith(restJoined),
          );
          if (!match) {
            match = allSessions.find(
              (s: AgentVirtualSession) => s.agentName.toLowerCase().includes(restJoined.toLowerCase()),
            );
          }
          if (!match) return { message: `No subagent matched "${restJoined}". Use /agents list to see all.` };

          const entries = monitor.getTranscript(match.subagentId, 30);
          if (entries.length === 0) return { message: `No transcript entries for ${match.agentName}.` };

          const header = `**\u{1F4CB} ${match.agentName}** (\`${match.subagentId}\`) \u{2014} _${match.status}_ \u{2014} last ${entries.length} entries\n`;
          const body = entries
            .map((e: AgentTimelineEntry) => {
              const icon: Record<string, string> = {
                text: '',
                tool_use: '\u{1F527}',
                tool_result: '\u{1F4CE}',
                error: '\u{274C}',
                status: '\u{1F4AC}',
                system: '',
              };
              return `${icon[e.kind] ?? ''} [#${e.iteration}] ${e.content.slice(0, 200)}`;
            })
            .join('\n');
          return { message: header + body };
        }

        default: {
          return { message: `Unknown subcommand "${cmd}". Try: stream, list, show` };
        }
      }
    },
  };
}
