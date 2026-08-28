import {
  formatSubagentStructuredReport,
  getSharedProjectMailbox,
  mailboxSessionTag,
  type TaskResultNotification,
} from '@wrongstack/core/coordination';
import type { EventBus } from '@wrongstack/core/kernel';

type ReportTaskResultToLeaderOptions = {
  notification: TaskResultNotification;
  sessionId: string;
  mailboxProjectDir: string;
  events: EventBus;
  getLeaderMailboxId?: (() => string | undefined) | undefined;
};

export async function reportTaskResultToLeader({
  notification: n,
  sessionId,
  mailboxProjectDir,
  events,
  getLeaderMailboxId,
}: ReportTaskResultToLeaderOptions): Promise<void> {
  try {
    const leaderId = getLeaderMailboxId?.() ?? `leader@${mailboxSessionTag(sessionId)}`;
    const mailbox = getSharedProjectMailbox(mailboxProjectDir, events);
    const ok = n.status === 'success';
    const MAX_BODY = 700;
    const failureText = [
      n.errorText ?? n.status,
      n.partialText ? `Partial output:\n${n.partialText}` : '',
    ]
      .filter(Boolean)
      .join('\n\n');
    const successText = n.report ? formatSubagentStructuredReport(n.report) : n.resultText;
    const raw = (ok ? successText : failureText) ?? '(no textual result)';
    const excerpt = raw.length > MAX_BODY ? `${raw.slice(0, MAX_BODY)}…` : raw;
    const title = n.title.length > 80 ? `${n.title.slice(0, 80)}…` : n.title;
    await mailbox.send({
      from: n.subagentName ?? n.subagentId,
      to: leaderId,
      type: 'result',
      subject: `[task ${n.status}] ${title}`,
      body: `${excerpt}\n\n(taskId: ${n.taskId} — ${n.iterations} iterations, ${n.toolCalls} tool calls, ${Math.round(n.durationMs / 1000)}s. Full result: await_tasks(["${n.taskId}"]) or roll_up.)`,
      priority: ok ? 'normal' : 'high',
    });
  } catch {
    // Report-back is best-effort; never disturb task completion.
  }
}
