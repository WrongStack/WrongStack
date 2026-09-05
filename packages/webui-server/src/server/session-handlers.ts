/**
 * Session route handlers — composed from focused handler modules.
 * Handles session lifecycle (new/clear/resume/save/delete/rename/subscribe).
 */

import {
  mailboxSessionTag,
  resetSessionSubagentPolicy,
  restoreSessionSubagentPolicy,
} from '@wrongstack/core/coordination';
import { loadTodosCheckpoint } from '@wrongstack/core/storage';
import { projectLastRequestTokens } from '@wrongstack/core/types/session-timeline';
import { sessionScopedPath } from '@wrongstack/core/utils';
import { buildReplayPayload, type ReplaySource } from '@wrongstack/webui-protocol';
import { createSessionCheckpointHandlers } from './session-checkpoint-handlers.js';
import { createSessionContextHandlers } from './session-context-handlers.js';
import { deleteWebUISession } from './session-deletion.js';
import {
  buildSessionHandlerShared,
  collectDisplayedSessionIds,
  displayedByAnyClient,
  MAX_SUBSCRIBED_SESSIONS,
  RUN_STOP_GRACE_MS,
  type SessionHandlersContext,
  waitForRunToStop,
} from './session-handler-helpers.js';
import { toSessionHistoryEntries } from './session-history.js';
import { createSessionModeHandlers } from './session-mode-handlers.js';
import type { SessionRouteHandlers } from './session-routes.js';
import { errMessage } from './ws-utils.js';

export {
  collectDisplayedSessionIds,
  createSessionTransitionGate,
  type SessionHandlersContext,
} from './session-handler-helpers.js';

export function createSessionHandlers(ctx: SessionHandlersContext): SessionRouteHandlers {
  const shared = buildSessionHandlerShared(ctx);
  const {
    currentConfig,
    sendTo,
    sendSessionStart,
    sendTodosUpdated,
    broadcastToAll,
    result,
    sendResumeProgress,
    sessionsDirectory,
    resetContextAccounting,
    activateSession,
    currentSessionId,
    requestedSessionId,
    replacedSessionId,
    peekForRead,
    replaySourceFor,
    sendSessionReplay,
    actingSessionId,
    ensureCurrentSession,
    serializeSessionTransition,
    finalizeSession,
  } = shared;

  const contextHandlers = createSessionContextHandlers(shared);
  const modeHandlers = createSessionModeHandlers(shared);
  const checkpointHandlers = createSessionCheckpointHandlers(shared);

  return {
    ...contextHandlers,
    ...modeHandlers,
    ...checkpointHandlers,

    newSession: (ws, msg) =>
      serializeSessionTransition(async () => {
        if (!ensureCurrentSession(ws, msg, 'session.new')) return;
        const requestedVariant = (msg as { payload?: { systemPromptVariant?: unknown } })?.payload
          ?.systemPromptVariant;
        if (typeof requestedVariant === 'string' && ctx.systemPrompt?.applyVariant) {
          try {
            await ctx.systemPrompt.applyVariant(requestedVariant);
          } catch {
            // best-effort
          }
        }
        // `session.new` opens an ADDITIONAL session (a new WebUI tab). It must
        // never touch an existing one. The old code read `payload.sessionId` —
        // which every client stamps with the *currently active* session — as
        // "the session being replaced", then aborted its run and closed its
        // journal writer. Opening a tab killed whatever was running.
        //
        // Replacement is now opt-in and explicit: only `replaceSessionId`
        // requests it, and only for a session that actually exists.
        const explicitTarget = replacedSessionId(msg);
        if (explicitTarget) {
          try {
            ctx.abortActiveRun?.(explicitTarget);
          } catch {
            // best-effort
          }
        }
        const clearedSessionId = explicitTarget;
        if (ctx.canSwapSessions?.() !== false) {
          const store = ctx.getSessionStore();
          const config = currentConfig();
          const next = await store.create({
            id: '',
            title: '',
            model: config.model,
            provider: config.provider,
          });
          let rollbackClaim: (() => Promise<void>) | undefined;
          let activated = false;
          try {
            rollbackClaim = await ctx.claimSession?.(next.id);
            if (explicitTarget) {
              const current = ctx.getSession();
              if (current.id === explicitTarget) {
                await ctx.context.flushConversationJournal?.().catch(() => undefined);
                await finalizeSession(current);
              }
            }
            // activateSession cannot fail before replacing the runtime writer:
            // finalizeSession is best-effort and setSession is synchronous.
            activated = true;
            await activateSession(next, []);
            resetSessionSubagentPolicy(ctx.getAgent?.(next.id)?.ctx ?? ctx.context);
          } catch (err) {
            if (!activated) {
              await rollbackClaim?.().catch(() => undefined);
              await next.close().catch(() => undefined);
              await store.delete(next.id).catch(() => undefined);
            }
            result(ws, false, errMessage(err));
            return;
          }
        } else {
          try {
            ctx.abortActiveRun?.(clearedSessionId ?? currentSessionId());
          } catch {
            // Aborting is best-effort
          }
          ctx.context.state.replaceMessages([]);
          ctx.context.state.replaceTodos([]);
          resetContextAccounting();
          ctx.context.clearMemoryEvidence?.();
          ctx.context.readFiles.clear();
          ctx.context.fileMtimes.clear();
          ctx.tokenCounter.reset?.();
        }
        const nextId = ctx.getSession().id;
        const client = ctx.clients?.get(ws);
        if (client) {
          client.sessionId = nextId;
        }
        const startPayload = await ctx.sessionStartPayload({
          reset: true,
          ...(clearedSessionId ? { clearedSessionId } : {}),
          sessionId: nextId,
        });
        sendSessionStart(ws, startPayload);
        try {
          const list = await ctx.getSessionStore().list(200);
          broadcastToAll({
            type: 'sessions.list',
            payload: {
              sessions: toSessionHistoryEntries(list, nextId),
            },
          });
        } catch {
          // best-effort
        }
      }),
    listSessions: async (ws, msg) => {
      const limit = (msg as { payload?: { limit?: number | undefined } }).payload?.limit ?? 50;
      // "Current" means the session of the tab that ASKED, not the one the
      // runtime last switched to. The client keys several behaviours off the
      // flag — the resume button is disabled for it, the "active" filter
      // shows only it, and the empty-session sweep spares it — so answering
      // with the runtime's session disabled resume on a row the user was not
      // on and offered three live tabs' fresh sessions up for deletion.
      const askingSessionId = actingSessionId(msg);
      try {
        const list = await ctx.getSessionStore().list(limit);
        sendTo(ws, {
          type: 'sessions.list',
          payload: {
            sessionId: askingSessionId,
            sessions: toSessionHistoryEntries(list, askingSessionId),
          },
        });
      } catch (err) {
        sendTo(ws, {
          type: 'sessions.list',
          payload: { sessionId: askingSessionId, sessions: [], error: errMessage(err) },
        });
      }
    },
    deleteSession: async (ws, msg) => {
      const { id } = (msg as { payload: { id: string } }).payload;
      // The run check runs OUTSIDE the transition gate on purpose. Aborting a
      // wedged run and waiting for it to unwind can take up to
      // RUN_STOP_GRACE_MS, and the gate is shared with `user_message` setup —
      // holding it that long would stall the next turn in every OTHER tab for
      // a delete that concerns none of them.
      if (ctx.isRunActive?.(id)) {
        // A run whose tab is still open has a Stop button — refuse and let the
        // user press it. A run whose tab is GONE has no surface at all:
        // nothing can stop it, nothing can answer a permission prompt it is
        // blocked on, and nothing will ever release its lock. Refusing that
        // one forever is what turned a closed tab into an undeletable ghost,
        // so an explicit delete of an off-screen session stops the run first.
        if (displayedByAnyClient(ctx, id) || !ctx.abortActiveRun) {
          result(
            ws,
            false,
            'Cannot delete session while an agent run is active. Please stop the run first.',
          );
          return;
        }
        ctx.abortActiveRun(id);
        const stopped = await waitForRunToStop(ctx, id);
        if (!stopped) {
          result(
            ws,
            false,
            `Session ${id} has a run that did not stop within ${RUN_STOP_GRACE_MS}ms. Try again in a moment.`,
          );
          return;
        }
      }
      return serializeSessionTransition(async () => {
        try {
          // The pre-gate check above ran before this gate was acquired, and
          // runs proceed OUTSIDE the gate — only setup is serialised. A
          // queued or auto-submitted message can therefore start a turn in
          // the window between "run checked" and "gate held". Deleting under
          // a live run destroys the journal writer of an in-flight turn, so
          // the decision is re-made here, where it is finally safe to act on.
          if (ctx.isRunActive?.(id)) {
            result(
              ws,
              false,
              `Session ${id} started a run while the delete was being prepared. Stop the run and try again.`,
            );
            return;
          }
          // Deleting the runtime's CURRENT session would strand the host on a
          // record that no longer exists. A client that just closed that tab
          // tags the delete with the session it re-pointed the strip to; move
          // the host onto that live writer first — the same rebind
          // `session.resume` performs for an already-live session. Without a
          // live fallback named, the active-session guard below still refuses.
          const fallback = requestedSessionId(msg);
          if (
            ctx.getSession().id === id &&
            fallback &&
            fallback !== id &&
            ctx.isSessionLive?.(fallback)
          ) {
            const liveWriter = peekForRead(fallback)?.ctx?.session;
            if (liveWriter && liveWriter.id === fallback) {
              ctx.setSession(liveWriter);
              await ctx.onSessionSwapped?.(fallback);
            }
          }
          await deleteWebUISession(
            {
              getActiveSessionId: () => ctx.getSession().id,
              getActiveSessionIds: () => collectDisplayedSessionIds(ctx),
              getSessionStore: ctx.getSessionStore,
              refreshSessions: async () => {
                const list = await ctx.getSessionStore().list(200);
                broadcastToAll({
                  type: 'sessions.list',
                  payload: { sessions: toSessionHistoryEntries(list, ctx.getSession().id) },
                });
              },
            },
            id,
          );
          result(ws, true, `Session ${id} deleted`);
        } catch (err) {
          result(ws, false, errMessage(err));
        }
      });
    },
    renameSession: async (ws, msg) => {
      const payload = (msg as { payload?: { id?: unknown; name?: unknown } }).payload ?? {};
      const id = typeof payload.id === 'string' ? payload.id : '';
      const name = typeof payload.name === 'string' ? payload.name : '';
      if (!id) {
        result(ws, false, 'Session id is required');
        return;
      }
      try {
        await ctx.getSessionStore().rename(id, name);
        result(ws, true, name ? `Renamed session to "${name}"` : `Cleared session name`);
        // Broadcast the refreshed list so every open WebUI reflects the new name.
        try {
          const list = await ctx.getSessionStore().list(200);
          const currentId = ctx.getSession().id;
          broadcastToAll({
            type: 'sessions.list',
            payload: {
              sessions: toSessionHistoryEntries(list, currentId),
            },
          });
        } catch {
          // The rename succeeded; keep the optimistic name and allow manual refresh.
        }
      } catch (err) {
        result(ws, false, errMessage(err));
      }
    },
    /**
     * Serves BOTH `session.resume` and `session.focus`.
     *
     * They differ in exactly one place: what a session this process is already
     * holding gets back. `session.resume` means "open this conversation" and
     * answers with its transcript. `session.focus` means "this tab came to the
     * front" — the runtime's current session, the connection's acting id and
     * the todo board all move, and the transcript is deliberately NOT sent,
     * because the tab is already displaying it and the replay would be the
     * poorer copy (rebuilt from the working set, with no audit markers and
     * fresh message ids).
     *
     * A focus on a session this process is NOT holding falls through to the
     * full resume below — the tab has to be reopened before it can be fronted,
     * which is what a page that outlived its server needs.
     */
    resumeSession: (ws, msg) =>
      serializeSessionTransition(async () => {
        const { id } = (msg as { payload: { id: string } }).payload;
        const focusOnly = (msg as { type?: string }).type === 'session.focus';
        if (ctx.canSwapSessions?.() === false) {
          result(ws, false, 'Session store not available');
          return;
        }
        let rollbackClaim: (() => Promise<void>) | undefined;
        let activated = false;
        try {
          const current = ctx.getSession();
          const store = ctx.getSessionStore();
          const canonicalId = store.resolveId ? await store.resolveId(id) : id;
          const isCurrentSession = canonicalId === current.id;
          // Already open in this process — either it IS the runtime's current
          // session, or it is one of the other tabs, whose writer is still
          // held by its own agent. Both are served from memory. Going down the
          // full resume path for a live session opens a SECOND writer and file
          // handle on the same journal (the first is never closed) and re-reads
          // the whole transcript from disk, and with four tabs that is the cost
          // of every tab click.
          const isLiveHere = isCurrentSession || (ctx.isSessionLive?.(canonicalId) ?? false);
          if (isLiveHere) {
            const client = ctx.clients?.get(ws);
            if (client) {
              client.sessionId = canonicalId;
            }
            // Read the TARGET session's own agent, not the shared root
            // context — with several sessions live, the root context may be
            // pointing at a different tab entirely.
            const activeAgent = peekForRead(canonicalId);
            const activeCtx = activeAgent?.ctx ?? ctx.context;
            const liveMessages = activeCtx?.state?.messages ?? [];
            const currentTodos = activeCtx?.state?.todos ?? [];
            const isRunning = ctx.isRunActive?.(canonicalId) ?? false;
            if (!isCurrentSession) {
              // Move the host's "current session" onto the writer this tab
              // already owns, so presence, identity and the untagged legacy
              // paths follow the foreground — WITHOUT re-opening anything.
              const liveWriter = activeCtx?.session;
              if (liveWriter && liveWriter.id === canonicalId) ctx.setSession(liveWriter);
              await ctx.onSessionSwapped?.(canonicalId);
            }
            const liveReplaySource: ReplaySource = focusOnly
              ? { messages: [] }
              : ((await replaySourceFor(canonicalId)) ?? {
                  messages: liveMessages,
                  events: [],
                  // This session's own pre-flight estimate. Reading the root
                  // context reported the foreground tab's number on a
                  // background tab's context bar.
                  usage: { input: activeCtx?.lastRequestTokens ?? 0, output: 0 },
                });
            const startPayload = await ctx.sessionStartPayload({
              reset: true,
              sessionId: canonicalId,
              isRunning,
              // A focus carries no transcript: see the note on this handler.
              // A resume gets the journal-first source, so an already-live
              // session replays with its markers and tool timings intact —
              // reading the in-memory working set here handed the tab a
              // marker-less, timing-less copy of its own conversation.
              //
              // `replayReason: 'focus'` is the client's only way to tell this
              // frame apart from a genuine in-place clear. Both arrive as
              // `reset: true` with no messages; one means "the tab you already
              // have is now in front", the other means "this conversation was
              // emptied". Inferring it client-side is not possible — the tab
              // store moves the active lane BEFORE it sends the focus, so
              // every test of the form "is this lane the one in front?" is
              // already true when the answer lands, and the frame fell through
              // to `clearMessages()`. Switching back to an open tab therefore
              // wiped its transcript.
              ...(focusOnly ? { replayReason: 'focus' } : buildReplayPayload(liveReplaySource)),
            });
            sendTo(ws, {
              type: 'session.start',
              payload: startPayload,
            });
            sendTo(ws, {
              type: 'todos.updated',
              payload: { sessionId: canonicalId, todos: currentTodos },
            });
            result(ws, true, 'Session is already active');
            return;
          }
          sendResumeProgress(ws, canonicalId, 'reserve_ownership');
          rollbackClaim = await ctx.claimSession?.(canonicalId);
          sendResumeProgress(ws, canonicalId, 'open_journal');
          const resumed = await store.resume(canonicalId, (progress) => {
            sendResumeProgress(ws, canonicalId, 'open_journal', progress);
          });
          if (!ctx.hasSession) {
            await ctx.context.flushConversationJournal?.().catch(() => undefined);
            await finalizeSession(current);
          }
          sendResumeProgress(ws, resumed.writer.id, 'read_sidecars', {
            loadedBytes: 1,
            totalBytes: 1,
          });
          const restoredTodos =
            (await loadTodosCheckpoint(
              sessionScopedPath(sessionsDirectory(), resumed.writer.id, '.todos.json'),
              ctx.events,
              ctx.context.traceId,
              resumed.writer.id,
            ).catch(() => null)) ?? [];
          activated = true;
          sendResumeProgress(ws, resumed.writer.id, 'swap_writer', {
            loadedBytes: 1,
            totalBytes: 1,
          });
          await activateSession(
            resumed.writer,
            resumed.data.messages,
            resumed.data.usage,
            restoredTodos,
            projectLastRequestTokens(resumed.data.events),
          );
          const resumedContext = ctx.getAgent?.(resumed.writer.id)?.ctx ?? ctx.context;
          restoreSessionSubagentPolicy(
            resumedContext,
            resumed.data.events,
            resumed.data.subagentsAllowed,
          );
          const client = ctx.clients?.get(ws);
          if (client) {
            client.sessionId = resumed.writer.id;
          }
          sendResumeProgress(ws, resumed.writer.id, 'replay_history', {
            loadedBytes: 1,
            totalBytes: 1,
          });
          const isRunning = ctx.isRunActive?.(resumed.writer.id) ?? false;
          const targetAgent = ctx.getAgent?.(resumed.writer.id);
          const liveMessages =
            isRunning && targetAgent?.ctx?.messages && targetAgent.ctx.messages.length > 0
              ? targetAgent.ctx.messages
              : resumed.data.messages;
          const startPayload = await ctx.sessionStartPayload({
            reset: true,
            sessionId: resumed.writer.id,
            isRunning,
            // Same builder the connect path uses, so a resume and a reconnect
            // hand the client an identical transcript (markers included).
            ...buildReplayPayload({
              messages: liveMessages,
              events: resumed.data.events,
              usage: resumed.data.usage,
            }),
          });
          sendSessionStart(ws, startPayload);
          // The client resets todos to [] on session.start(reset); push the
          // restored board AFTER so the panel repopulates.
          sendTodosUpdated(ws, { sessionId: resumed.writer.id, todos: restoredTodos });
          try {
            const list = await ctx.getSessionStore().list(200);
            broadcastToAll({
              type: 'sessions.list',
              payload: {
                sessions: toSessionHistoryEntries(list, resumed.writer.id),
              },
            });
          } catch {
            // best-effort
          }
          result(ws, true, `Resumed session ${id}`);
        } catch (err) {
          if (!activated) await rollbackClaim?.().catch(() => undefined);
          result(ws, false, errMessage(err));
          try {
            const list = await ctx.getSessionStore().list(200);
            sendTo(ws, {
              type: 'sessions.list',
              payload: { sessions: toSessionHistoryEntries(list, ctx.getSession().id) },
            });
          } catch {
            // best-effort
          }
        }
      }),
    saveSession: async (ws, msg) => {
      if (!ensureCurrentSession(ws, msg, 'session.save')) return;
      // Name the tab that asked, not the runtime's session: with four tabs
      // open the toast quoted a conversation the user was not looking at.
      result(ws, true, `Session ${actingSessionId(msg)} is auto-saved`);
    },
    /**
     * Declare the sessions this connection is displaying.
     *
     * A WebUI page holds up to four tabs on ONE socket, so the server cannot
     * infer the open set from the last message's `sessionId` — doing that
     * filtered the other three tabs' runs out of every broadcast, which looks
     * from the browser exactly like a background tab that stopped working.
     * The client re-sends the whole set whenever a tab opens or closes, so
     * this is a replace, not a merge: a closed tab must actually stop
     * receiving.
     */
    subscribeSessions: async (ws, msg) => {
      const payload =
        (msg as { payload?: { sessionIds?: unknown; replayFor?: unknown } }).payload ?? {};
      const raw = Array.isArray(payload.sessionIds) ? payload.sessionIds : [];
      const replayFor = new Set(
        (Array.isArray(payload.replayFor) ? payload.replayFor : []).filter(
          (id): id is string => typeof id === 'string' && id.length > 0,
        ),
      );
      const client = ctx.clients?.get(ws);
      if (!client) return;
      const previous = client.sessionIds;
      const next = new Set<string>();
      for (const id of raw) {
        if (typeof id !== 'string' || id.length === 0) continue;
        next.add(id);
        if (next.size >= MAX_SUBSCRIBED_SESSIONS) break;
      }
      // The session this connection is acting on is always part of its set,
      // even if the strip has not caught up with it yet — but the four-id
      // ceiling is a hard one. When the declared set is already full and does
      // not name the acting session, the LAST DECLARED id (rightmost tab)
      // gives up its slot: dropping the acting session instead would make the
      // tab in front look dead, and growing to five is the leak.
      //
      // The safety net only catches a strip that LAGS (the acting session was
      // never declared). A set that previously declared the acting session
      // and now omits it removed it on purpose — the tab closed — and
      // re-adding it would keep a closed tab's session "displayed", blocking
      // its deletion and delivering events to nothing.
      if (client.sessionId && !next.has(client.sessionId) && !previous?.has(client.sessionId)) {
        if (next.size >= MAX_SUBSCRIBED_SESSIONS) {
          const lastDeclared = [...next].at(-1);
          if (lastDeclared !== undefined) next.delete(lastDeclared);
        }
        next.add(client.sessionId);
      }
      client.sessionIds = next.size > 0 ? next : undefined;

      // Hand every NEWLY declared tab its transcript.
      //
      // This is what makes a reload bring all four tabs back. The browser
      // persists its slot list, so after F5 `restoreOpenTabsOnBoot` recreates
      // four lanes — but only the foreground one had ever been given a
      // transcript (`buildInitialPayload` builds exactly one replay, for the
      // runtime's own session). The other three came back as empty chat panes
      // that only filled in if the user happened to click them, and clicking
      // them went down the resume path, which is not what a redisplay should
      // cost.
      //
      // Two gates, both necessary. `replayFor` is the client saying THIS pane
      // is empty — a tab that already shows its chat must not have it replaced
      // by a replay rebuilt from the working set, which carries no live tool
      // cards and no audit markers for a session this process still holds.
      // `!previous.has(id)` keeps it to ids this connection had not declared
      // before, so a later subscribe (a tab opened or closed) cannot re-send
      // transcripts for the tabs that did not change.
      const freshlyDeclared = [...next].filter((id) => replayFor.has(id) && !previous?.has(id));
      for (const id of freshlyDeclared) {
        try {
          await sendSessionReplay(ws, id);
        } catch {
          // Best-effort per tab: one unreadable transcript must not stop the
          // other tabs from coming back.
        }
      }

      // Answer, per declared tab, whether its run is still live.
      //
      // Only the foreground tab is re-announced with `session.start` after a
      // reconnect, and `run.result` — the message that stops a lane's
      // spinner — was broadcast once, while the socket was down. Without this
      // the other tabs spin forever: they count as busy, refuse to be
      // recycled, and offer to abort a run that finished minutes ago. The
      // client re-declares its whole set on every reconnect, so this arrives
      // exactly when it is needed.
      // A host that cannot answer stays silent rather than reporting `false`
      // for a tab that is genuinely running.
      const runActive = ctx.isRunActive;
      if (runActive) {
        for (const id of next) {
          sendTo(ws, {
            type: 'session.run_state',
            payload: { sessionId: id, isRunning: runActive(id) },
          });
        }
      }

      // Give every declared tab a leader in its own roster.
      //
      // `leader_updated` used to be broadcast exactly once, at boot, with the
      // literal id `leader` and the boot session's stamp. One row, one owner:
      // the roster filters fail-CLOSED by session, so tabs 2-4 listed their
      // workers under no leader at all — no leader card, `leaderId`
      // undefined, and the "is the focused agent the leader" check in ChatView
      // permanently false. The id has to be session-scoped as well as the
      // stamp, because a second row under the same key would have re-pointed
      // the first tab's leader at the second tab.
      //
      // `leader@<sessionTag>` is the address the rest of the system already
      // uses for a conversation's leader (mailbox identity, task-result
      // reports, the office map's leader test), so the roster now agrees with
      // it instead of inventing a name. Re-sending on every subscribe is
      // deliberate: it is idempotent in the store and a reconnecting page
      // needs it again.
      for (const id of next) {
        sendTo(ws, {
          type: 'subagent.event',
          payload: {
            kind: 'leader_updated',
            sessionId: id,
            subagentId: `leader@${mailboxSessionTag(id)}`,
            isLeader: true,
            name: 'Leader',
            status: 'idle',
          },
        });
      }

      if (!ctx.onSessionsUndisplayed || !previous) return;
      // Dropped by THIS connection and claimed by no other one. Computed after
      // the assignment above so a second page showing the same session keeps
      // it alive.
      const stillShown = new Set(
        collectDisplayedSessionIds({ getSession: ctx.getSession, clients: ctx.clients }),
      );
      const gone = [...previous].filter((id) => !stillShown.has(id));
      if (gone.length > 0) ctx.onSessionsUndisplayed(gone);
    },
  };
}
