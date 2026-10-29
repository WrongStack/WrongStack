/**
 * Session inspection, checkpoints, and rewind route handlers.
 */

import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { totalUsageTokens } from '@wrongstack/contracts/types';
import type { CheckpointInfo } from '@wrongstack/contracts/types/session-rewinder';
import { rehydrateContextEvidenceFromMessages, sessionScopedPath } from '@wrongstack/core/utils';
import { buildReplayPayload } from '@wrongstack/webui-protocol';
import type { SessionHandlerShared } from './session-handler-helpers.js';
import { buildInspectPayload } from './session-history.js';
import type { SessionRouteHandlers } from './session-routes.js';
import {
  projectSessionTranscript,
  readSessionTranscriptBlock,
  readSessionTranscriptBlocks,
  readSessionTranscriptImage,
} from './session-transcript.js';
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
  /**
   * Hash of the session journal file, or `undefined` when it cannot be read.
   *
   * The revision is an optional staleness signal: a journal that is not
   * flushed to disk yet, an unreadable file, or an id that fails path
   * validation must never make the checkpoint list or the rewind fail with a
   * raw filesystem error — it only means "no revision available".
   */
  const journalRevision = async (id: string): Promise<string | undefined> => {
    try {
      return createHash('sha256')
        .update(await readFile(sessionScopedPath(sessionsDirectory(), id, '.jsonl')))
        .digest('hex');
    } catch {
      return undefined;
    }
  };

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
        const options = (msg.payload ?? {}) as Record<string, unknown>;
        const transcript = options['transcript']
          ? projectSessionTranscript(data.messages, options['transcript'])
          : undefined;
        const transcriptBlock = options['transcriptBlock']
          ? readSessionTranscriptBlock(data.messages, options['transcriptBlock'])
          : undefined;
        const transcriptImage = options['transcriptImage']
          ? readSessionTranscriptImage(data.messages, options['transcriptImage'])
          : undefined;
        const transcriptBlocks = options['transcriptBlocks']
          ? readSessionTranscriptBlocks(data.messages, options['transcriptBlocks'])
          : undefined;
        if (
          options['transcriptOnly'] === true ||
          transcriptBlock ||
          transcriptImage ||
          transcriptBlocks
        ) {
          sendTo(ws, {
            type: 'session.inspect',
            payload: { id, transcript, transcriptBlock, transcriptImage, transcriptBlocks },
          });
          return;
        }
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
          payload: {
            ...payload,
            ...(transcript ? { transcript } : {}),
            ...(Array.isArray(data.messages) ? { retainedMessageCount: data.messages.length } : {}),
            ...(data.usage ? { journalTokenTotal: totalUsageTokens(data.usage) } : {}),
          },
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
      const sessionId = actingSessionId(msg);
      // The loaded checkpoints outlive a later failure: a stale-journal
      // warning must not blank the list the client is already reviewing.
      let checkpoints: CheckpointInfo[] = [];
      try {
        const { DefaultSessionRewinder } = await import('@wrongstack/core/storage');
        const projectRoot = ctx.getProjectRoot();
        const rewinder = new DefaultSessionRewinder(sessionsDirectory(), projectRoot);
        const includeRevision =
          (msg.payload as { includeRevision?: unknown } | undefined)?.includeRevision === true;
        // The revision is best-effort: an unreadable journal yields no hash,
        // it does not fail the listing.
        const revisionBefore = includeRevision ? await journalRevision(sessionId) : undefined;
        checkpoints = await rewinder.listCheckpoints(sessionId);
        const revisionAfter = includeRevision ? await journalRevision(sessionId) : undefined;
        const revision = revisionAfter ?? revisionBefore;
        if (revisionBefore && revisionAfter && revisionBefore !== revisionAfter) {
          sendTo(ws, {
            type: 'session.checkpoints',
            payload: {
              checkpoints,
              sessionId,
              ...(revision ? { journalRevision: revision } : {}),
              error:
                'The session journal changed while checkpoints were loading. Refresh to review it again.',
            },
          });
          return;
        }
        sendTo(ws, {
          type: 'session.checkpoints',
          payload: {
            checkpoints,
            sessionId,
            ...(revision ? { journalRevision: revision } : {}),
          },
        });
      } catch (error) {
        sendTo(ws, {
          type: 'session.checkpoints',
          payload: { checkpoints, sessionId, error: errMessage(error) },
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
      if (
        typeof checkpointIndex !== 'number' ||
        !Number.isSafeInteger(checkpointIndex) ||
        checkpointIndex < 0
      ) {
        result(ws, false, 'checkpointIndex is required');
        return;
      }
      await shared.serializeSessionTransition(async () => {
        // Rewind truncates the session journal AND reverts project files, so
        // running it under a live run destroys the in-flight turn's journal
        // window and reverts files its tools are mid-way through editing — the
        // same destructive window `session.delete` refuses. A client's view of
        // the run state can lag, so the guard is enforced here, server-side.
        const targetSessionId = actingSessionId(msg);
        if (ctx.isRunActive?.(targetSessionId)) {
          result(
            ws,
            false,
            'Cannot rewind while an agent run is active. Please stop the run first.',
          );
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
          const expected = (msg.payload as { expectedJournalRevision?: unknown } | undefined)
            ?.expectedJournalRevision;
          if (expected !== undefined) {
            if (typeof expected !== 'string') {
              result(
                ws,
                false,
                'The session journal changed after review. Refresh checkpoints before rewinding.',
              );
              return;
            }
            // The client claims a revision; the journal must be readable to
            // check it. When it is not, fail closed with an actionable message
            // instead of a raw filesystem error.
            const current = await journalRevision(targetSessionId);
            if (current === undefined) {
              result(
                ws,
                false,
                'Cannot verify the session journal; refresh checkpoints before rewinding.',
              );
              return;
            }
            if (current !== expected) {
              result(
                ws,
                false,
                'The session journal changed after review. Refresh checkpoints before rewinding.',
              );
              return;
            }
          }
          const reverted = await rewinder.rewindToCheckpoint(targetSessionId, checkpointIndex);
          // Cut the live conversation too — the replay below comes from the
          // session's own state, so truncating only the JSONL would replay the
          // rewound turns straight back to the client and leave them in the
          // model's working set.
          const applied = await applyRewindToConversation({
            session: target.session,
            state: target.state,
            sessionsDir: sessionsDirectory(),
            promptIndex: checkpointIndex,
            revertedFiles: reverted.revertedFiles,
            meta: target.meta,
            onMessagesReplaced: (messages) =>
              rehydrateContextEvidenceFromMessages(target, messages),
          });
          sendTo(ws, {
            type: 'key.operation_result',
            payload: {
              success: true,
              sessionId: targetSessionId,
              message: reverted.errors.length
                ? `Conversation rewound to checkpoint ${checkpointIndex}; ${reverted.errors.length} file restoration errors require attention.`
                : `Rewound to checkpoint ${checkpointIndex}`,
              rewind: {
                toPromptIndex: checkpointIndex,
                revertedFiles: reverted.revertedFiles,
                errors: reverted.errors,
                removedEvents: applied.removedEvents,
                messageCount: applied.messageCount,
              },
            },
          });
          const replay = buildReplayPayload(applied.conversation);
          broadcastToAll({
            type: 'session.start',
            payload: {
              ...(await ctx.sessionStartPayload({ reset: true, sessionId: targetSessionId })),
              ...replay,
              replayMessages: replay.replayMessages ?? [],
            },
          });
        } catch (err) {
          result(ws, false, errMessage(err));
        }
      });
    },
  };
}
