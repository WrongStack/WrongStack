/**
 * Session route handlers — composed from focused handler modules.
 * Handles session lifecycle (new/clear/resume/save/delete/rename/subscribe).
 */

import {
  mailboxSessionTag,
  resetSessionSubagentPolicy,
  unlockSessionSubagentPolicyForSession,
} from '@wrongstack/coordination';
import { restoreSessionPermissionOverrides } from '@wrongstack/core/security';
import { clearLeaderEffortOverride } from '@wrongstack/core/utils';
import { searchProjectHistory } from './project-history-search.js';
import { createSessionCheckpointHandlers } from './session-checkpoint-handlers.js';
import { createSessionContextHandlers } from './session-context-handlers.js';
import { deleteWebUISession } from './session-deletion.js';
import { readFrameCursors, resumeSessionFrames } from './session-event-resume.js';
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
import { withSessionContentState } from './session-history-content.js';
import { createSessionModeHandlers } from './session-mode-handlers.js';
import { createSessionResumeHandler } from './session-resume-handler.js';
import type { SessionRouteHandlers } from './session-routes.js';
import { errMessage } from './ws-utils.js';

export {
  collectDisplayedSessionIds,
  createSessionTransitionGate,
  type SessionHandlersContext,
} from './session-handler-helpers.js';

/** How many recorded conversations a project usage summary reads at most. */
const USAGE_SCAN_LIMIT = 5000;

/**
 * Recorded token totals of a project's conversations per provider and model, from the session
 * catalog. Sessions without a finite total are counted but add no tokens; no price is derived.
 */
function projectUsageSummary(
  summaries: ReadonlyArray<{ provider?: string; model?: string; tokenTotal?: number }>,
) {
  const byModel = new Map<
    string,
    { provider: string; model: string; sessions: number; tokenTotal: number }
  >();
  let tokenTotal = 0,
    sessionsWithTokens = 0;
  for (const summary of summaries) {
    const provider = summary.provider || 'unknown',
      model = summary.model || 'unknown';
    const key = JSON.stringify([provider, model]);
    const row = byModel.get(key) ?? { provider, model, sessions: 0, tokenTotal: 0 };
    row.sessions++;
    const tokens = summary.tokenTotal;
    if (typeof tokens === 'number' && Number.isFinite(tokens) && tokens >= 0) {
      row.tokenTotal += tokens;
      tokenTotal += tokens;
      sessionsWithTokens++;
    }
    byModel.set(key, row);
  }
  return {
    sessions: summaries.length,
    sessionsWithTokens,
    tokenTotal,
    capped: summaries.length >= USAGE_SCAN_LIMIT,
    byModel: [...byModel.values()].sort(
      (a, b) => b.tokenTotal - a.tokenTotal || a.provider.localeCompare(b.provider),
    ),
  };
}

export function createSessionHandlers(ctx: SessionHandlersContext): SessionRouteHandlers {
  const shared = buildSessionHandlerShared(ctx);
  const {
    currentConfig,
    sendTo,
    sendSessionStart,
    broadcastToAll,
    result,
    resetContextAccounting,
    activateSession,
    currentSessionId,
    requestedSessionId,
    replacedSessionId,
    peekForRead,
    sendSessionReplay,
    actingSessionId,
    ensureCurrentSession,
    serializeSessionTransition,
    finalizeSession,
  } = shared;

  /**
   * A connection started showing these sessions. Best-effort: the host uses it
   * to release background-delegation results held while no tab displayed the
   * session, and a failure there must never fail the transition.
   */
  const notifyDisplayed = (sessionIds: string[]): void => {
    if (!ctx.onSessionsDisplayed || sessionIds.length === 0) return;
    try {
      ctx.onSessionsDisplayed(sessionIds);
    } catch {
      // best-effort
    }
  };

  const contextHandlers = createSessionContextHandlers(shared);
  const modeHandlers = createSessionModeHandlers(shared);
  const checkpointHandlers = createSessionCheckpointHandlers(shared);
  const resumeHandler = createSessionResumeHandler(shared, notifyDisplayed);

  return {
    ...contextHandlers,
    ...modeHandlers,
    ...checkpointHandlers,
    ...resumeHandler,

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
            // Cloned from the leader's Context: its session rules must not come along.
            restoreSessionPermissionOverrides(
              (ctx.getAgent?.(next.id)?.ctx ?? ctx.context).meta,
              {},
            );
            // Nor its leader's own effort override.
            clearLeaderEffortOverride((ctx.getAgent?.(next.id)?.ctx ?? ctx.context).meta);
            // The new tab's Context was cloned from the leader's, so it runs
            // whatever tab 1 last chose. The record above was stamped from the
            // live config — the most recent choice made in ANY tab — and the
            // runtime has to follow it, or the status bar and the conversation
            // name different models. Best-effort: a provider that will not
            // rebuild must not fail the session that already exists.
            const newCtx = ctx.getAgent?.(next.id)?.ctx ?? ctx.context;
            if (
              ctx.applyModelSwitch &&
              config.provider &&
              config.model &&
              (newCtx.provider?.id !== config.provider || newCtx.model !== config.model)
            ) {
              await ctx
                .applyModelSwitch(config.provider, config.model, next.id)
                .catch(() => undefined);
            }
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
          resetSessionSubagentPolicy(ctx.context);
          if (clearedSessionId) unlockSessionSubagentPolicyForSession(clearedSessionId);
          unlockSessionSubagentPolicyForSession(currentSessionId());
          if (ctx.context.session?.id)
            unlockSessionSubagentPolicyForSession(ctx.context.session.id);
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
        const store = ctx.getSessionStore();
        const search = (msg.payload as { contentSearch?: unknown } | undefined)?.contentSearch;
        if (search !== undefined) {
          const contentSearch = await searchProjectHistory(store, search, askingSessionId);
          sendTo(ws, {
            type: 'sessions.list',
            payload: { sessionId: askingSessionId, sessions: [], contentSearch },
          });
          return;
        }
        if ((msg.payload as { usageSummary?: unknown } | undefined)?.usageSummary === true) {
          sendTo(ws, {
            type: 'sessions.list',
            payload: {
              sessionId: askingSessionId,
              sessions: [],
              usageSummary: projectUsageSummary(await store.list(USAGE_SCAN_LIMIT)),
            },
          });
          return;
        }
        const rawPage = (msg.payload as { catalogPage?: unknown } | undefined)?.catalogPage;
        if (rawPage !== undefined) {
          if (
            !rawPage ||
            typeof rawPage !== 'object' ||
            Array.isArray(rawPage) ||
            Object.keys(rawPage).some(
              (key) => !['limit', 'offset', 'expectedRevision', 'anchorId'].includes(key),
            )
          )
            throw Error('Invalid history catalog page.');
          if (!store.listPage)
            throw Error('Update the project runtime to use paged conversation history.');
          const options =
            rawPage as import('@wrongstack/contracts/types/session').SessionHistoryPageOptions;
          const page = await store.listPage({ ...options, excludeId: askingSessionId });
          const { sessions, ...catalogPage } = page;
          const rows = toSessionHistoryEntries(sessions, askingSessionId);
          sendTo(ws, {
            type: 'sessions.list',
            payload: {
              sessionId: askingSessionId,
              catalogPage,
              sessions:
                (msg.payload as { includeContentState?: unknown })?.includeContentState === true
                  ? await withSessionContentState(rows, store)
                  : rows,
            },
          });
          return;
        }
        const list = await store.list(limit);
        const rows = toSessionHistoryEntries(list, askingSessionId);
        const includeContentState =
          (msg.payload as { includeContentState?: unknown } | undefined)?.includeContentState ===
          true;
        sendTo(ws, {
          type: 'sessions.list',
          payload: {
            sessionId: askingSessionId,
            sessions: includeContentState ? await withSessionContentState(rows, store) : rows,
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
      // A payload-less frame is legal at this boundary (the protocol decoder
      // requires a payload only for server frames) — refuse it like any
      // other bad input instead of throwing past the dispatcher, which
      // leaves the client without a response frame (cf. candidateResolve).
      const { id } = (msg as { payload?: { id?: string | undefined } }).payload ?? {};
      if (!id) {
        result(ws, false, 'Session id is required');
        return;
      }
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
        (
          msg as {
            payload?: {
              sessionIds?: unknown;
              replayFor?: unknown;
              cursors?: unknown;
              eventEpoch?: unknown;
            };
          }
        ).payload ?? {};
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

      // Reconnect catch-up. A tab that sent a frame cursor gets the frames it
      // missed and keeps its pane; one the log can no longer cover is handled
      // as if it had asked for a replay.
      const frameCursors = readFrameCursors(payload);
      if (frameCursors) {
        const caughtUp = resumeSessionFrames(ws, next, frameCursors);
        for (const id of frameCursors.cursors.keys()) {
          if (caughtUp.has(id)) replayFor.delete(id);
          else replayFor.add(id);
        }
      }

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

      // Every id this connection had not declared before is newly on screen:
      // release background-delegation results held while no tab showed it.
      notifyDisplayed([...next].filter((id) => !previous?.has(id)));

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
