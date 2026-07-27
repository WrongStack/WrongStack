/**
 * TUI session resume — extracted from the runTui() options literal.
 *
 * Phase C step 2. The onResumeSession callback swaps the agent's session
 * writer, resets token accounting, re-points the crash-recovery lock,
 * and replays the JSONL events as TUI history entries.
 *
 * Reads mutable state from TuiRuntimeState (activeSessionStore,
 * activeRecoveryLock, wpaths).
 */
import * as path from 'node:path';
import type { Agent } from '@wrongstack/core/agent';
import type { EventBus } from '@wrongstack/core/kernel';
import type { TokenCounter } from '@wrongstack/core/types';
import { attachTodosCheckpoint, loadTodosCheckpoint } from '@wrongstack/core/storage';
import { sessionScopedPath } from '@wrongstack/core/utils';
import type { TuiRuntimeState } from './tui-runtime-state.js';

export interface SessionResumeContext {
  state: TuiRuntimeState;
  agent: Agent;
  tokenCounter: TokenCounter;
  switchProviderAndModel:
    | ((providerId: string, modelId: string) => string | null | void | Promise<unknown>)
    | undefined;
  /** App EventBus — forwarded to the re-pointed todos checkpoint for storage.* events. */
  events?: EventBus | undefined;
}

export interface SessionResumeResult {
  entries: unknown[];
  nextId: number;
  sessionId: string;
}

/**
 * Resume a past session by id.
 *
 * Returns the replayed history entries + new session id, or null on
 * failure. Throws if the session is live in another process.
 */
export async function resumeSession(
  ctx: SessionResumeContext,
  sessionId: string,
): Promise<SessionResumeResult | null> {
  const { state, agent, tokenCounter, switchProviderAndModel, events } = ctx;

  if (!state.activeSessionStore) return null;

  // Refuse to resume a session that a LIVE process owns — two
  // writers on one session JSONL corrupt it. Thrown (not null) so
  // the resume picker surfaces the reason instead of a generic
  // failure. Best-effort: a broken registry must not block resume.
  let canonicalSessionId = sessionId;
  try {
    if (state.activeSessionStore.resolveId) {
      canonicalSessionId = await state.activeSessionStore.resolveId(sessionId);
    }
  } catch (err) {
    // Fail closed: without a canonical id the live-session registry cannot
    // prove that another process is not already writing the same journal.
    console.error(
      JSON.stringify({
        level: 'error',
        event: 'execution.resume_id_resolve_failed',
        sessionId,
        message: err instanceof Error ? err.message : String(err),
        timestamp: new Date().toISOString(),
      }),
    );
    return null;
  }
  try {
    const { SessionRegistry } = await import('@wrongstack/core/storage');
    const registry = new SessionRegistry(path.dirname(state.wpaths.globalConfig));
    const live = (await registry.list()).find(
      (s) =>
        s.sessionId === canonicalSessionId && s.status !== 'stale' && s.pid !== process.pid,
    );
    if (live) {
      throw new Error(
        `Session is open in another running wstack (pid ${live.pid}) — it cannot be resumed here while live.`,
      );
    }
  } catch (err) {
    if (err instanceof Error && err.message.startsWith('Session is open')) throw err;
    // registry unreadable — fall through to the normal resume path
  }

  try {
    const resumed = await state.activeSessionStore.resume(canonicalSessionId);
    const meta = resumed.data.metadata;

    // Capture and swap writers BEFORE hydrating. replaceMessages emits the
    // exact recovery snapshot through Context's conversation journal; it must
    // land in the resumed session, never the session we are leaving.
    const oldWriter = agent.ctx.session;
    agent.ctx.session = resumed.writer;

    // Rebuild the agent's conversation context from the resumed messages.
    // Go through the observable state wrapper so subscribers fire and
    // tool-use adjacency is re-checked on the next request.
    agent.ctx.state.replaceMessages(resumed.data.messages);
    await agent.ctx.flushConversationJournal();

    // ── Re-point session-scoped sidecars (todos/plan/task) to the resumed
    // session and restore its todo board. Without this the picker resume keeps
    // writing todo edits to the PREVIOUS session's .todos.json and shows an
    // empty board — the boot `--resume` path already restores todos, so this
    // closes that asymmetry. Detach the old checkpoint BEFORE mutating todos so
    // the restore can't leak into the session we are leaving.
    const sessionsDir = state.wpaths.projectSessions;
    const resumedTodosPath = sessionScopedPath(sessionsDir, resumed.writer.id, '.todos.json');
    await state.detachActiveTodosCheckpoint?.();
    agent.ctx.state.setMeta(
      'plan.path',
      sessionScopedPath(sessionsDir, resumed.writer.id, '.plan.json'),
    );
    agent.ctx.state.setMeta(
      'task.path',
      sessionScopedPath(sessionsDir, resumed.writer.id, '.tasks.json'),
    );
    try {
      const restoredTodos = await loadTodosCheckpoint(resumedTodosPath, events, agent.ctx.traceId);
      agent.ctx.state.replaceTodos(restoredTodos ?? []);
    } catch {
      /* best-effort: a missing/corrupt todos sidecar must not block resume */
    }
    // Re-attach so subsequent todo edits persist to the RESUMED session file.
    state.detachActiveTodosCheckpoint = attachTodosCheckpoint(
      agent.ctx.state,
      resumedTodosPath,
      resumed.writer.id,
      events,
      agent.ctx.traceId,
    );

    // Sync the agent's provider/model to what was used in the resumed session.
    // Route all changes through the live switch callback when available so the
    // provider instance, ConfigStore, auto-compactor denominator, and context
    // chip are refreshed together.
    const currentProviderId = (agent.ctx.provider as { id?: string }).id;
    const targetProviderId =
      typeof meta.provider === 'string' && meta.provider.length > 0
        ? meta.provider
        : currentProviderId;
    const targetModel =
      typeof meta.model === 'string' && meta.model.length > 0 ? meta.model : agent.ctx.model;
    if (
      switchProviderAndModel &&
      targetProviderId &&
      (targetProviderId !== currentProviderId || targetModel !== agent.ctx.model)
    ) {
      await switchProviderAndModel(targetProviderId, targetModel);
    } else if (targetModel !== agent.ctx.model) {
      agent.ctx.model = targetModel;
    }

    // Finalize the current session: append a session_end (so the
    // log ends cleanly and recovery/summaries see a completed
    // session), then close (flush + summary sidecar + index). Use
    // agent.ctx.session (the currently active writer) rather than
    // the captured `session` variable — the user may have resumed
    // before, in which case `session` is stale.
    // Fire-and-forget: don't block resume on the close.
    if (oldWriter && oldWriter !== resumed.writer) {
      // Capture the OLD session's usage synchronously — the counter
      // is reset for the resumed session below, and this closure
      // runs after that reset.
      const endedUsage = tokenCounter.total();
      void (async () => {
        let appendOk = false;
        try {
          await oldWriter.append({
            type: 'session_end',
            ts: new Date().toISOString(),
            usage: endedUsage,
          });
          appendOk = true;
        } catch (err) {
          console.error(
            JSON.stringify({
              level: 'error',
              event: 'execution.session_end_append_failed',
              message: err instanceof Error ? err.message : String(err),
              timestamp: new Date().toISOString(),
            }),
          );
        }
        // Only close if session_end was successfully appended — closing
        // a partially-written session file corrupts recovery/summaries.
        if (appendOk) {
          try {
            await oldWriter.close();
          } catch (err) {
            console.error(
              JSON.stringify({
                level: 'error',
                event: 'execution.session_close_failed',
                message: err instanceof Error ? err.message : String(err),
                timestamp: new Date().toISOString(),
              }),
            );
          }
        }
      })();
    }

    // Token accounting is per-session: without a reset the resumed
    // session's summary/cost chips inherit the old session's totals.
    tokenCounter.reset();

    // Re-point crash recovery (active.json) at the resumed session —
    // otherwise a crash after this resume would offer recovery for
    // the OLD (cleanly finalized) session and miss the live one.
    // Fire-and-forget: do not block resume on recovery lock errors.
    void (async () => {
      try {
        await state.activeRecoveryLock.clear();
      } catch (err) {
        console.error(
          JSON.stringify({
            level: 'warn',
            event: 'execution.recovery_lock_clear_failed',
            message: err instanceof Error ? err.message : String(err),
            timestamp: new Date().toISOString(),
          }),
        );
      }
      try {
        await state.activeRecoveryLock.write(resumed.writer.id);
      } catch (err) {
        console.error(
          JSON.stringify({
            level: 'error',
            event: 'execution.recovery_lock_update_failed',
            message: err instanceof Error ? err.message : String(err),
            timestamp: new Date().toISOString(),
          }),
        );
      }
    })();

    // Replay the JSONL events as TUI history entries.
    const { replaySessionMessages } = await import('@wrongstack/tui');
    const entries = replaySessionMessages(
      resumed.data.messages,
      resumed.data.events,
      /* startId */ 1,
    );

    return {
      entries,
      nextId: entries.length + 1,
      sessionId: resumed.writer.id,
    };
  } catch (err) {
    console.error(
      JSON.stringify({
        level: 'error',
        event: 'execution.resume_session_failed',
        message: err instanceof Error ? err.message : String(err),
        timestamp: new Date().toISOString(),
      }),
    );
    return null;
  }
}
