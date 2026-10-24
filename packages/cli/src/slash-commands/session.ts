import * as path from 'node:path';
import type { SlashCommand } from '@wrongstack/contracts/types';
import { extractInterruptedTools, SessionRecovery } from '@wrongstack/core/storage';
import { color, toErrorMessage } from '@wrongstack/core/utils';
import type { SlashCommandContext } from './command-context.js';
import {
  formatBytes,
  killSession,
  listLiveAgents,
  listLiveSessions,
  sessionStatusDetail,
  summarizePending,
} from './session-live-status.js';

export { isSafeSessionKillPid } from './session-live-status.js';

export function buildSaveCommand(_opts: SlashCommandContext): SlashCommand {
  return {
    name: 'save',
    category: 'Session',
    description: 'Save current session (auto by default; this forces flush).',
    async run(_args, ctx) {
      if (!ctx?.session) {
        return { message: 'No active session.' };
      }
      // Force buffered events to disk. Do NOT write a session_end here —
      // the session is still running; a mid-stream end marker corrupts
      // outcome/endedAt derivation for recovery and summaries.
      await ctx.session.flush();
      return { message: `Session ${ctx.session.id} flushed.` };
    },
  };
}

export function buildLoadCommand(opts: SlashCommandContext): SlashCommand {
  return {
    name: 'sessions',
    category: 'Session',
    aliases: ['resume', 'load'],
    description:
      'List, resume, move, archive, or recover sessions. /sessions move takes a session to another worktree or project; /sessions archive compresses old JSONL logs.',
    async run(args) {
      const parts = args.split(/\s+/).filter(Boolean);
      const first = parts[0]?.toLowerCase();

      // /sessions status — live session tracking
      if (first === 'status') {
        const targetId = parts[1];
        if (targetId) {
          return sessionStatusDetail(targetId);
        }
        return listLiveSessions();
      }

      // /sessions live — alias for status
      if (first === 'live') {
        return listLiveSessions();
      }

      // /sessions agents — show only agent status across all sessions
      if (first === 'agents') {
        return listLiveAgents();
      }

      // /sessions kill <id> — terminate a running session by PID
      if (first === 'kill') {
        const positional = parts.filter((p) => p !== '--force' && p !== '-y');
        const force = parts.includes('--force') || parts.includes('-y');
        const targetId = positional[1];
        if (!targetId) {
          return { message: 'Usage: /sessions kill <sessionId> [--force]' };
        }
        return killSession(targetId, force ? undefined : opts.confirm);
      }

      // /sessions rename <id> [name...] — set/clear a user-supplied name.
      // The name persists in .summary.json + _index.jsonl and shows up in
      // /sessions list and the WebUI alongside the auto-derived title.
      if (first === 'rename') {
        const targetId = parts[1];
        if (!targetId) {
          return {
            message: color.yellow(
              'Usage: /sessions rename <sessionId> [name...]  (empty name clears)',
            ),
          };
        }
        if (!opts.sessionStore) {
          return { message: color.yellow('No session store configured.') };
        }
        const nameParts = parts.slice(2);
        const name = nameParts.join(' ').trim();
        try {
          const summary = await opts.sessionStore.rename(targetId, name);
          return {
            message: name
              ? color.green(`Renamed ${targetId} → "${name}"`)
              : color.green(`Cleared name on ${targetId} (title: "${summary.title}")`),
          };
        } catch (err) {
          return { message: color.red(`Rename failed: ${toErrorMessage(err)}`) };
        }
      }

      // /sessions move <id> <path> — to another worktree or project. The
      // session must not be open anywhere, this one included.
      if (first === 'move') {
        const targetId = parts[1];
        const targetPath = parts.slice(2).join(' ').trim();
        if (!targetId || !targetPath) {
          return {
            message: color.yellow('Usage: /sessions move <sessionId> <project or worktree path>'),
          };
        }
        if (!opts.sessionStore) {
          return { message: color.yellow('No session store configured.') };
        }
        if (targetId === opts.context?.session?.id) {
          return {
            message: color.yellow(
              'Cannot move the active session. Exit, then run: wstack sessions move <id> --to <path>',
            ),
          };
        }
        try {
          const { moveSessionTo, describeSessionMove } = await import('../session-move.js');
          const result = await moveSessionTo({
            store: opts.sessionStore,
            sessionId: targetId,
            targetPath: path.resolve(opts.projectRoot, targetPath),
          });
          return { message: color.green(describeSessionMove(result)) };
        } catch (err) {
          return { message: color.red(`Move failed: ${toErrorMessage(err)}`) };
        }
      }

      if (first === 'archive') {
        if (!opts.sessionStore?.archive || !opts.sessionStore.archiveIdle) {
          return { message: color.yellow('Session store does not support archive.') };
        }
        const apply = parts.includes('--apply');
        const targetId = parts.filter((p) => p !== '--apply' && p !== 'archive')[0];
        if (targetId) {
          try {
            const result = await opts.sessionStore.archive(targetId);
            return {
              message:
                result.action === 'archived'
                  ? color.green(
                      `Archived ${targetId} (${formatBytes(result.uncompressedBytes)} → ${formatBytes(result.compressedBytes)})`,
                    )
                  : color.dim(
                      `Archive ${result.action}: ${targetId}${result.reason ? ` (${result.reason})` : ''}`,
                    ),
            };
          } catch (err) {
            return { message: color.red(`Archive failed: ${toErrorMessage(err)}`) };
          }
        }
        if (!apply) {
          const preview = await opts.sessionStore.list(1000);
          return {
            message: [
              color.bold(
                'Dry run — gzip existing closed session logs (JSONL stays the resume authority).',
              ),
              color.dim(
                'Last 20 stay hot; everything else is gzipped immediately. /prune still deletes.',
              ),
              color.dim(`Currently listed: ${preview.length} session(s).`),
              '',
              color.dim(
                'Run /sessions archive --apply to compress, or /sessions archive <id> for one session.',
              ),
            ].join('\n'),
          };
        }
        const result = await opts.sessionStore.archiveIdle({ backfill: true });
        return {
          message: `Archived ${color.green(String(result.archived))} · skipped ${color.dim(String(result.skipped))} · failed ${result.failed ? color.red(String(result.failed)) : color.dim('0')}.`,
        };
      }

      if (first === 'rehydrate') {
        const targetId = parts[1];
        if (!targetId) {
          return { message: color.yellow('Usage: /sessions rehydrate <sessionId>') };
        }
        if (!opts.sessionStore?.rehydrate) {
          return { message: color.yellow('Session store does not support rehydrate.') };
        }
        try {
          const result = await opts.sessionStore.rehydrate(targetId);
          return {
            message:
              result.action === 'rehydrated'
                ? color.green(`Rehydrated ${targetId}`)
                : color.dim(`Rehydrate ${result.action}: ${targetId}`),
          };
        } catch (err) {
          return { message: color.red(`Rehydrate failed: ${toErrorMessage(err)}`) };
        }
      }

      // /sessions delete <id> — delete any saved session (not just empty).
      // The active session is protected (mirror the WebUI guard) — resume or
      // start a different session first.
      if (first === 'delete') {
        const targetId = parts[1];
        if (!targetId) {
          return { message: color.yellow('Usage: /sessions delete <sessionId> [--force]') };
        }
        if (!opts.sessionStore) {
          return { message: color.yellow('No session store configured.') };
        }
        const currentId = opts.context?.session?.id;
        if (targetId === currentId) {
          return {
            message: color.yellow(
              'Cannot delete the active session. Resume or start another first.',
            ),
          };
        }
        const force = parts.includes('--force') || parts.includes('-y');
        if (!force && opts.confirm) {
          const ok = await opts.confirm(
            `Delete session ${targetId}? This cannot be undone.`,
            false,
          );
          if (ok !== true) return { message: color.dim('Delete cancelled.') };
        }
        try {
          await opts.sessionStore.delete(targetId);
          return { message: color.green(`Deleted session ${targetId}`) };
        } catch (err) {
          return { message: color.red(`Delete failed: ${toErrorMessage(err)}`) };
        }
      }

      const showIncomplete = parts.includes('--incomplete') || parts.includes('-i');
      const recoverIdx = parts.indexOf('--recover');
      const recoverTarget = recoverIdx >= 0 ? parts[recoverIdx + 1] : undefined;

      if (recoverTarget) {
        if (!opts.paths) {
          return { message: color.yellow('No paths configured — cannot build a recovery plan.') };
        }
        const recovery = new SessionRecovery(opts.paths.projectSessions);
        const plan = await recovery.recover(recoverTarget);
        if (!plan) {
          return {
            message: color.yellow(`No session log found for ${recoverTarget} (or it is empty).`),
          };
        }
        const lines: string[] = [
          color.bold(`Recovery plan for ${plan.sessionId}`),
          `  Stale: ${plan.stale ? color.yellow('yes') : color.green('no')}`,
        ];
        if (plan.context) {
          lines.push(`  Last in-flight context: ${color.cyan(plan.context)}`);
        }
        if (plan.lastCheckpoint && plan.lastCheckpoint.type === 'checkpoint') {
          const cp = plan.lastCheckpoint;
          lines.push(
            `  Last checkpoint: promptIndex=${cp.promptIndex} preview=${color.dim(`"${cp.promptPreview}"`)} at ${color.dim(cp.ts)}`,
          );
        } else {
          lines.push(`  Last checkpoint: ${color.dim('(none — full re-execution)')}`);
        }
        const interruptedTools = extractInterruptedTools(plan);
        if (interruptedTools.length > 0) {
          lines.push(
            `  Interrupted tool call(s) in flight: ${color.yellow(String(interruptedTools.length))}`,
          );
          for (const tool of interruptedTools) {
            const args = tool.argsSummary ? color.dim(` (${tool.argsSummary})`) : '';
            lines.push(`    - ${color.yellow(tool.name)}${args}`);
          }
        }
        lines.push(
          `  Pending events: ${plan.pendingEvents.length} (the work that would re-run on resume)`,
        );
        if (plan.pendingEvents.length > 0) {
          const summary = summarizePending(plan.pendingEvents);
          lines.push(...summary);
        }
        lines.push('');
        lines.push(
          color.dim(
            plan.stale
              ? '  This session crashed mid-iteration. The full re-execution kernel is coming in a follow-up; for now use this plan to decide whether to start fresh.'
              : '  This session ended cleanly; the plan above describes the most recent turn(s) for context.',
          ),
        );
        return { message: lines.join('\n') };
      }

      if (showIncomplete) {
        if (!opts.paths) {
          return {
            message: color.yellow('No paths configured — cannot scan for incomplete sessions.'),
          };
        }
        const recovery = new SessionRecovery(opts.paths.projectSessions);
        // Unclosed, not merely "died mid-iteration": a host killed while the
        // agent sat idle closes its last turn with `in_flight_end` and then
        // simply stops writing, which `listResumable` cannot see. That is the
        // ordinary crash, so listing only mid-iteration ones answered "every
        // recorded run ended cleanly" for a project full of half-finished
        // sessions.
        const unclosed = await recovery.listUnclosed({ limit: 50 });
        if (unclosed.length === 0) {
          return {
            message: color.dim('No incomplete sessions. (Every recorded run ended cleanly.)'),
          };
        }
        const lines: string[] = [
          color.bold(`${unclosed.length} incomplete session(s)`),
          color.dim('  (no trailing session_end — the process never closed the log)'),
          '',
        ];
        for (const s of unclosed) {
          const t = color.dim(s.lastEventTs.slice(0, 19).replace('T', ' '));
          const how = s.stale
            ? color.yellow('died mid-iteration')
            : color.dim('died between turns');
          lines.push(`  ${color.cyan(s.sessionId)}  ${t}  ${how}`);
        }
        lines.push('');
        lines.push(
          color.dim(
            '  Reopen one with `wstack --resume <id>`, or `wstack --recover` for the most recent of them.',
          ),
        );
        return { message: lines.join('\n') };
      }

      if (!opts.sessionStore) return { message: 'No session store configured.' };
      const list = await opts.sessionStore.list(10);
      if (list.length === 0) return { message: 'No saved sessions.' };
      const currentId = opts.context?.session?.id;
      const lines = list.map((s) => {
        // Build a compact stats column: tools, errors, outcome badge.
        const parts: string[] = [];
        parts.push(color.dim(`${s.tokenTotal.toLocaleString()} tok`));
        if (s.toolCallCount) {
          const toolStr = `${s.toolCallCount} call${s.toolCallCount === 1 ? '' : 's'}`;
          parts.push(s.toolErrorCount ? color.yellow(toolStr) : color.cyan(toolStr));
        }
        if (s.iterationCount) parts.push(color.dim(`${s.iterationCount} iter`));
        if (s.outcome) {
          const badge =
            s.outcome === 'completed'
              ? color.green('✓')
              : s.outcome === 'aborted'
                ? color.yellow('⚠')
                : s.outcome === 'error'
                  ? color.red('✗')
                  : color.dim('?');
          parts.push(badge);
        }
        const stat = parts.join(' ');
        const date = color.dim(s.startedAt.slice(0, 16).replace('T', ' '));
        const archived = s.storageState === 'cold' ? color.dim(' gz') : '';
        const isCurrent = s.id === currentId;
        const marker = isCurrent ? color.cyan(' (current)') : '';
        const label = s.name
          ? `${color.bold(s.id)} ${color.cyan(`(${s.name})`)}`
          : color.bold(s.id);
        return `  ${label}${marker}${archived}\n    ${date}  ${stat}\n    ${color.dim(s.title)}`;
      });
      const msg = [
        color.bold(`Recent sessions (${list.length}):`),
        ...lines,
        '',
        color.dim(
          `Resume: /resume to open interactive picker, or wstack resume ${list[0]?.id ?? '<id>'}`,
        ),
        color.dim('Tip: /resume --incomplete — list crashed sessions'),
      ].join('\n');
      opts.renderer.write(msg);
      return { message: msg };
    },
  };
}

export function buildExitCommand(opts: SlashCommandContext): SlashCommand {
  return {
    name: 'exit',
    category: 'App',
    aliases: ['quit', 'q'],
    description: 'Exit the REPL.',
    async run() {
      // Check for uncommitted changes before exit
      if (opts.onBeforeExit) {
        const result = await opts.onBeforeExit();
        if (result?.abort) {
          // warn but allow exit anyway
          await opts.onExit?.();
          return { message: result.message ?? '', exit: true };
        }
      }
      await opts.onExit?.();
      return { exit: true };
    },
  };
}
