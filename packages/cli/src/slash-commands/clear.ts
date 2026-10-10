import { resetCaptureWindows } from '@wrongstack/core/agent-catalog';
import {
  resetSessionSubagentPolicy,
  unlockSessionSubagentPolicyForSession,
} from '@wrongstack/core/coordination';
import { restoreSessionPermissionOverrides } from '@wrongstack/core/security';
import { restoreRequiredSkillsFromEvents } from '@wrongstack/core/skills';
import type { SessionWriter, SlashCommand } from '@wrongstack/core/types';
import {
  clearLeaderEffortOverride,
  createContextEvidenceState,
  sessionScopedPath,
} from '@wrongstack/core/utils';
import type { SlashCommandContext } from './command-context.js';
import { interruptAll } from './interrupt.js';

export function buildClearCommand(opts: SlashCommandContext): SlashCommand {
  return {
    name: 'clear',
    category: 'Session',
    description: 'Reset the session and start a new one.',
    help: [
      'Usage:',
      '  /clear   Reset the conversation and start a new session',
      '',
      'Wipes everything in the current REPL state: messages, todos, read-file tracking,',
      'file mtimes, meta, and chat history. SAGE is durable and is always',
      'preserved. Use explicit /memory commands to review or delete memory entries.',
      'The terminal is wiped.',
      'Use this when you want a fresh conversation without restarting `wstack`.',
    ].join('\n'),
    async run(_args, ctx) {
      // When an operation is still in flight (leader run, autonomy loop, or a
      // subagent), clearing would abort it and discard its output. Confirm with
      // the user first so a stray `/clear` can't silently kill active work.
      // The gate is skipped when nothing is running, or when no confirm hook is
      // wired (plain/non-TTY surfaces), preserving the previous behavior.
      //
      // `isRunning()` only covers the leader run / autonomy / SDD — it does NOT
      // know about the fleet. `interruptAll()` below unconditionally kills every
      // subagent, so without this extra check a `/clear` at an idle prompt would
      // silently kill running subagents.
      //
      // Only `running` subagents trigger the confirm. `idle` subagents sit in a
      // reusable pool without an inflight runner — the previous `running | idle`
      // filter caused a destructive prompt after ordinary slash-command traffic
      // even when no real work was in flight, which users read as "/clear does
      // nothing" because the cancelled branch deliberately wipes nothing.
      const leaderActive = opts.interruptController?.isRunning?.() ?? false;
      const fleetSubagents = opts.onFleetStatus?.()?.subagents ?? [];
      const subagentCount = fleetSubagents.filter((sa) => sa.status === 'running').length;
      const fleetActive = subagentCount > 0;
      const operationActive = leaderActive || fleetActive;
      const surfaceConfirm = opts.interruptController?.confirmClear;
      if (operationActive && (surfaceConfirm || opts.confirm)) {
        const proceed = surfaceConfirm
          ? await surfaceConfirm({ leaderActive, subagentCount })
          : await opts.confirm?.(
              'An operation is still running. Clear anyway? This will stop it and reset the session.',
              false,
            );
        if (proceed !== true) {
          const cancelledMsg = 'Clear cancelled — the running operation was left untouched.';
          opts.renderer.writeInfo(cancelledMsg);
          return { message: cancelledMsg, metadata: { cleared: false } };
        }
      }

      // Establish the reset boundary before mutating context or persistence.
      // Otherwise an in-flight TUI stream (or subagent) can finish after these
      // clears and append old-session output back into the fresh session.
      opts.interruptController?.resetSession?.();
      await interruptAll(opts);
      await opts.interruptController?.waitForIdle?.();

      // Drain the conversation journal BEFORE clearing session state. The
      // journal queue holds references to every pending SessionEvent —
      // including the entire message history. If we skip this flush, those
      // message objects survive in RAM until the drain naturally fires,
      // which can be indefinitely after a /clear. Flushing synchronously
      // here writes them to disk and releases the references.
      await ctx?.flushConversationJournal?.();

      let nextSession: SessionWriter | undefined;
      const oldSession = ctx?.session;
      const oldSessionId = oldSession?.id;

      if (opts.sessionStore && typeof opts.sessionStore.create === 'function' && ctx) {
        try {
          nextSession = await opts.sessionStore.create({
            id: '',
            title: '',
            model: ctx.model ?? '',
            provider: ctx.provider?.id ?? '',
          });
          if (oldSession) {
            await oldSession.close().catch(() => {});
          }
          // `AgentContext.session` is a read-only RunEnv view, but the concrete
          // Context behind it owns the single live writer and is mutable (same
          // swap `/resume` and project-switch perform). Narrow the cast to that.
          (ctx as { session: SessionWriter }).session = nextSession;
          if (opts.sessionRef) {
            opts.sessionRef.current = nextSession;
          }
        } catch {
          // If creation fails, fallback to clearing existing session on disk
        }
      }

      // Clear on-disk chat history via the session writer if no new session was created
      if (!nextSession && oldSession) {
        await oldSession.clearSession();
      }
      // Clear on-disk history via session store (e.g. pre-existing entries)
      if (opts.sessionStore && oldSessionId && !nextSession) {
        await opts.sessionStore.clearHistory(oldSessionId);
      }

      if (ctx) {
        resetSessionSubagentPolicy(ctx);
        restoreSessionPermissionOverrides(ctx.meta, {});
        clearLeaderEffortOverride(ctx.meta);
        restoreRequiredSkillsFromEvents(ctx, []);
        ctx.state.replaceMessages([]);
        ctx.state.replaceTodos([]);
        // Prefer the complete Context reset when available: it also clears
        // written-file hashes and the side-effect trail, not just read mtimes.
        if (typeof ctx.clearFileTracking === 'function') ctx.clearFileTracking();
        else {
          ctx.readFiles.clear();
          ctx.fileMtimes.clear();
        }
        ctx.contextEvidence = createContextEvidenceState();
        ctx.toolAdjacencyDirty = false;
        ctx.pendingPostToolContext = undefined;
        ctx.clearMemoryEvidence?.();
        ctx.lastRequestTokens = undefined;
        ctx.lastRealInputTokens = undefined;
        ctx.tokenCounter?.reset?.();
        for (const key of Object.keys(ctx.meta)) ctx.state.deleteMeta(key);

        if (opts.paths && ctx.session?.id) {
          ctx.state.setMeta(
            'plan.path',
            sessionScopedPath(opts.paths.projectSessions, ctx.session.id, '.plan.json'),
          );
          ctx.state.setMeta(
            'task.path',
            sessionScopedPath(opts.paths.projectSessions, ctx.session.id, '.tasks.json'),
          );
        }
      }

      if (oldSessionId) {
        unlockSessionSubagentPolicyForSession(oldSessionId);
      }
      if (ctx?.session?.id) {
        unlockSessionSubagentPolicyForSession(ctx.session.id);
      }

      // A real session boundary. The learning capture budget is documented as
      // "per session", and the time-boxed window already prevents a daemon from
      // starving; resetting here makes the boundary exact so a fresh session
      // starts with its full capture allowance.
      resetCaptureWindows();
      opts.onClear?.();
      await opts.onNewSession?.();
      opts.renderer.clear();
      const msg = 'Session cleared (context and history reset; SAGE preserved).';
      opts.renderer.writeInfo(msg);
      return { message: msg, metadata: { cleared: true } };
    },
  };
}
