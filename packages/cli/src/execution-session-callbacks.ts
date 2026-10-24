import type { SessionSummary } from '@wrongstack/contracts/types';
import { listGitWorktrees } from '@wrongstack/core/worktree';
import { getLiveSessions } from './boot/tui-live-sessions.js';
import type { TuiRuntimeState } from './boot/tui-runtime-state.js';
import { selectPickerSessions } from './boot/tui-session-stub-enrich.js';
import { type WorktreeRef, worktreeOfSession } from './boot/worktree-sessions.js';
import type { ExecuteDeps } from './execute-deps.js';

export function createExecutionSessionCallbacks({
  state,
  agent,
  session,
  worktreeSessions,
}: {
  state: TuiRuntimeState;
  agent: ExecuteDeps['core']['agent'];
  session: ExecuteDeps['session']['session'];
  worktreeSessions: Map<string, WorktreeRef>;
}) {
  return {
    listSessions: async (limit = 20) => {
      const currentStore = state.activeSessionStore;
      if (!currentStore) return [];
      // Enrichment can raise a stub's lastActivityAt, so selection must
      // happen after enrichment: fetch an over-fetched pool from the
      // store, enrich stubs from their JSONL transcripts, re-sort, slice.
      const summaries = await selectPickerSessions(
        (poolLimit) => currentStore.list(poolLimit),
        state.wpaths.projectSessions,
        limit,
      );
      // Which of these is another process writing right now? Session
      // SUMMARIES carry no liveness — they are built from the journal —
      // so the picker used to offer live sessions as if they were
      // history, and only the host's reservation (seconds and a
      // multi-hundred-MB read later) refused. Cross-reference the
      // registry so the refusal happens before any of that.
      //
      // Best-effort: a registry that cannot be read must not take the
      // picker down with it. The host reservation is still the
      // authority, and it fails closed.
      const liveBySession = new Map<string, { pid: number; clientType?: string | undefined }>();
      try {
        for (const entry of await getLiveSessions({ state })) {
          if (entry.pid == null) continue;
          liveBySession.set(entry.sessionId, {
            pid: entry.pid,
            ...(entry.clientType ? { clientType: entry.clientType } : {}),
          });
        }
      } catch {
        /* liveness is an ADDITIONAL guard, never a listing prerequisite */
      }
      const currentId = agent.ctx.session?.id ?? session.id;
      // All worktrees of the repo share this store; tag the sessions
      // that ran in another checkout (see boot/worktree-sessions.ts).
      const worktrees = await listGitWorktrees(state.projectRoot);
      worktreeSessions.clear();
      const toEntry = (s: SessionSummary, worktree = worktreeOfSession(s, worktrees)) => {
        if (worktree) worktreeSessions.set(s.id, worktree);
        return {
          id: s.id,
          title: s.title ?? '',
          name: s.name,
          lastUserMessage: s.lastUserMessage,
          messageCount: s.messageCount,
          lastActivityAt: s.lastActivityAt,
          startedAt: s.startedAt ?? '',
          endedAt: s.endedAt,
          tokenTotal: s.tokenTotal ?? 0,
          iterationCount: s.iterationCount ?? 0,
          toolCallCount: s.toolCallCount ?? 0,
          toolErrorCount: s.toolErrorCount ?? 0,
          outcome: s.outcome,
          forkedFrom: s.forkedFrom,
          ...(worktree ? { worktree } : {}),
          isCurrent: s.id === currentId,
          // The session this process owns is `isCurrent`, not "live
          // elsewhere" — it holds its own lease and would otherwise be
          // labelled as owned by another surface.
          ...(s.id !== currentId && liveBySession.has(s.id)
            ? { live: liveBySession.get(s.id) }
            : {}),
        };
      };
      return summaries.map((s) => toEntry(s));
    },

    forkSession: async (sessionId: string, checkpointPromptIndex: number) => {
      const store = state.activeSessionStore;
      if (!store?.fork) throw new Error('This session store cannot fork sessions.');
      // From before the prompt: the TUI hands that prompt back to the composer.
      const forked = await store.fork(sessionId, {
        checkpointPromptIndex,
        beforeCheckpointPrompt: true,
      });
      return { id: forked.id };
    },
  };
}
