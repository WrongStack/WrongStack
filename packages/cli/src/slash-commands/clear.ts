import { createContextEvidenceState, type SlashCommand } from '@wrongstack/core';
import type { SlashCommandContext } from './index.js';
import { interruptAll } from './interrupt.js';

export function buildClearCommand(opts: SlashCommandContext): SlashCommand {
  return {
    name: 'clear',
    category: 'Session',
    description: 'Reset the session and start a new one.',
    help: [
      'Usage:',
      '  /clear                 Reset conversation AND clear persistent memory',
      '  /clear --keep-memory   Reset the conversation but preserve memory entries',
      '',
      'Wipes everything in the current REPL state: messages, todos, read-file tracking,',
      'file mtimes, meta. Memory store entries (all scopes) are cleared too unless',
      '--keep-memory is passed. Chat history on disk is reset. The terminal is wiped.',
      'Use this when you want a fresh conversation without restarting `wstack`.',
    ].join('\n'),
    async run(args, ctx) {
      const keepMemory = /(^|\s)--keep-memory(\s|$)|(^|\s)--keep-mem(\s|$)/.test(args);

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
      const fleetActive = (opts.onFleetStatus?.()?.subagents ?? []).some(
        (sa) => sa.status === 'running' || sa.status === 'idle',
      );
      const operationActive = leaderActive || fleetActive;
      if (operationActive && opts.confirm) {
        const proceed = await opts.confirm(
          'An operation is still running. Clear anyway? This will stop it and reset the session.',
          false,
        );
        if (proceed !== true) {
          const cancelledMsg = 'Clear cancelled — the running operation was left untouched.';
          opts.renderer.writeInfo(cancelledMsg);
          return { message: cancelledMsg };
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
      if (!keepMemory) {
        await opts.memoryStore?.clear();
      }
      opts.onClear?.();
      await opts.onNewSession?.();
      opts.renderer.clear();
      const msg = keepMemory
        ? 'Session cleared (context and history reset; memory preserved).'
        : 'Session cleared (context, memory, and history reset).';
      opts.renderer.writeInfo(msg);
      return { message: msg };
    },
  };
}
