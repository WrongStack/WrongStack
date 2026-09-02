import { memo } from 'react';
import { cn } from '@/lib/utils';
import { getWSClient } from '@/lib/ws-client';
import type { ChatMessage } from '@/stores';
import { chatLane, DEFAULT_LANE_ID, useChatLanes } from '@/stores/chat-lanes';
import { ShieldAlert } from 'lucide-react';
import { openMainView } from '@/lib/view-navigation';
import { useChimeraHubStore } from '@/stores/chimera-hub-store';
import { useChimeraReportsStore } from '@/stores/chimera-reports-store';

/**
 * ChimeraReportCard — an actionable Chimera review report, surfaced IN the
 * transcript of the tab whose session was reviewed.
 *
 * Why a card and not just a toast: the toast vanishes; the review outlives it.
 * When the leader of this tab has finished its run and is waiting, this card
 * is the standing "you need to take action" surface, and its single button
 * auto-submits a well-formed prompt to THAT tab's leader through the normal
 * user-message path — no retyping, no mailbox spelunking.
 *
 * Gating: while the lane is busy (a run is active) the button is disabled —
 * the card waits, like the user would, instead of interrupting a live run.
 * After the prompt is sent the card flips to a sent state and can never
 * double-fire (both `chimeraReport.actionedAt` on the message and
 * `actionedAt` in the chimera-reports store record it).
 */
export const ChimeraReportCard = memo(function ChimeraReportCard({
  message,
  sessionId,
}: {
  message: ChatMessage;
  sessionId: string;
}) {
  const report = message.chimeraReport;
  const laneBusy = useChatLanes((s) => s.lanes[sessionId]?.isLoading ?? false);
  if (!report) return null;
  const sent = report.actionedAt != null;

  const sendPrompt = () => {
    if (sent || laneBusy) return;
    const prompt =
      `Take a look at the tasks mentioned in this Chimera report (${report.reportId}) — ` +
      'review the findings it flagged for this session and address them.';
    const lane = chatLane(sessionId);
    lane.addMessage({ role: 'user', content: prompt });
    lane.patch({ isLoading: true });
    // The lane sentinel ('__unbound__') is not a session id — sending it as
    // one would have the server refuse the frame as an unknown session.
    getWSClient().sendMessage(
      prompt,
      undefined,
      false,
      sessionId !== DEFAULT_LANE_ID ? sessionId : undefined,
    );
    lane.updateMessage(message.id, {
      chimeraReport: { ...report, actionedAt: Date.now() },
    });
    useChimeraReportsStore.getState().markActioned(sessionId, report.reportId, Date.now());
  };

  return (
    <div
      className="mx-auto max-w-6xl w-full px-3 sm:px-5 lg:px-6 py-1"
      data-chimera-report-card={report.reportId}
    >
      <div className="rounded-xl border border-warning/30 bg-warning/[0.06] px-4 py-3 space-y-2">
        <div className="flex items-baseline gap-2 text-sm font-semibold min-w-0">
          <span aria-hidden>🦂</span>
          <span className="shrink-0">Chimera report — action needed</span>
          <span className="text-xs font-normal text-muted-foreground truncate">
            report {report.reportId}
          </span>
        </div>
        <p className="text-sm text-muted-foreground whitespace-pre-wrap break-words">
          {message.content}
        </p>
        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            onClick={sendPrompt}
            disabled={sent || laneBusy}
            title={
              sent
                ? 'Prompt sent to the leader'
                : laneBusy
                  ? 'Waiting for the leader to finish its current run'
                  : 'Send the leader a prompt to work through this report'
            }
            className={cn(
              'inline-flex min-h-11 items-center gap-2 rounded-lg px-4 py-2 text-sm font-medium transition-colors',
              sent || laneBusy
                ? 'cursor-not-allowed border border-border bg-muted text-muted-foreground'
                : 'bg-primary text-primary-foreground hover:bg-primary/90 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary',
            )}
          >
            {sent
              ? 'Prompt sent ✓'
              : laneBusy
                ? 'Leader is running…'
                : 'Take action — have the leader review it'}
          </button>
          <button
            type="button"
            onClick={() => {
              useChimeraHubStore.getState().selectReport(report.reportId);
              openMainView('chimera');
            }}
            className="inline-flex min-h-11 items-center gap-1.5 rounded-lg border border-border bg-background px-3 py-2 text-xs font-medium text-foreground hover:bg-muted transition-colors"
          >
            <ShieldAlert size={14} />
            <span>Open in Chimera Hub</span>
          </button>
        </div>
      </div>
    </div>
  );
});
