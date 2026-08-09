/**
 * `/mailbox-demo` — Cross-session mailbox testing command.
 *
 * Demonstrates and tests inter-agent messaging across TUI and WebUI sessions
 * sharing the same project directory. Allows listing online agents, sending
 * test messages, and verifying cross-session delivery.
 *
 * Usage:
 *   /mailbox-demo status          — show project mailbox path and online agents
 *   /mailbox-demo agents          — list all registered agents in the project
 *   /mailbox-demo send <id> <msg> — send a test message to a specific agent
 *   /mailbox-demo broadcast <msg> — broadcast to all agents
 *   /mailbox-demo inbox           — check messages for the demo agent
 *   /mailbox-demo clear           — clear all messages for the demo agent
 */

import {
  getSharedProjectMailbox,
  type MailboxAgentStatus,
  type MailboxMessage,
  type RemoteMailbox,
  resolveProjectDir,
} from '@wrongstack/core/coordination';
import type { SlashCommand } from '@wrongstack/core/types';
import { wstackGlobalRoot } from '@wrongstack/core/utils';
import type { SlashCommandContext } from './command-context.js';
import { parseSubcommand, unknownSubcommand } from './helpers.js';

const DEMO_AGENT_ID = 'mailbox-demo';

function buildMailbox(opts: SlashCommandContext): RemoteMailbox | null {
  // Prefer paths.projectDir (wstack-paths slug), fall back to projectRoot
  const projectDir =
    opts.paths?.projectDir ?? resolveProjectDir(opts.projectRoot, wstackGlobalRoot());
  try {
    return getSharedProjectMailbox(projectDir);
  } catch {
    return null;
  }
}

function formatAgent(a: MailboxAgentStatus): string {
  const age = Date.now() - new Date(a.lastSeenAt).getTime();
  const stale = age > 60_000 ? ' (STALE)' : '';
  const role = a.role ? ` [${a.role}]` : '';
  return `  ${a.agentId}${role} — last heartbeat ${(age / 1000).toFixed(0)}s ago${stale}`;
}

function formatMessage(m: MailboxMessage): string {
  const from = m.from === DEMO_AGENT_ID ? 'you' : m.from;
  const to = m.to === '*' ? 'all' : m.to;
  const time = new Date(m.timestamp).toISOString().slice(11, 19);
  return `  [${time}] ${from} → ${to}: ${m.body.slice(0, 120)}${m.body.length > 120 ? '…' : ''}`;
}

export function buildMailboxDemoCommand(opts: SlashCommandContext): SlashCommand {
  return {
    name: 'mailbox-demo',
    category: 'Agent',
    description:
      'Test inter-agent mailbox across TUI/WebUI sessions: /mailbox-demo [status|agents|send <id> <msg>|broadcast <msg>|inbox|clear]',
    help: [
      'Demonstrates and tests inter-agent messaging across TUI and WebUI sessions',
      'sharing the same project directory. Allows listing online agents, sending',
      'test messages, and verifying cross-session delivery.',
      '',
      'Subcommands:',
      '  /mailbox-demo status          Show project mailbox path and online agents.',
      '                                Also registers the demo agent as active.',
      '  /mailbox-demo agents          List all registered agents in the project.',
      '  /mailbox-demo send <id> <msg> Send a test message to a specific agent.',
      '  /mailbox-demo broadcast <msg> Broadcast a message to all registered agents.',
      '  /mailbox-demo inbox           Check messages received by the demo agent.',
      '  /mailbox-demo clear           Clear all messages for the demo agent.',
      '',
      'Examples:',
      '  /mailbox-demo status',
      '  /mailbox-demo agents',
      '  /mailbox-demo send tui:executor "hello from TUI"',
      '  /mailbox-demo broadcast "hello everyone"',
    ].join('\n'),
    async run(args) {
      const mailbox = buildMailbox(opts);
      if (!mailbox) {
        return { message: '❌ Could not access project mailbox directory.' };
      }

      const sessionId = opts.context?.session?.id ?? 'cli';
      const { cmd, rest } = parseSubcommand(args);
      const restJoined = rest.join(' ').trim();

      switch (cmd) {
        case '':
        case 'status': {
          // Register (or refresh) demo agent
          await mailbox.registerAgent({
            agentId: DEMO_AGENT_ID,
            sessionId,
            name: 'Mailbox Demo',
            role: 'demo',
            pid: process.pid,
            source: 'cli',
          });

          const agents = await mailbox.getAgentStatuses();

          return {
            message: [
              `📬 Mailbox Demo — project: ${opts.projectRoot}`,
              `   Mailbox path: ${mailbox.messagePath}`,
              `   Registered agents (${agents.length}):`,
              ...(agents.length > 0 ? agents.map(formatAgent) : ['   (none)']),
              '',
              '   Available subcommands:',
              '   /mailbox-demo agents          — list all registered agents',
              '   /mailbox-demo send <id> <msg> — send message to specific agent',
              '   /mailbox-demo broadcast <msg> — broadcast to all agents',
              '   /mailbox-demo inbox           — check messages for demo agent',
              '   /mailbox-demo clear           — clear demo agent messages',
            ].join('\n'),
          };
        }

        case 'agents': {
          const agents = await mailbox.getAgentStatuses();
          if (agents.length === 0) {
            return { message: '📭 No agents registered in this project mailbox.' };
          }
          return {
            message: [`Registered agents (${agents.length}):`, ...agents.map(formatAgent)].join(
              '\n',
            ),
          };
        }

        case 'send': {
          const parts = restJoined.match(/^(\S+)\s+(.+)$/);
          if (!parts) {
            return { message: 'Usage: /mailbox-demo send <agent-id> <message>' };
          }
          const targetId = parts[1] ?? '';
          const msgBody = parts[2] ?? '';

          await mailbox.registerAgent({
            agentId: DEMO_AGENT_ID,
            sessionId,
            name: 'Mailbox Demo',
            role: 'demo',
            pid: process.pid,
            source: 'cli',
          });

          const msg = await mailbox.send({
            from: DEMO_AGENT_ID,
            to: targetId,
            type: 'note',
            subject: `message from ${DEMO_AGENT_ID}`,
            body: msgBody,
          });

          return {
            message: `✅ Message queued for "${targetId}" (id: ${msg.id.slice(0, 8)}…)\n   "${msgBody.slice(0, 80)}${msgBody.length > 80 ? '…' : ''}"`,
          };
        }

        case 'broadcast': {
          if (!restJoined) return { message: 'Usage: /mailbox-demo broadcast <message>' };

          await mailbox.registerAgent({
            agentId: DEMO_AGENT_ID,
            sessionId,
            name: 'Mailbox Demo',
            role: 'demo',
            pid: process.pid,
            source: 'cli',
          });

          const agents = await mailbox.getAgentStatuses();
          const otherAgents = agents.filter((a) => a.agentId !== DEMO_AGENT_ID);

          if (otherAgents.length === 0) {
            return { message: '📭 No other agents registered to receive the broadcast.' };
          }

          const results: string[] = [];
          for (const agent of otherAgents) {
            const msg = await mailbox.send({
              from: DEMO_AGENT_ID,
              to: agent.agentId,
              type: 'note',
              subject: `broadcast from ${DEMO_AGENT_ID}`,
              body: `[broadcast] ${restJoined}`,
            });
            results.push(`→ ${agent.agentId} (${msg.id.slice(0, 8)}…)`);
          }

          return {
            message: [
              `📡 Broadcast sent to ${otherAgents.length} agent(s):`,
              ...results,
              '',
              `Message: "${restJoined.slice(0, 80)}${restJoined.length > 80 ? '…' : ''}"`,
            ].join('\n'),
          };
        }

        case 'inbox': {
          const messages = await mailbox.query({ to: DEMO_AGENT_ID });
          if (messages.length === 0) {
            return { message: '📭 No messages for mailbox-demo.' };
          }
          return {
            message: [
              `📬 Inbox (${messages.length} message(s)):`,
              ...messages.map(formatMessage),
            ].join('\n'),
          };
        }

        case 'clear': {
          const messages = await mailbox.query({ to: DEMO_AGENT_ID });
          for (const m of messages) {
            await mailbox.ack({ messageId: m.id, readerId: DEMO_AGENT_ID });
          }
          return { message: `🗑 Cleared ${messages.length} message(s) for ${DEMO_AGENT_ID}.` };
        }

        default: {
          return {
            message: unknownSubcommand(
              cmd,
              ['status', 'agents', 'send', 'broadcast', 'inbox', 'clear'],
              'mailbox-demo',
            ),
          };
        }
      }
    },
  };
}
