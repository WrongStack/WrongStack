/**
 * Session inspection, checkpoints, and rewind route handlers.
 */

import { rehydrateContextEvidenceFromMessages } from '@wrongstack/core/utils';
import type { SessionHandlerShared } from './session-handler-helpers.js';
import { buildInspectPayload } from './session-history.js';
import type { SessionRouteHandlers } from './session-routes.js';
import { errMessage } from './ws-utils.js';

export function createSessionCheckpointHandlers(
  shared: SessionHandlerShared,
): Pick<SessionRouteHandlers, 'inspectSession' | 'listCheckpoints' | 'rewindSession'> {
  const {
    ctx,
    sendTo,
    broadcastToAll,
    result,
    actingSessionId,
    ensureCurrentSession,
    contextForMessage,
    sessionsDirectory,
  } = shared;

  return {
    inspectSession: async (ws, msg) => {
      // A payload-less frame is legal at this boundary (the protocol decoder
      // requires a payload only for server frames) — destructure it the same way
      // the sibling handlers do, so the `Session id is required` response below
      // is actually reachable instead of a TypeError escaping the dispatcher
      // and leaving the client without a response frame (cf. candidateResolve).
      const { id } = (msg as { payload?: { id?: string | undefined } }).payload ?? {};
      if (!id) {
        sendTo(ws, {
          type: 'session.inspect',
          payload: { id: '', error: 'Session id is required' },
        });
        return;
      }
      try {
        const store = ctx.getSessionStore();
        const data = await store.load(id);
        // Best-effort summary lookup — fall back to deriving from events when
        // the session is not in the capped list (older sessions).
        let summary: import('@wrongstack/contracts/types').SessionSummary | undefined;
        try {
          const summaries = await store.list(200);
          summary = summaries.find((s) => s.id === id);
        } catch {
          summary = undefined;
        }
        const payload = buildInspectPayload(summary, data.events, {
          id: data.metadata.id,
          title: data.metadata.title ?? '',
          model: data.metadata.model ?? '',
          provider: data.metadata.provider ?? '',
          startedAt: data.metadata.startedAt,
          endedAt: data.metadata.endedAt,
        });
        sendTo(ws, {
          type: 'session.inspect',
          payload,
        });
      } catch (err) {
        sendTo(ws, {
          type: 'session.inspect',
          payload: {
            id,
            error: errMessage(err),
          },
        });
      }
    },
    listCheckpoints: async (ws, msg) => {
      if (!ensureCurrentSession(ws, msg, 'session.checkpoints')) return;
      try {
        const { DefaultSessionRewinder } = await import('@wrongstack/core/storage');
        const projectRoot = ctx.getProjectRoot();
        const rewinder = new DefaultSessionRewinder(sessionsDirectory(), projectRoot);
        const checkpoints = await rewinder.listCheckpoints(actingSessionId(msg));
        sendTo(ws, {
          type: 'session.checkpoints',
          payload: { checkpoints, sessionId: actingSessionId(msg) },
        });
      } catch {
        sendTo(ws, {
          type: 'session.checkpoints',
          payload: { checkpoints: [], sessionId: actingSessionId(msg) },
        });
      }
    },
    rewindSession: async (ws, msg) => {
      if (!ensureCurrentSession(ws, msg, 'session.rewind')) return;
      // Payload-less frames are legal here too — see inspectSession above.
      const { checkpointIndex } =
        (msg as { payload?: { checkpointIndex?: number | undefined } }).payload ?? {};
      // The old non-optional cast asserted a number the wire may never carry;
      // rewind truncates a journal, so refuse rather than rewind to `undefined`.
      if (typeof checkpointIndex !== 'number') {
        result(ws, false, 'checkpointIndex is required');
        return;
      }
      // Rewind truncates the session journal AND reverts project files, so
      // running it under a live run destroys the in-flight turn's journal
      // window and reverts files its tools are mid-way through editing — the
      // same destructive window `session.delete` refuses. A client's view of
      // the run state can lag, so the guard is enforced here, server-side.
      const targetSessionId = actingSessionId(msg);
      if (ctx.isRunActive?.(targetSessionId)) {
        result(ws, false, 'Cannot rewind while an agent run is active. Please stop the run first.');
        return;
      }
      try {
        const { applyRewindToConversation, DefaultSessionRewinder } = await import(
          '@wrongstack/core/storage'
        );
        const projectRoot = ctx.getProjectRoot();
        const rewinder = new DefaultSessionRewinder(sessionsDirectory(), projectRoot);
        const target = contextForMessage(msg);
        // Refuse to rewind a session whose journal this process does not
        // actually hold open: cutting the file while another context still
        // appends to it leaves the two out of step. A peek-less host that
        // cannot resolve the session lands here too (target null).
        if (!target || target.session?.id !== targetSessionId) {
          result(ws, false, `Session ${targetSessionId} is not open in this runtime`);
          return;
        }
        const reverted = await rewinder.rewindToCheckpoint(targetSessionId, checkpointIndex);
        // Cut the live conversation too — the replay below comes from the
        // session's own state, so truncating only the JSONL would replay the
        // rewound turns straight back to the client and leave them in the
        // model's working set.
        await applyRewindToConversation({
          session: target.session,
          state: target.state,
          sessionsDir: sessionsDirectory(),
          promptIndex: checkpointIndex,
          revertedFiles: reverted.revertedFiles,
          meta: target.meta,
          onMessagesReplaced: (messages) => rehydrateContextEvidenceFromMessages(target, messages),
        });
        result(ws, true, `Rewound to checkpoint ${checkpointIndex}`);
        broadcastToAll({
          type: 'session.start',
          payload: await ctx.sessionStartPayload({ reset: true, sessionId: targetSessionId }),
        });
      } catch (err) {
        result(ws, false, errMessage(err));
      }
    },
  };
}
