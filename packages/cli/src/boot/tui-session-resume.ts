/**
 * TUI session resume — extracted from the runTui() options literal.
 *
 * Phase C step 2. The onResumeSession callback swaps the agent's session
 * writer, resets token accounting, and replays the JSONL events as TUI
 * history entries.
 *
 * Reads mutable state from TuiRuntimeState (activeSessionStore, wpaths).
 */
import * as path from 'node:path';
import type { Agent } from '@wrongstack/core/agent';
import type { EventBus } from '@wrongstack/core/kernel';
import { attachTodosCheckpoint, loadTodosCheckpoint } from '@wrongstack/core/storage';
import type { ContextSnapshot, SessionWriter, TokenCounter } from '@wrongstack/core/types';
import { sessionScopedPath } from '@wrongstack/core/utils';
import type { TuiRuntimeState } from './tui-runtime-state.js';

interface SessionResumeContext {
  state: TuiRuntimeState;
  agent: Agent;
  tokenCounter: TokenCounter;
  switchProviderAndModel:
    | ((providerId: string, modelId: string) => string | null | void | Promise<unknown>)
    | undefined;
  /** App EventBus — forwarded to the re-pointed todos checkpoint for storage.* events. */
  events?: EventBus | undefined;
}

interface SessionResumeResult {
  entries: unknown[];
  nextId: number;
  sessionId: string;
  /**
   * Optional context-window snapshot for the resumed session. `tokens` is a
   * flat `number` (sum of `tokenCounter.currentRequestTokens()?.`'s
   * `{ input, cacheRead, cacheWrite }` fields) — the TUI consumer
   * (`packages/tui/src/reducers/composer.ts:561-577`) reads `tokens` as a
   * flat number and gates on `snap.tokens > 0`. Forwarding the raw object
   * would coerce to NaN and silently drop the snapshot at runtime.
   */
  contextSnapshot?: ContextSnapshot | undefined;
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
  // Import before claiming/opening the target so a packaging failure leaves
  // the current writer and registry identity untouched.
  const { replaySessionMessages } = await import('@wrongstack/tui');

  // Resolve before reserving so every contender races on one canonical key.
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
  const previousSessionId = agent.ctx.session?.id;
  let identityClaimed = false;
  let resumeClaim: import('@wrongstack/core/storage').SessionResumeClaim | undefined;
  let writerSwapped = false;
  let openedWriter: SessionWriter | undefined;
  // Hoisted so the outer `catch` can restore them when a failure
  // occurs AFTER `writerSwapped = true`. Without this, an unguarded
  // throw anywhere between lines 142-303 would leave `agent.ctx`
  // bound to the resumed session while the caller received `null`
  // (silent corruption: the next user prompt would append to the
  // resumed JSONL under a failed-resume UI).
  let oldWriter: typeof agent.ctx.session | undefined;
  let oldMessages: typeof agent.ctx.messages | undefined;
  let oldSessionRefCurrent: SessionWriter | undefined;
  // Hoisted sidecar captures for the rollback arm. The pre-swap
  // `state.detachActiveTodosCheckpoint` (prior session's todo write
  // handle) and the prior `todos` / `plan.path` / `task.path` values
  // are captured at the moment of the resume-sidecar detach. On a
  // post-swap throw, restoring these values ensures the original
  // session's todos persistence remains wired up — otherwise the
  // original session's `.todos.json` would be silently detached AND
  // the resumed session's checkpoint never bound.
  let previousDetachFn: typeof state.detachActiveTodosCheckpoint;
  let oldTodos: import('@wrongstack/core/agent').TodoItem[] = [];
  let oldPlanPath: unknown;
  let oldTaskPath: unknown;

  try {
    if (state.wpaths.projectSlug && state.wpaths.globalRoot) {
      const { getSessionRegistry } = await import('@wrongstack/core/storage');
      const registry = getSessionRegistry(state.wpaths.globalRoot);
      resumeClaim = await registry.reserveResume({
        sessionId: canonicalSessionId,
        projectSlug: state.wpaths.projectSlug,
        projectRoot: state.projectRoot,
      });
    } else if (state.activateSessionIdentity) {
      // Host adapters predating the reservation API still provide an atomic
      // claim callback. Production WstackPaths always takes the branch above.
      await state.activateSessionIdentity(canonicalSessionId);
      identityClaimed = true;
    }
    const resumed = await state.activeSessionStore.resume(canonicalSessionId);
    openedWriter = resumed.writer;
    if (resumeClaim) {
      await resumeClaim.activate({
        sessionId: canonicalSessionId,
        projectSlug: state.wpaths.projectSlug,
        projectRoot: state.projectRoot,
        projectName: path.basename(state.projectRoot),
        workingDir: agent.ctx.workingDir,
        clientType: 'tui',
        pid: process.pid,
        startedAt: new Date().toISOString(),
      });
      identityClaimed = true;
      await state.activateSessionIdentity?.(canonicalSessionId);
    }
    const meta = resumed.data.metadata;
    const entries = replaySessionMessages(
      resumed.data.messages,
      resumed.data.events,
      /* startId */ 1,
    );
    const sessionsDir = state.wpaths.projectSessions;
    const resumedTodosPath = sessionScopedPath(sessionsDir, resumed.writer.id, '.todos.json');
    const restoredTodos = await loadTodosCheckpoint(
      resumedTodosPath,
      events,
      agent.ctx.traceId,
      resumed.writer.id,
    ).catch(() => null);

    // Capture and swap writers BEFORE hydrating. replaceMessages emits the
    // exact recovery snapshot through Context's conversation journal; it must
    // land in the resumed session, never the session we are leaving.
    // `oldWriter` / `oldMessages` are the function-scoped hoists from line
    // ~108 — reassigning here (rather than shadowing via `const`) lets the
    // outer `catch` at the end of this function restore them when a
    // failure occurs AFTER `writerSwapped = true`.
    oldWriter = agent.ctx.session;
    oldMessages = [...agent.ctx.messages];
    agent.ctx.session = resumed.writer;
    try {
      // Rebuild the agent's conversation context from the resumed messages.
      // Go through the observable state wrapper so subscribers fire and
      // tool-use adjacency is re-checked on the next request.
      agent.ctx.state.replaceMessages(resumed.data.messages);
    } catch (err) {
      agent.ctx.session = oldWriter;
      agent.ctx.state.replaceMessages(oldMessages);
      throw err;
    }
    writerSwapped = true;
    // Repoint the cli-main `sessionRef` so provider-side
    // `getSessionId: () => sessionRef.current?.id` callbacks and the
    // record-mode `bindReplayToContainer` binding (both set up before the
    // resume) follow the resumed session. Without this, every prompt
    // after `/resume` would write to the boot session's JSONL because
    // the ref was only set once at boot (cli-main.ts:317). The ref is
    // optional on TuiRuntimeState, so older hosts that predate the fix
    // simply skip the repoint — same behavior as before.
    if (state.sessionRef) {
      oldSessionRefCurrent = state.sessionRef.current;
      state.sessionRef.current = resumed.writer;
    }
    await agent.ctx.flushConversationJournal().catch((err) => {
      console.error(
        JSON.stringify({
          level: 'error',
          event: 'execution.resume_journal_flush_failed',
          message: err instanceof Error ? err.message : String(err),
          timestamp: new Date().toISOString(),
        }),
      );
      throw err;
    });

    // ── Re-point session-scoped sidecars (todos/plan/task) to the resumed
    // session and restore its todo board. Without this the picker resume keeps
    // writing todo edits to the PREVIOUS session's .todos.json and shows an
    // empty board — the boot `--resume` path already restores todos, so this
    // closes that asymmetry. Detach the old checkpoint BEFORE mutating todos so
    // the restore can't leak into the session we are leaving.
    //
    // Capture the prior sidecar state BEFORE the detach, so the rollback
    // arm can restore it on a post-swap failure. Without this, a throw
    // between the detach (line 195) and the re-attach (line 207) leaves
    // the original session's todos persistence detached AND the resumed
    // session's checkpoint never bound — every subsequent todo edit on
    // the original session would write to nowhere.
    previousDetachFn = state.detachActiveTodosCheckpoint;
    oldTodos = agent.ctx.state.todos
      ? [...(agent.ctx.state.todos as import('@wrongstack/core/agent').TodoItem[])]
      : [];
    oldPlanPath = (agent.ctx.state as { meta?: Record<string, unknown> }).meta?.['plan.path'];
    oldTaskPath = (agent.ctx.state as { meta?: Record<string, unknown> }).meta?.['task.path'];
    await Promise.resolve(previousDetachFn?.()).catch(() => undefined);
    agent.ctx.state.setMeta(
      'plan.path',
      sessionScopedPath(sessionsDir, resumed.writer.id, '.plan.json'),
    );
    agent.ctx.state.setMeta(
      'task.path',
      sessionScopedPath(sessionsDir, resumed.writer.id, '.tasks.json'),
    );
    agent.ctx.state.replaceTodos(restoredTodos ?? []);
    // Re-attach so subsequent todo edits persist to the RESUMED session file.
    try {
      state.detachActiveTodosCheckpoint = attachTodosCheckpoint(
        agent.ctx.state,
        resumedTodosPath,
        resumed.writer.id,
        events,
        agent.ctx.traceId,
      );
    } catch {
      state.detachActiveTodosCheckpoint = undefined;
    }

    // Sync the agent's provider/model to what was used in the resumed session.
    // Route all changes through the live switch callback when available so the
    // provider instance, ConfigStore, auto-compactor denominator, and context
    // chip are refreshed together. If the target provider/model is unavailable,
    // gracefully fall back to the active working provider/model.
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
      try {
        await Promise.resolve(switchProviderAndModel(targetProviderId, targetModel));
      } catch (err) {
        console.error(
          JSON.stringify({
            level: 'error',
            event: 'execution.resume_model_restore_failed',
            provider: targetProviderId,
            model: targetModel,
            message: err instanceof Error ? err.message : String(err),
            timestamp: new Date().toISOString(),
          }),
        );
      }
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
    //
    // Captured BEFORE the token-accounting/snapshot section so the
    // close runs only after the resume has fully succeeded. Earlier
    // versions scheduled this close before token-accounting/snapshot
    // runs, which created a race: any throw in those sections
    // re-bound `agent.ctx.session = oldWriter` (rollback arm) while
    // the close was already in flight against the (resumed) writer.
    // The fix is to defer the close until after the snapshot return.
    let finalizeOldWriter: (() => Promise<void>) | undefined;
    if (oldWriter && oldWriter !== resumed.writer) {
      // Capture the narrowed writer for the async closure below — TS cannot
      // keep the outer guard's narrowing across the mutable let binding.
      const staleWriter = oldWriter;
      // Capture the OLD session's usage synchronously — the counter
      // is reset for the resumed session below, and this closure
      // runs after that reset.
      const endedUsage = tokenCounter.total();
      finalizeOldWriter = async () => {
        let appendOk = false;
        try {
          await staleWriter.append({
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
            await staleWriter.close();
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
      };
    }

    // Token accounting is per-session: without a reset the resumed
    // session's summary/cost chips inherit the old session's totals.
    tokenCounter.reset();
    tokenCounter.account(resumed.data.usage, targetModel, targetProviderId);
    if (typeof resumed.data.usage?.input === 'number' && resumed.data.usage.input > 0) {
      agent.ctx.lastRequestTokens = resumed.data.usage.input;
    }

    // Build the context-window snapshot the TUI uses to refresh its
    // statusline chip and `/context` panel immediately after `/resume`,
    // instead of staying at zero until the next ctx.pct event lands.
    // `tokens` is the provider-reported per-request usage; `maxContext`
    // is the resumed session's provider ceiling. Both fields are
    // optional on the TUI side, so a missing future provider (no
    // capabilities.maxContext) degrades to a 0/anything chip — same as
    // today's behavior — instead of throwing.
    //
    // `currentRequestTokens()` returns `{ input, cacheRead, cacheWrite }`,
    // NOT a flat number. The TUI reducer at `reducers/composer.ts:563`
    // expects a flat `number`; forwarding the object literal would coerce
    // to NaN in the `snap.tokens > 0` guard and silently drop the
    // snapshot at runtime. Sum the three fields explicitly — input
    // accounts for non-cached tokens, cacheRead/cacheWrite account for
    // the prompt-cache hit/miss that the provider already paid for.
    const reqTokens = tokenCounter.currentRequestTokens?.();
    const tokens =
      (typeof reqTokens === 'number' ? reqTokens : 0) +
      (typeof reqTokens?.input === 'number' ? reqTokens.input : 0) +
      (typeof reqTokens?.cacheRead === 'number' ? reqTokens.cacheRead : 0) +
      (typeof reqTokens?.cacheWrite === 'number' ? reqTokens.cacheWrite : 0);
    const maxContext =
      (agent.ctx.provider as { capabilities?: { maxContext?: number } } | undefined)?.capabilities
        ?.maxContext ?? 0;

    const result = {
      entries,
      nextId: entries.length + 1,
      sessionId: resumed.writer.id,
      contextSnapshot: { tokens, maxContext },
    };
    // Now that the resume has fully succeeded, kick off the
    // fire-and-forget oldWriter close. Doing this AFTER the snapshot
    // return means a rollback (from any throw above) re-binds
    // `agent.ctx.session = oldWriter` while the old writer is still
    // open — the close then runs against the still-open writer, not
    // against the resumed writer the rollback just restored.
    if (finalizeOldWriter) void finalizeOldWriter();
    return result;
  } catch (err) {
    if (!identityClaimed) await resumeClaim?.cancel().catch(() => undefined);
    if (identityClaimed && previousSessionId) {
      // Roll identity back regardless of writerSwapped. If we crashed
      // pre-swap, the resume never took effect so the identity must
      // point at the original session. If we crashed post-swap, the
      // failed-resume UI must not leave the user signed into the
      // resumed session's identity.
      await state.activateSessionIdentity?.(previousSessionId).catch((rollbackErr) => {
        console.error(
          JSON.stringify({
            level: 'error',
            event: 'execution.resume_identity_rollback_failed',
            sessionId: previousSessionId,
            message: rollbackErr instanceof Error ? rollbackErr.message : String(rollbackErr),
            timestamp: new Date().toISOString(),
          }),
        );
      });
    }
    if (!writerSwapped) {
      await openedWriter?.close().catch(() => undefined);
    } else {
      // Post-swap failure: restore the agent's writer + messages + sidecars
      // so the failed-resume UI doesn't silently leave the next user
      // prompt writing to the resumed JSONL, and so the original
      // session's todos persistence remains wired up. Best-effort: a
      // throw here would mask the original error, so swallow + log.
      //
      // Restores:
      //   - `agent.ctx.session` from `oldWriter`
      //   - `state.sessionRef.current` from `oldSessionRefCurrent`
      //   - `agent.ctx.messages` from the defensive `oldMessages` copy
      //   - `state.detachActiveTodosCheckpoint` from `previousDetachFn`
      //     (the prior session's todos write handle)
      //   - `agent.ctx.state.todos` from `oldTodos`
      //   - `agent.ctx.state.meta['plan.path']` / `['task.path']` from
      //     `oldPlanPath` / `oldTaskPath` (skip when `undefined` —
      //     missing meta on a legacy session is not a restore target).
      try {
        if (oldWriter !== undefined) agent.ctx.session = oldWriter;
        if (state.sessionRef) state.sessionRef.current = oldSessionRefCurrent;
        if (oldMessages !== undefined) agent.ctx.state.replaceMessages(oldMessages);
        if (previousDetachFn !== undefined) state.detachActiveTodosCheckpoint = previousDetachFn;
        // Always restore the original todos — even when empty. A later
        // throw (e.g. token accounting) lands AFTER `replaceTodos(restoredTodos)`
        // already ran, so the resumed session's board is visible; restoring
        // `[]` is the correct pre-resume truth, not a no-op to skip.
        agent.ctx.state.replaceTodos([...oldTodos]);
        if (oldPlanPath !== undefined) agent.ctx.state.setMeta('plan.path', oldPlanPath);
        if (oldTaskPath !== undefined) agent.ctx.state.setMeta('task.path', oldTaskPath);
      } catch (rollbackErr) {
        console.error(
          JSON.stringify({
            level: 'error',
            event: 'execution.resume_post_swap_rollback_failed',
            message: rollbackErr instanceof Error ? rollbackErr.message : String(rollbackErr),
            timestamp: new Date().toISOString(),
          }),
        );
      }
      if (openedWriter && openedWriter !== oldWriter) {
        await openedWriter.close().catch((closeErr) => {
          console.error(
            JSON.stringify({
              level: 'error',
              event: 'execution.resume_opened_writer_close_failed',
              message: closeErr instanceof Error ? closeErr.message : String(closeErr),
              timestamp: new Date().toISOString(),
            }),
          );
        });
      }
    }
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
