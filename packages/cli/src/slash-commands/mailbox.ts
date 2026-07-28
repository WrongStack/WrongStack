/**
 * `/mailbox` — the human operator's window into the project-level
 * inter-agent mailbox.
 *
 * Every terminal/TUI/WebUI working on the same project shares one
 * GlobalMailbox under `~/.wrongstack/projects/<slug>/_mailbox.jsonl`.
 * Agents read it automatically each iteration (mailbox-loop) and can
 * write via the `mailbox` tool; this command gives the USER the same
 * powers — see who is online, read the inbox, message a specific agent,
 * or broadcast to everyone.
 *
 * The command acts under THIS process's leader identity
 * (`leader@<sessionTag>`, session-bound), so messages you send
 * here are attributed to the same agent your conversation runs as, and
 * replies addressed to it land in your agent's next iteration.
 *
 * Usage:
 *   /mailbox                                  — inbox (unread for this leader)
 *   /mailbox agents                           — all registered agents on the project
 *   /mailbox online                           — only agents with a live heartbeat
 *   /mailbox send <id> [type=<t>] [audience=leaders] <message>
 *   /mailbox broadcast [audience=leaders] <message>
 *   /mailbox history [n]                      — last n messages on the project (default 20)
 */

import { color, wstackGlobalRoot } from '@wrongstack/core/utils';
import {
  getSharedProjectMailbox,
  type MailboxAgentStatus,
  type MailboxAudience,
  type MailboxMessage,
  type MailboxMessageType,
  type RemoteMailbox,
  mailboxSessionTag,
  resolveMailboxIdentity,
  resolveProjectDir,
} from '@wrongstack/core/coordination';
import type { SlashCommand } from '@wrongstack/core/types';
import type { SlashCommandContext } from './command-context.js';

function buildMailbox(opts: SlashCommandContext): RemoteMailbox | null {
  const projectDir =
    opts.paths?.projectDir ?? resolveProjectDir(opts.projectRoot, wstackGlobalRoot());
  try {
    return getSharedProjectMailbox(projectDir);
  } catch {
    return null;
  }
}

/** The identity this session's conversation runs as (`leader@<sessionTag>`). */
function leaderId(opts: SlashCommandContext): { id: string; base: string } {
  if (opts.context) {
    const identity = resolveMailboxIdentity(opts.context);
    return { id: identity.callerId, base: identity.baseId };
  }
  return { id: `leader@${mailboxSessionTag('default')}`, base: 'leader' };
}

function fmtAge(iso: string): string {
  const ms = Date.now() - new Date(iso).getTime();
  if (ms < 60_000) return `${Math.max(0, Math.round(ms / 1000))}s ago`;
  if (ms < 3_600_000) return `${Math.round(ms / 60_000)}m ago`;
  return `${Math.round(ms / 3_600_000)}h ago`;
}

const STATUS_COLOR: Record<MailboxAgentStatus['status'], (s: string) => string> = {
  running: color.green,
  streaming: color.green,
  idle: color.cyan,
  waiting_user: color.yellow,
  error: color.red,
  offline: color.dim,
};

/** Collapse newlines/runs of whitespace so list rows stay single-line. */
function oneLine(s: string, max: number): string {
  const flat = s.replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

/**
 * One agent per row, id column padded so the metadata lines up:
 *   ● leader@a1b2c3d4 (you)   cli · running · 12 iter · 34 tools · 5s ago
 *       ↳ implementing the auth refactor
 * Padding is computed on the RAW label (before ANSI) so alignment survives
 * coloring.
 */
function fmtAgent(a: MailboxAgentStatus, selfId: string, idWidth: number): string[] {
  const isSelf = a.agentId === selfId;
  const rawLabel = a.agentId + (isSelf ? ' (you)' : '');
  const pad = ' '.repeat(Math.max(0, idWidth - rawLabel.length));
  const dot = a.online ? color.green('●') : color.dim('○');
  const label = color.bold(a.agentId) + (isSelf ? color.cyan(' (you)') : '');
  const statusColor = STATUS_COLOR[a.status] ?? color.dim;
  const meta = [
    a.source ? color.dim(a.source) : undefined,
    statusColor(a.status),
    a.iterations > 0 ? color.dim(`${a.iterations} iter`) : undefined,
    a.toolCalls > 0 ? color.dim(`${a.toolCalls} tools`) : undefined,
    color.dim(fmtAge(a.lastSeenAt)),
  ]
    .filter((p): p is string => Boolean(p))
    .join(color.dim(' · '));
  const lines = [`  ${dot} ${label}${pad}  ${meta}`];
  if (a.currentTask) lines.push(color.dim(`      ↳ ${oneLine(a.currentTask, 80)}`));
  return lines;
}

/**
 * One message per row with aligned from → to columns:
 *   14:30:22  worker@b2c3d4e5 → you   [steer] adjust your approach…
 * Subject is only shown when it adds information (it is usually just the
 * first 60 chars of the body — repeating that reads as a glitch).
 */
function fmtMessage(m: MailboxMessage, selfId: string, fromWidth: number, toWidth: number): string {
  const rawFrom = m.from === selfId ? 'you' : m.from;
  const rawTo = m.to === '*' ? 'all' : m.to === selfId ? 'you' : m.to;
  const fromPad = ' '.repeat(Math.max(0, fromWidth - rawFrom.length));
  const toPad = ' '.repeat(Math.max(0, toWidth - rawTo.length));
  const from = m.from === selfId ? color.cyan(rawFrom) : color.bold(rawFrom);
  const to = m.to === '*' ? color.magenta(rawTo) : m.to === selfId ? color.cyan(rawTo) : rawTo;
  const t = color.dim(new Date(m.timestamp).toISOString().slice(11, 19));
  const typeTag = m.type !== 'note' ? color.magenta(`[${m.type}]`) : '';
  const audienceTag = m.audience === 'leaders' ? color.cyan('[leaders]') : '';
  const tag = typeTag || audienceTag ? `${[typeTag, audienceTag].filter(Boolean).join(' ')} ` : '';
  const body = oneLine(m.body, 120);
  const flatSubject = m.subject ? oneLine(m.subject, 60) : '';
  const subject =
    flatSubject && flatSubject !== body && !body.startsWith(flatSubject.replace(/…$/, ''))
      ? `${color.bold(flatSubject)} — `
      : '';
  return `  ${t}  ${from}${fromPad} → ${to}${toPad}  ${tag}${subject}${body}`;
}

/** Column widths from raw (uncolored) labels, shared by inbox + history. */
function messageWidths(messages: MailboxMessage[], selfId: string): { from: number; to: number } {
  let from = 0;
  let to = 0;
  for (const m of messages) {
    const rawFrom = m.from === selfId ? 'you' : m.from;
    const rawTo = m.to === '*' ? 'all' : m.to === selfId ? 'you' : m.to;
    if (rawFrom.length > from) from = rawFrom.length;
    if (rawTo.length > to) to = rawTo.length;
  }
  return { from, to };
}

/**
 * Pull an optional inline `type=<value>` flag off the front of a token list
 * and return the resolved type plus the remaining tokens as the message body.
 *
 * Shared by the `send` and `broadcast` subcommands so the operator-facing
 * syntax stays consistent. Unknown `type=` values fall back to `defaultType`
 * rather than rejecting the command — better to send a note tagged with the
 * wrong label than to drop the message entirely. The consumed flag is also
 * stripped from the body, so recipients never see literal `type=garbage`.
 *
 * Note: this list is intentionally NOT exhaustive over MailboxMessageType.
 * New message types added to the union are accepted by the underlying
 * mailbox but pass through this parser as the default — slash command
 * support for them must be opted into here. This is fail-safe (rather than
 * fail-open): the message still arrives, just with the wrong category label.
 */
function parseTypeFlag(
  tokens: string[],
  defaultType: MailboxMessageType,
): { type: MailboxMessageType; audience?: MailboxAudience; body: string } {
  const VALID: ReadonlySet<MailboxMessageType> = new Set<MailboxMessageType>([
    'note', 'ask', 'assign', 'steer', 'btw', 'broadcast', 'status', 'result', 'review',
  ]);
  let type: MailboxMessageType = defaultType;
  let audience: MailboxAudience | undefined;
  const rest = tokens.slice();
  while (rest[0]?.startsWith('type=') || rest[0]?.startsWith('audience=')) {
    const flag = rest.shift()!;
    if (flag.startsWith('type=')) {
      const candidate = flag.slice('type='.length) as MailboxMessageType;
      if (VALID.has(candidate)) type = candidate;
    } else {
      const candidate = flag.slice('audience='.length);
      if (candidate === 'leaders' || candidate === 'all') audience = candidate;
    }
  }
  return { type, ...(audience !== undefined ? { audience } : {}), body: rest.join(' ') };
}

export function buildMailboxCommand(opts: SlashCommandContext): SlashCommand {
  return {
    name: 'mailbox',
    category: 'Agent',
    aliases: ['mb'],
    description:
      'Project-wide agent mailbox: /mailbox [agents|online|send <id> [type=<t>] [audience=leaders] <msg>|broadcast [type=<t>] [audience=leaders] <msg>|history [n]|clear]',
    help: [
      'The human window into the shared inter-agent mailbox. Every terminal,',
      'TUI and WebUI on this project shares one inbox — agents see incoming',
      'messages automatically on their next iteration.',
      '',
      'Subcommands:',
      "  /mailbox                      Unread inbox for this session's leader.",
      '  /mailbox agents               All registered agents on the project.',
      '  /mailbox online               Only agents with a live heartbeat.',
      '  /mailbox send <id> [type=<t>] [audience=leaders] <message>     Direct message; audience=leaders prevents subagent consumption.',
      '  /mailbox broadcast [type=<t>] [audience=leaders] <message>     Broadcast, optionally only to leader agents.',
      '  /mailbox history [n] [from <id>] [to <id>] [grep <text>]  Last n messages, optionally filtered.',
      '  /mailbox clear                 Delete all messages from the mailbox.',
      '  /mailbox purge                Remove stale/orphaned messages (completed >1d, incomplete >7d).',
      '',
      'Message types (cheat sheet):',
      '  review   A passive request — code/doc/PR review. Recipient inspects',
      '           when convenient; an immediate reply is NOT required.',
      '  ask      A blocking question — recipient is expected to reply.',
      '  assign   A task assignment — recipient acts on it.',
      '  result   A subagent completion notice — recipient factors it in.',
      '  steer    A mid-task direction change — recipient adjusts course',
      '           at the next stopping point.',
      '  note/btw/status/broadcast  Informational, no action implied.',
      '  control  Reserved for the runtime; human/agent sends are rejected.',
      '  audience=leaders is a visibility filter. Pair it with recipient',
      '  leader for private leader control-plane mail.',
      '',
      'Examples:',
      '  /mailbox broadcast pausing deploys, hold off on main',
      '  /mailbox broadcast type=steer stop all in-flight work, we are rolling back',
      '  /mailbox send leader@a1b2c3d4 can you take the auth refactor?',
      '  /mailbox send worker@b2c3d4e5 type=review please skim src/auth/*.ts when you get a chance',
      '  /mailbox send leader@a1b2c3d4 type=ask are we merging the refactor today or tomorrow?',
      '  /mailbox send leader type=result audience=leaders review finished; findings attached',
    ].join('\n'),
    async run(args) {
      const mb = buildMailbox(opts);
      if (!mb) return { message: color.yellow('Mailbox unavailable (no project dir).') };
      const self = leaderId(opts);

      const parts = args.trim().split(/\s+/).filter(Boolean);
      const sub = parts[0]?.toLowerCase() ?? '';

      if (sub === 'agents' || sub === 'online') {
        const agents = sub === 'online' ? await mb.getOnlineAgents() : await mb.getAgentStatuses();
        if (agents.length === 0) {
          return {
            message: color.dim(
              'No agents registered yet. Agents register on their first iteration.',
            ),
          };
        }
        const idWidth = Math.max(
          ...agents.map((a) => a.agentId.length + (a.agentId === self.id ? 6 : 0)),
        );
        const lines = [
          color.bold(
            `${agents.length} ${sub === 'online' ? 'online ' : ''}agent(s) on this project`,
          ),
          ...agents.flatMap((a) => fmtAgent(a, self.id, idWidth)),
          '',
          color.dim(`Mailbox: ${mb.messagePath}`),
        ];
        return { message: lines.join('\n') };
      }

      if (sub === 'send') {
        const to = parts[1];
        const { type, audience, body } = parseTypeFlag(parts.slice(2), 'note');
        if (!to || !body) {
          return {
            message: 'Usage: /mailbox send <agentId> [type=<type>] <message>\nValid types: note, ask, assign, steer, btw, broadcast, status, result, review.',
          };
        }
        const msg = await mb.send({
          from: self.id,
          to,
          type,
          audience,
          subject: body.slice(0, 60),
          body,
        });
        const typeTag = type === 'note' ? '' : color.dim(` [${type}]`);
        return {
          message: color.green(`✓ Sent to ${to} (id ${msg.id.slice(0, 8)}…).`) + typeTag,
        };
      }

      if (sub === 'broadcast') {
        // Default to 'broadcast' but allow overrides — an operator may need
        // to broadcast a `steer` ("stop what you're doing") or a `review`
        // request across the fleet, and forcing the literal `broadcast` type
        // would lose that signal in the recipient's mailbox render.
        const { type, audience, body } = parseTypeFlag(parts.slice(1), 'broadcast');
        if (!body) {
          return {
            message: 'Usage: /mailbox broadcast [type=<type>] <message>\nValid types: note, ask, assign, steer, btw, broadcast, status, result, review.',
          };
        }
        const msg = await mb.send({
          from: self.id,
          to: '*',
          type,
          audience,
          subject: body.slice(0, 60),
          body,
        });
        const typeTag = type === 'broadcast' ? '' : color.dim(` [${type}]`);
        return {
          message: color.green(
            `✓ Broadcast to ${audience === 'leaders' ? 'leader agents' : 'all agents'} on the project (id ${msg.id.slice(0, 8)}…).`,
          ) + typeTag,
        };
      }

      if (sub === 'history') {
        // /mailbox history [n] [from <id>] [to <id>] [grep <text...>]
        const rest = parts.slice(1);
        let n = 20;
        let fromFilter: string | undefined;
        let toFilter: string | undefined;
        const grepTerms: string[] = [];
        for (let i = 0; i < rest.length; i++) {
          const tok = rest[i] ?? '';
          const low = tok.toLowerCase();
          if (/^\d+$/.test(tok)) {
            n = Number.parseInt(tok, 10) || 20;
          } else if ((low === 'from' || low === '--from') && rest[i + 1]) {
            fromFilter = (rest[++i] ?? '').toLowerCase();
          } else if ((low === 'to' || low === '--to') && rest[i + 1]) {
            toFilter = (rest[++i] ?? '').toLowerCase();
          } else if (low === 'grep' || low === '--grep') {
            grepTerms.push(...rest.slice(i + 1));
            break;
          } else {
            grepTerms.push(tok);
          }
        }
        const hasFilter = Boolean(fromFilter || toFilter || grepTerms.length);
        // Over-fetch when filtering so the post-filter slice still yields n.
        const messages = await mb.query({ limit: hasFilter ? Math.max(n, 500) : n });
        const grep = grepTerms.join(' ').toLowerCase();
        const filtered = messages.filter((m) => {
          if (fromFilter && !m.from.toLowerCase().includes(fromFilter)) return false;
          if (toFilter && !m.to.toLowerCase().includes(toFilter)) return false;
          if (grep) {
            const hay = `${m.subject ?? ''} ${m.body ?? ''}`.toLowerCase();
            if (!hay.includes(grep)) return false;
          }
          return true;
        });
        const shown = filtered.slice(0, n);
        if (shown.length === 0) {
          return {
            message: color.dim(hasFilter ? 'No messages match the filter.' : 'No messages yet.'),
          };
        }
        const w = messageWidths(shown, self.id);
        const filterNote = [
          fromFilter && `from~${fromFilter}`,
          toFilter && `to~${toFilter}`,
          grep && `grep "${grep}"`,
        ]
          .filter(Boolean)
          .join(', ');
        const lines = [
          color.bold(`Last ${shown.length} message(s)${filterNote ? ` (${filterNote})` : ''}`),
          // query returns newest-first; show oldest-first for reading flow.
          ...shown.reverse().map((m) => fmtMessage(m, self.id, w.from, w.to)),
        ];
        return { message: lines.join('\n') };
      }

      if (sub === '' || sub === 'inbox') {
        // Unread for the unique id AND the bare base alias ('*' matches both).
        const batches = await Promise.all([
          mb.query({ to: self.id, unreadBy: self.id, limit: 50 }).catch(() => []),
          mb.query({ to: self.base, unreadBy: self.id, limit: 50 }).catch(() => []),
        ]);
        const seen = new Set<string>();
        const unread = batches.flat().filter((m) => {
          if (seen.has(m.id) || m.from === self.id) return false;
          seen.add(m.id);
          return true;
        });
        if (unread.length === 0) {
          return {
            message: color.dim(
              `Inbox empty for ${self.id}. Try /mailbox agents or /mailbox history.`,
            ),
          };
        }
        // Mark read so the agent loop doesn't re-inject what the user saw.
        await Promise.all(
          unread.map((m) =>
            mb.ack({ messageId: m.id, readerId: self.id, read: true }).catch(() => null),
          ),
        );
        const w = messageWidths(unread, self.id);
        const lines = [
          color.bold(`${unread.length} unread message(s) for ${self.id}`),
          ...unread.reverse().map((m) => fmtMessage(m, self.id, w.from, w.to)),
        ];
        return { message: lines.join('\n') };
      }

      if (sub === 'clear') {
        await mb.clearAll();
        return { message: color.green('✓ All messages deleted from the mailbox.') };
      }

      if (sub === 'purge') {
        const result = await mb.purgeStale();
        if (result.totalPurged === 0) {
          return { message: color.green('✓ No stale messages found. Mailbox is clean.') };
        }
        return {
          message:
            `✓ Purged ${result.totalPurged} message(s): ` +
            `${result.completedPurged} completed, ${result.incompletePurged} incomplete. ` +
            `${result.remaining} message(s) remain.`,
        };
      }

      return {
        message: `Unknown subcommand "${sub}". Use: /mailbox [agents|online|send|broadcast|history|clear purge]`,
      };
    },
  };
}
