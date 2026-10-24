/**
 * The `session.resume` / `session.focus` handler: front a session this
 * process holds, or reopen one from the store and replay it to the tab.
 */

import { projectLastRequestTokens } from '@wrongstack/contracts/types/session-timeline';
import { restoreSessionSubagentPolicy } from '@wrongstack/core/coordination';
import { restoreSessionPermissionOverrides } from '@wrongstack/core/security';
import { restoreRequiredSkillsFromEvents } from '@wrongstack/core/skills';
import { loadTodosCheckpoint } from '@wrongstack/core/storage';
import {
  clearLeaderEffortOverride,
  restoreLeaderEffortOverride,
  sessionScopedPath,
} from '@wrongstack/core/utils';
import { buildReplayPayload, type ReplaySource } from '@wrongstack/webui-protocol';
import type { SessionHandlerShared } from './session-handler-helpers.js';
import { toSessionHistoryEntries } from './session-history.js';
import type { SessionRouteHandlers } from './session-routes.js';
import { errMessage } from './ws-utils.js';

export function createSessionResumeHandler(
  shared: SessionHandlerShared,
  notifyDisplayed: (sessionIds: string[]) => void,
): Pick<SessionRouteHandlers, 'resumeSession'> {
  const {
    ctx,
    sendTo,
    sendSessionStart,
    sendTodosUpdated,
    broadcastToAll,
    result,
    sendResumeProgress,
    sessionsDirectory,
    activateSession,
    peekForRead,
    replaySourceFor,
    serializeSessionTransition,
    finalizeSession,
  } = shared;

  return {
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
        // Payload-less frames are legal here too — see deleteSession above.
        const { id } = (msg as { payload?: { id?: string | undefined } }).payload ?? {};
        const focusOnly = (msg as { type?: string }).type === 'session.focus';
        if (!id) {
          result(ws, false, 'Session id is required');
          return;
        }
        if (ctx.canSwapSessions?.() === false) {
          result(ws, false, 'Session store not available');
          return;
        }
        let rollbackClaim: (() => Promise<void>) | undefined;
        let activated = false;
        // The journal `store.resume` opens BEFORE `activateSession` adopts it
        // as the runtime's active writer. If the activation throws, nothing
        // else holds a reference to close it, so it must be closed here.
        let resumeWriterId: string | undefined;
        let closeResumedWriter: (() => Promise<void>) | undefined;
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
            // The tab now shows this session: release background-delegation
            // results held while nobody was displaying it.
            notifyDisplayed([canonicalId]);
            result(ws, true, 'Session is already active');
            return;
          }
          sendResumeProgress(ws, canonicalId, 'reserve_ownership');
          rollbackClaim = await ctx.claimSession?.(canonicalId);
          sendResumeProgress(ws, canonicalId, 'open_journal');
          const resumed = await store.resume(canonicalId, (progress) => {
            sendResumeProgress(ws, canonicalId, 'open_journal', progress);
          });
          resumeWriterId = resumed.writer.id;
          closeResumedWriter = () => resumed.writer.close();
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
          // Only NOW has the resume actually taken the session: activateSession
          // is what installs the writer as the runtime's current session, and it
          // can throw (agent construction, the todo-sidecar rebind, the
          // identity/HQ activation it ends with). Marking it activated before
          // that ran meant any such throw skipped the catch's rollback, leaving
          // the reservation held and the journal `store.resume` opened dangling.
          activated = true;
          const resumedContext = ctx.getAgent?.(resumed.writer.id)?.ctx ?? ctx.context;
          restoreSessionSubagentPolicy(
            resumedContext,
            resumed.data.events,
            resumed.data.subagentsAllowed,
            resumed.data.subagentCompanionsAllowed,
          );
          restoreSessionPermissionOverrides(resumedContext.meta, resumed.data);
          restoreRequiredSkillsFromEvents(resumedContext, resumed.data.events);
          clearLeaderEffortOverride(resumedContext.meta);
          restoreLeaderEffortOverride(resumedContext.meta, resumed.data.events);
          // Re-queue background delegation results this session never
          // received. Never wakes by itself; the tab displaying the session
          // (below) or the next turn picks them up.
          try {
            ctx.rehydrateDelegations?.(resumed.writer.id, resumed.data.events ?? []);
          } catch {
            // best-effort: a bad journal tail must not fail the resume
          }
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
          // Displayed only now, after its transcript: a woken turn must stream
          // into a tab that already shows the conversation it continues.
          notifyDisplayed([resumed.writer.id]);
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
          if (!activated) {
            await rollbackClaim?.().catch(() => undefined);
            // `store.resume` opened this journal; activateSession is the only
            // thing that installs it. When the runtime did not adopt it, close
            // it — otherwise the file handle leaks for the life of the process.
            // (The id check is exact: activateSession sets the runtime's session
            // to the resumed writer, so a surviving id means it was installed.)
            if (closeResumedWriter && ctx.getSession().id !== resumeWriterId) {
              await closeResumedWriter().catch(() => undefined);
            }
          }
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
  };
}
