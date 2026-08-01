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
import type { SessionWriter, TokenCounter } from '@wrongstack/core/types';
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
  /**
   * Optional context-window snapshot for the resumed session. `tokens` is a
   * flat `number` (sum of `tokenCounter.currentRequestTokens()?.`'s
   * `{ input, cacheRead, cacheWrite }` fields) — the TUI consumer
   * (`packages/tui/src/reducers/composer.ts:561-577`) reads `tokens` as a
   * flat number and gates on `snap.tokens > 0`. Forwarding the raw object
   * would coerce to NaN and silently drop the snapshot at runtime.
   */
  contextSnapshot?: { tokens: number; maxContext: number } | undefined;
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
      (s) => s.sessionId === canonicalSessionId && s.status !== 'stale' && s.pid !== process.pid,
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

  const previousSessionId = agent.ctx.session?.id;
  let identityClaimed = false;
  let writerSwapped = false;
  let openedWriter: SessionWriter | undefined;
  try {
    if (state.activateSessionIdentity) {
      await state.activateSessionIdentity(canonicalSessionId);
      identityClaimed = true;
    }
    const resumed = await state.activeSessionStore.resume(canonicalSessionId);
    openedWriter = resumed.writer;
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
    const oldWriter = agent.ctx.session;
    const oldMessages = [...agent.ctx.messages];
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
    await agent.ctx.flushConversationJournal().catch((err) => {
      console.error(
        JSON.stringify({
          level: 'error',
          event: 'execution.resume_journal_flush_failed',
          message: err instanceof Error ? err.message : String(err),
          timestamp: new Date().toISOString(),
        }),
      );
    });

    // ── Re-point session-scoped sidecars (todos/plan/task) to the resumed
    // session and restore its todo board. Without this the picker resume keeps
    // writing todo edits to the PREVIOUS session's .todos.json and shows an
    // empty board — the boot `--resume` path already restores todos, so this
    // closes that asymmetry. Detach the old checkpoint BEFORE mutating todos so
    // the restore can't leak into the session we are leaving.
    await Promise.resolve(state.detachActiveTodosCheckpoint?.()).catch(() => undefined);
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
      await Promise.resolve(switchProviderAndModel(targetProviderId, targetModel)).catch(
        (err: unknown) => {
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
        },
      );
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
    tokenCounter.account(resumed.data.usage, targetModel, targetProviderId);

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

    return {
      entries,
      nextId: entries.length + 1,
      sessionId: resumed.writer.id,
      contextSnapshot: { tokens, maxContext },
    };
  } catch (err) {
    if (identityClaimed && !writerSwapped && previousSessionId) {
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
