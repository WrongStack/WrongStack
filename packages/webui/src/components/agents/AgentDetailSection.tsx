/**
 * AgentDetailSection — expandable detail panel for an agent card.
 *
 * Shows when a card is expanded:
 * - Tool execution log (last 10, with ok/fail icon + duration)
 * - Current streaming output (partialText)
 * - Configuration block (provider, model, description, taskId)
 */

import {
  Check,
  ChevronDown,
  ChevronUp,
  ExternalLink,
  MessageSquare,
  RotateCcw,
  X,
} from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { AgentTranscript } from '@/components/AgentTranscript';
import { useAppTranslation } from '@/i18n';
import { fmtDuration } from '@/lib/agent-status';
import { cn } from '@/lib/utils';
import type { SubagentView } from '@/stores';
import { EMPTY_AGENT_TRANSCRIPT, selectSessionLeaderId, useFleetStore, useUIStore } from '@/stores';

export interface AgentDetailSectionProps {
  agent: SubagentView;
  isExpanded: boolean;
  /** Called when user clicks "Open in Inspector". */
  onOpenInspector?: () => void | undefined;
}

export function AgentDetailSection({
  agent,
  isExpanded,
  onOpenInspector,
}: AgentDetailSectionProps) {
  const { t } = useAppTranslation();
  const [showAllTools, setShowAllTools] = useState(false);
  const partialRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const [contentHeight, setContentHeight] = useState(0);

  // Measure content height for smooth max-height transition.
  useEffect(() => {
    if (contentRef.current) {
      setContentHeight(isExpanded ? contentRef.current.scrollHeight : 0);
    }
  }, [isExpanded, agent]);

  // Auto-scroll partialText when streaming.
  useEffect(() => {
    if (isExpanded && partialRef.current && agent.status === 'running') {
      partialRef.current.scrollTop = partialRef.current.scrollHeight;
    }
  }, [isExpanded, agent.partialText, agent.status]);

  const toolLog = agent.toolLog ?? [];
  const displayTools = showAllTools ? toolLog : toolLog.slice(0, 10);

  const configItems: Array<{ label: string; value: string | undefined | null }> = [
    { label: t('activity:agents.configProvider'), value: agent.provider },
    { label: t('activity:agents.configModel'), value: agent.model },
    { label: t('activity:agents.configDescription'), value: agent.description },
    { label: t('activity:agents.configTaskId'), value: agent.taskId },
  ].filter((item) => item.value != null && item.value !== '');

  const hasPartial =
    agent.partialText && agent.partialText.length > 0 && agent.status === 'running';

  // ── Transcript ──
  const transcript = useFleetStore(
    (s) => s.agentTranscripts.get(agent.id) ?? EMPTY_AGENT_TRANSCRIPT,
  );
  const [showAllTranscript, setShowAllTranscript] = useState(false);
  const displayTranscript = showAllTranscript ? transcript : transcript.slice(-20);

  return (
    <div
      className="overflow-hidden transition-all duration-[250ms] ease-out"
      style={{ maxHeight: isExpanded ? contentHeight : 0, opacity: isExpanded ? 1 : 0 }}
    >
      <div ref={contentRef} className="space-y-2 px-3 pb-3 pt-0.5">
        {/* ── Tool execution log ── */}
        {toolLog.length > 0 && (
          <div className="space-y-0.5">
            <span className="text-[10px] font-semibold text-muted-foreground uppercase tracking-wider">
              {t('activity:agents.toolLog')} ({toolLog.length})
            </span>
            <div className="space-y-0.5">
              {displayTools.map((tlog) => (
                <div
                  key={tlog.at}
                  className="flex items-center gap-1 text-[10px] font-mono min-w-0"
                >
                  {tlog.ok ? (
                    <Check className="h-2.5 w-2.5 shrink-0 text-success" />
                  ) : (
                    <X className="h-2.5 w-2.5 shrink-0 text-destructive" />
                  )}
                  <span className={cn('truncate', tlog.ok ? '' : 'text-destructive')}>
                    {tlog.name}
                  </span>
                  <span className="tabular-nums text-muted-foreground ml-auto shrink-0">
                    {fmtDuration(tlog.durationMs)}
                  </span>
                </div>
              ))}
              {toolLog.length > 10 && (
                <button
                  type="button"
                  onClick={() => setShowAllTools(!showAllTools)}
                  aria-label={
                    showAllTools ? t('activity:agents.showFewer') : t('activity:agents.showAll')
                  }
                  className="flex items-center gap-0.5 text-[10px] text-primary hover:text-primary/80 transition-colors"
                >
                  {showAllTools ? (
                    <>
                      <ChevronUp className="h-2.5 w-2.5" /> {t('activity:agents.showFewer')}
                    </>
                  ) : (
                    <>
                      <ChevronDown className="h-2.5 w-2.5" /> {t('activity:agents.showAll')} (
                      {toolLog.length})
                    </>
                  )}
                </button>
              )}
            </div>
          </div>
        )}

        {/* ── Streaming output ── */}
        {hasPartial && (
          <div className="space-y-0.5">
            <span className="text-[10px] font-semibold text-muted-foreground uppercase tracking-wider">
              {t('activity:agents.streaming')}
            </span>
            <div
              ref={partialRef}
              className="max-h-20 overflow-y-auto rounded bg-muted/40 p-1.5 text-[10px] font-mono text-muted-foreground leading-snug whitespace-pre-wrap break-all"
            >
              {agent.partialText}
            </div>
          </div>
        )}

        {/* ── Failure detail (failed/timeout only) ── */}
        {(agent.status === 'failed' || agent.status === 'timeout') && (
          <div className="space-y-1.5">
            <div className="flex items-center gap-1">
              <span
                className={cn(
                  'text-[10px] font-semibold uppercase tracking-wider',
                  agent.status === 'failed' ? 'text-destructive' : 'text-warning',
                )}
              >
                {agent.status === 'failed'
                  ? t('activity:agents.failure')
                  : t('activity:agents.timeout')}
              </span>
              <span className="flex-1" />
              {/* Re-run button placeholder (wired in a future phase) */}
              <button
                type="button"
                onClick={(e) => {
                  e.stopPropagation();
                }}
                className="flex items-center gap-0.5 rounded border border-border/50 px-1.5 py-0.5 text-[10px] text-muted-foreground hover:text-foreground hover:bg-accent transition-colors"
                title={t('activity:agents.reRunTitle')}
              >
                <RotateCcw className="h-2.5 w-2.5" />
                {t('activity:agents.reRun')}
              </button>
            </div>

            {/* Error kind + message */}
            {(agent.failureReason || agent.error) && (
              <div
                className={cn(
                  'rounded p-1.5 text-[10px] leading-snug',
                  agent.status === 'failed'
                    ? 'bg-destructive/5 text-destructive'
                    : 'bg-warning/5 text-warning',
                )}
              >
                {agent.failureReason && <div className="font-medium">{agent.failureReason}</div>}
                {agent.error && (
                  <div
                    className={cn(
                      'mt-0.5',
                      agent.status === 'failed' ? 'text-destructive/80' : 'text-warning/80',
                    )}
                  >
                    {agent.error.kind && <span className="font-mono">[{agent.error.kind}] </span>}
                    {agent.error.message}
                  </div>
                )}
              </div>
            )}

            {/* Last 3 tool calls before failure */}
            {toolLog.length > 0 && (
              <div className="space-y-0.5">
                <span className="text-[10px] text-muted-foreground">
                  {t('activity:agents.lastToolCalls', { count: Math.min(3, toolLog.length) })}
                </span>
                <div className="space-y-0.5">
                  {toolLog.slice(0, 3).map((tlog) => (
                    <div
                      key={tlog.at}
                      className="flex items-center gap-1 text-[10px] font-mono min-w-0"
                    >
                      {tlog.ok ? (
                        <Check className="h-2.5 w-2.5 shrink-0 text-success" />
                      ) : (
                        <X className="h-2.5 w-2.5 shrink-0 text-destructive" />
                      )}
                      <span className={cn('truncate', tlog.ok ? '' : 'text-destructive')}>
                        {tlog.name}
                      </span>
                      <span className="tabular-nums text-muted-foreground ml-auto shrink-0">
                        {fmtDuration(tlog.durationMs)}
                      </span>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>
        )}

        {/* ── Configuration block ── */}
        {configItems.length > 0 && (
          <div className="space-y-0.5">
            <span className="text-[10px] font-semibold text-muted-foreground uppercase tracking-wider">
              {t('activity:agents.config')}
            </span>
            <div className="rounded bg-muted/30 p-1.5 space-y-0.5">
              {configItems.map((item) => (
                <div key={item.label} className="flex items-center gap-1 text-[10px] min-w-0">
                  <span className="text-muted-foreground shrink-0">{item.label}:</span>
                  <span className="font-mono truncate text-foreground/90">{item.value}</span>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* ── Transcript pane ── */}
        {transcript.length > 0 && (
          <div className="space-y-0.5">
            <div className="flex items-center gap-1">
              <span className="text-[10px] font-semibold text-muted-foreground uppercase tracking-wider">
                {t('activity:agents.transcript')} ({transcript.length})
              </span>
              {transcript.length > 20 && (
                <button
                  type="button"
                  onClick={() => setShowAllTranscript(!showAllTranscript)}
                  className="ml-auto flex items-center gap-0.5 text-[10px] text-primary hover:text-primary/80 transition-colors"
                >
                  {showAllTranscript ? (
                    <>
                      <ChevronUp className="h-2.5 w-2.5" /> {t('activity:agents.showFewer')}
                    </>
                  ) : (
                    <>
                      <ChevronDown className="h-2.5 w-2.5" /> {t('activity:agents.showAll')}
                    </>
                  )}
                </button>
              )}
            </div>
            <AgentTranscript
              entries={displayTranscript}
              agentName={agent.name}
              compact
              maxHeightClassName="max-h-32"
              showHeader={false}
            />
          </div>
        )}

        {/* ── Quick actions ── */}
        <div className="flex flex-wrap items-center gap-3">
          {onOpenInspector && (
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                onOpenInspector();
              }}
              className="flex items-center gap-1 text-[10px] text-primary hover:text-primary/80 transition-colors"
            >
              <ExternalLink className="h-2.5 w-2.5" />
              {t('activity:agents.openInspector')}
            </button>
          )}
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              // The leader already owns the main chat pane — ignore stray
              // open-chat clicks on its own roster card.
              // Compare against the leader of the agent's OWN session; the
              // process-wide pointer belongs to whichever tab set it last.
              if (selectSessionLeaderId(useFleetStore.getState(), agent.sessionId) === agent.id)
                return;
              const ui = useUIStore.getState();
              ui.setSubagentChatFocus(agent.id, agent.sessionId);
              ui.setCurrentView('chat');
            }}
            className="flex items-center gap-1 text-[10px] text-primary hover:text-primary/80 transition-colors"
          >
            <MessageSquare className="h-2.5 w-2.5" />
            {t('activity:agents.openChat')}
          </button>
        </div>
      </div>
    </div>
  );
}
