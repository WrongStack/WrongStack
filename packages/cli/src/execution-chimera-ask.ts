import { createHash } from 'node:crypto';
import type { Mailbox } from '@wrongstack/core/coordination';
import type { SessionWriter, StopReason } from '@wrongstack/core/types';

export async function waitForChimeraAskApproval(opts: {
  mailbox: Mailbox;
  messageId: string;
  meta: Record<string, unknown>;
  session: SessionWriter;
  askTimeoutMs: number;
}): Promise<boolean> {
  const rawPoll = (opts.meta['chimeraPollIntervalMs'] as number | undefined) ?? 2_000;
  const pollIntervalMs = Number.isFinite(rawPoll) ? Math.max(0, rawPoll) : 2_000;
  const abortSignal = opts.meta['chimeraAbortSignal'] as AbortSignal | undefined;
  const askStartTime = Date.now();

  let leaderApproved = false;
  let repliesFound = false;
  let nonLeaderReplyCount = 0;
  let pollDone = false;

  const pollNext = (): Promise<void> => {
    if (pollDone) return Promise.resolve();
    const elapsed = Date.now() - askStartTime;
    const remaining = opts.askTimeoutMs - elapsed;
    if (remaining <= 0 || abortSignal?.aborted) {
      pollDone = true;
      return Promise.resolve();
    }
    return new Promise((r) => setTimeout(r, Math.min(pollIntervalMs, remaining))).then(() =>
      pollForReply(),
    );
  };

  const pollForReply = async (): Promise<void> => {
    if (pollDone) return;
    const replies = await opts.mailbox.query({ replyTo: opts.messageId, limit: 5 });
    if (replies.length > 0) {
      repliesFound = true;
      const firstReply = replies[0];
      if (!firstReply) return pollNext();

      const replyFromBase = (firstReply.from ?? '').split('@')[0];
      if (replyFromBase !== 'leader' || firstReply.audience === 'leaders') {
        nonLeaderReplyCount++;
        if (nonLeaderReplyCount >= 5) {
          console.warn(
            JSON.stringify({
              level: 'warn',
              event: 'execution.chimera_ask_non_leader_threshold',
              message: `${nonLeaderReplyCount} non-leader replies seen on chimera ask — stopping poll`,
              timestamp: new Date().toISOString(),
            }),
          );
          pollDone = true;
          return;
        }
        console.warn(
          JSON.stringify({
            level: nonLeaderReplyCount <= 1 ? 'warn' : 'debug',
            event: 'execution.chimera_ask_non_leader_reply',
            message: `Ignoring non-leader reply #${nonLeaderReplyCount} from ${firstReply.from}`,
            timestamp: new Date().toISOString(),
          }),
        );
        return pollNext();
      }

      await opts.mailbox
        .ack({
          messageId: firstReply.id,
          readerId: 'chimera-review',
          read: true,
          completed: true,
        })
        .catch((_ackErr) => {
          console.warn(
            JSON.stringify({
              level: 'warn',
              event: 'execution.chimera_ask_ack_failed',
              message: _ackErr instanceof Error ? _ackErr.message : String(_ackErr),
              replyMessageId: firstReply.id,
              timestamp: new Date().toISOString(),
            }),
          );
        });

      const body = firstReply.body.toLowerCase();
      if (body.trim().length === 0) {
        pollDone = true;
        return;
      }
      leaderApproved =
        /^\s*(?:y(?:es)?|sure|ok(?:ay)?|go ahead|proceed|approve|fix it|please do|do it|yep|yeah)\b/.test(
          body,
        ) || /^\s*👍/.test(body);
      if (leaderApproved) {
        pollDone = true;
        return;
      }
      if (/^\s*(no|don'?t|stop|skip|ignore|cancel|reject|decline)\b/.test(body)) {
        pollDone = true;
        return;
      }

      leaderApproved = /\b(?:y(?:es)?|sure|approve|proceed|go ahead)\b/i.test(body);
      if (leaderApproved) {
        pollDone = true;
        return;
      }

      const hash = createHash('sha256').update(body).digest('hex').slice(0, 12);
      console.warn(
        JSON.stringify({
          level: 'debug',
          event: 'execution.chimera_ask_reply_unmatched',
          replyBodyHash: hash,
          replyBodyLength: body.length,
          timestamp: new Date().toISOString(),
        }),
      );
    }

    return pollNext();
  };

  await pollForReply();
  if (!leaderApproved) {
    await recordChimeraAskFallback(opts.session, opts.askTimeoutMs, repliesFound);
  }
  return leaderApproved;
}

async function recordChimeraAskFallback(
  session: SessionWriter,
  askTimeoutMs: number,
  repliesFound: boolean,
): Promise<void> {
  console.warn(
    JSON.stringify({
      level: 'warn',
      event: repliesFound ? 'execution.chimera_ask_rejected' : 'execution.chimera_ask_timeout',
      message: repliesFound
        ? 'Leader replied to ask but did not approve'
        : 'Ask timeout expired, falling back to off mode (no auto-fix)',
      timestamp: new Date().toISOString(),
    }),
  );

  await session
    .append({
      type: 'llm_response',
      ts: new Date().toISOString(),
      content: [
        {
          type: 'text',
          text: `🦂 Chimera auto-fix request sent to leader — no approval received within ${askTimeoutMs / 1000}s timeout. Falling back to manual review mode. Set autoFix via \`/chimera autoFix auto\` to auto-approve future reviews.`,
        },
      ],
      stopReason: 'end_turn' as StopReason,
      usage: { input: 0, output: 0 },
    })
    .catch((_appendErr) => {
      console.warn(
        JSON.stringify({
          level: 'warn',
          event: 'execution.chimera_timeout_append_failed',
          message: _appendErr instanceof Error ? _appendErr.message : String(_appendErr),
          timestamp: new Date().toISOString(),
        }),
      );
    });
}
