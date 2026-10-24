import { resolvePendingConfirmsForSession } from '@wrongstack/webui-server';
export function createWebuiSessionRetirement(inputs: {
  opts: import('./webui-server-options.js').CliWebUIOptions;
  getForegroundSession: () => import('@wrongstack/contracts/types').SessionWriter;
  pendingConfirms: Map<string, import('@wrongstack/webui-server').PendingConfirm>;
  abortControllers: Map<string, AbortController>;
  sessionAgents: import('@wrongstack/webui-server').SessionAgentRegistry;
}) {
  const { opts, getForegroundSession, pendingConfirms, abortControllers, sessionAgents } = inputs;

  /**
   * Retire the runtime of a tab that was closed.
   *
   * A closed tab used to leave everything behind: its Agent, that agent's
   * whole in-memory transcript, and an OPEN journal writer with a live file
   * handle. Nothing ever asked for them again, and the next session to need a
   * slot evicted a tab the user still had open instead.
   *
   * Two refusals, both deliberate:
   *   - a session with a live run keeps its agent, because the run outlives
   *     the tab that started it and still needs somewhere to write;
   *   - the boot session keeps its agent, because that agent IS the leader
   *     the whole host is wired to.
   */
  const retireUndisplayedSessions = (sessionIds: string[]): void => {
    for (const sessionId of sessionIds) {
      if (!sessionId || sessionId === opts.session.id) continue;
      if (sessionId === getForegroundSession().id) continue;
      // Whatever happens to the agent, a permission prompt this session raised
      // is now unanswerable: it was parked on the closed tab's lane and that
      // lane is gone. Leaving it pending wedges `agent.run` forever, and a run
      // that never settles never releases its lock — which is what turned a
      // closed tab into a session that could neither be stopped nor deleted.
      const orphaned = resolvePendingConfirmsForSession(pendingConfirms, sessionId);
      if (orphaned > 0) {
        console.log(
          JSON.stringify({
            level: 'warn',
            event: 'webui.confirm_orphaned_by_tab_close',
            sessionId,
            count: orphaned,
            message: `Denied ${orphaned} unanswerable permission prompt(s) for closed session ${sessionId}.`,
          }),
        );
      }
      if (abortControllers.has(sessionId)) continue;
      // Past the live-run check: nothing this conversation started is still
      // going, so the background helpers pinned to it (explore companion,
      // shadow-review bookkeeping) have nothing left to watch.
      opts.onSessionRetired?.(sessionId);
      const agent = sessionAgents.peek(sessionId);
      if (!agent || agent === opts.agent) continue;
      // Ends the journal (`session_end`, then close) and forgets the agent.
      // The marker is not optional: "no trailing session_end" is exactly how
      // recovery recognises a journal a crash left hanging
      // (`SessionRecovery.listUnclosed`, `resolveSessionOutcome`), so without
      // it every tab the user closed on purpose was indistinguishable from one
      // that died — the recovery list filled up with finished work and the
      // history showed those sessions with no outcome at all.
      //
      // Fire-and-forget: the registry entry is gone before this returns, and
      // nothing the closing tab does next depends on the journal's last write.
      void sessionAgents.endAndClose(sessionId);
    }
  };
  return { retireUndisplayedSessions };
}
