import { createContextEvidenceState } from '@wrongstack/core/utils';
import type { SlashCommand } from '@wrongstack/core/types';
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
      // silently kill running subagents. Match the set `onFleetKill` reaps
      // (running | idle) so the confirm fires whenever there's fleet work to lose.
      const leaderActive = opts.interruptController?.isRunning?.() ?? false;
      const fleetSubagents = opts.onFleetStatus?.()?.subagents ?? [];
      const subagentCount = fleetSubagents.filter(
        (sa) => sa.status === 'running' || sa.status === 'idle',
      ).length;
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

      if (ctx) {
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
        ctx.lastRequestTokens = undefined;
        ctx.lastRealInputTokens = undefined;
        for (const key of Object.keys(ctx.meta)) ctx.state.deleteMeta(key);
      }
      // Clear on-disk chat history via the session writer
      if (ctx?.session) {
        await ctx.session.clearSession();
      }
      // Clear on-disk history via session store (e.g. pre-existing entries)
      if (opts.sessionStore) {
        await opts.sessionStore.clearHistory(ctx?.session.id ?? '');
      }
      opts.onClear?.();
      await opts.onNewSession?.();
      opts.renderer.clear();
      const msg = 'Session cleared (context and history reset; SAGE preserved).';
      opts.renderer.writeInfo(msg);
      return { message: msg, metadata: { cleared: true } };
    },
  };
}
