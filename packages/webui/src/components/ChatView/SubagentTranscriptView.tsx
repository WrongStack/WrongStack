/**
 * SubagentTranscriptView — full-pane chat history of one subagent.
 *
 * Shown in place of the leader transcript while an agent tab is selected
 * (see AgentTabs). The agent's complete fleet-store transcript is mapped to
 * the leader's own `ChatMessage` shape (agentTranscriptMessages.ts) and then
 * rendered through the LEADER's row pipeline — buildChatRows → ChatRowView →
 * MessageBubble / ToolGroup / ToolLedgerCard. Reasoning, model output and tool
 * calls are therefore the same components, the same markdown, and the same
 * ledger cards the leader screen uses, rather than a parallel set of lookalike
 * rows that drift from it over time.
 *
 * What stays deliberately different is the AFFORDANCE set: `readOnly` withholds
 * the actions that address the leader's conversation (Retry, Continue,
 * regenerate, Pin, next-steps), because a subagent is not that conversation.
 * The identity strip, task brief and the absent input area are unchanged.
 *
 * Auto-scrolls to the newest entry while the user is pinned to the bottom;
 * scrolling up releases the pin so long histories can be read in place.
 */

import { AgentRuntimeBadge } from '@wrongstack/project-surfaces/ui/AgentRuntimeBadge';
import { Bot, Maximize2, X } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { useAppTranslation } from '@/i18n';
import { TASK_PREVIEW_CHARS, taskBriefPreview } from '@/lib/task-brief-preview';
import { cn } from '@/lib/utils';
import { EMPTY_AGENT_TRANSCRIPT, useFleetStore, useUIStore } from '@/stores';
import { DEFAULT_LANE_ID } from '@/stores/chat-lanes';
import { useLocalPrefs } from '@/stores/local-prefs';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '../ui/dialog';
import { agentTranscriptToChatMessages } from './agentTranscriptMessages.js';
import { ChatRowView } from './ChatRowView.js';
import { buildChatRows } from './utils.js';

/** Status chip tone for the slim identity header — mirrors AgentRosterCard. */
const STATUS_CHIP: Record<string, string> = {
  running: 'bg-success/10 text-success',
  completed: 'bg-success/10 text-success',
  failed: 'bg-destructive/10 text-destructive',
  timeout: 'bg-warning/10 text-warning',
  stopped: 'bg-muted text-muted-foreground',
};

export function SubagentTranscriptView({ agentId }: { agentId: string }): React.ReactElement {
  const { t } = useAppTranslation();
  const agent = useFleetStore((s) => s.agents.get(agentId));
  const entries = useFleetStore((s) => s.agentTranscripts.get(agentId) ?? EMPTY_AGENT_TRANSCRIPT);
  const setSubagentChatFocus = useUIStore((s) => s.setSubagentChatFocus);
  const compactMode = useUIStore((s) => s.compactMode);
  // Same display prefs the leader honours, so the two screens never disagree
  // about whether reasoning shows or tool runs are collapsed.
  const groupToolCalls = useLocalPrefs((s) => s.groupToolCalls);
  const [taskOpen, setTaskOpen] = useState(false);

  // The agent's rows come from the leader's own row model. The agent status
  // stands in for the leader's `isLoading`: a running agent should auto-open
  // its last tool group exactly as a running leader turn does.
  const messages = useMemo(() => agentTranscriptToChatMessages(entries), [entries]);
  const rows = useMemo(() => buildChatRows(messages), [messages]);
  const isRunning = agent?.status === 'running';

  const scrollRef = useRef<HTMLDivElement>(null);
  const pinnedRef = useRef(true);
  const last = entries[entries.length - 1];
  const lastContentLen = last?.content.length ?? 0;

  useEffect(() => {
    pinnedRef.current = true;
  }, [agentId]);

  // Stick to the newest entry while pinned. Streaming merges keep
  // `entries.length` stable, so follow last-entry identity + content length.
  useEffect(() => {
    const el = scrollRef.current;
    if (el && pinnedRef.current) el.scrollTop = el.scrollHeight;
  }, [entries.length, lastContentLen, last?.id, agentId]);

  const handleScroll = (e: React.UIEvent<HTMLDivElement>) => {
    const el = e.currentTarget;
    pinnedRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
  };

  return (
    <div className="flex h-full min-h-0 flex-col" data-testid="subagent-transcript-view">
      {/* Single chrome row: identity + clipped task preview + return.
          Chimera briefs are multi-KB; only a one-line preview lives here. */}
      <div
        data-testid="subagent-task-strip"
        className="flex h-8 max-h-8 shrink-0 items-center gap-1.5 overflow-hidden border-b border-border/60 bg-muted/20 px-3 text-xs"
      >
        <Bot className="h-3.5 w-3.5 shrink-0 text-primary" />
        <span className="max-w-[9rem] shrink-0 truncate font-semibold text-foreground">
          {agent?.name ?? agentId}
        </span>
        <AgentRuntimeBadge provider={agent?.provider} model={agent?.model} />
        {(agent?.provider || agent?.model) && agent?.provider !== 'acp' && (
          <span
            className="max-w-[16rem] shrink-0 truncate font-mono text-[10px] text-muted-foreground"
            title={`${agent.provider ?? '?'}/${agent.model ?? '?'}`}
            data-testid="subagent-provider-model"
          >
            {agent.provider ?? '?'}/{agent.model ?? '?'}
          </span>
        )}
        {agent && (
          <span
            className={cn(
              'shrink-0 rounded px-1.5 py-0.5 text-[9px] font-medium uppercase tracking-wider',
              STATUS_CHIP[agent.status] ?? STATUS_CHIP.stopped,
            )}
          >
            {agent.status}
          </span>
        )}
        <span className="shrink-0 text-[9px] font-medium uppercase tracking-wider text-muted-foreground/80">
          {t('activity:transcript.readOnly')}
        </span>
        {agent?.description ? (
          <>
            <span className="shrink-0 text-border" aria-hidden="true">
              ·
            </span>
            <span className="shrink-0 font-semibold uppercase tracking-wide text-foreground/70">
              {t('activity:transcript.taskLabel')}
            </span>
            <button
              type="button"
              data-testid="subagent-task-preview"
              onClick={() => setTaskOpen(true)}
              title={t('activity:transcript.taskExpandTitle')}
              className="min-w-0 flex-1 truncate text-left text-muted-foreground hover:text-foreground"
            >
              {taskBriefPreview(agent.description)}
            </button>
            {agent.description.length > TASK_PREVIEW_CHARS && (
              <span className="shrink-0 tabular-nums text-[10px] text-muted-foreground/70">
                {t('activity:transcript.taskChars', { count: agent.description.length })}
              </span>
            )}
            <button
              type="button"
              onClick={() => setTaskOpen(true)}
              title={t('activity:transcript.taskExpandTitle')}
              aria-label={t('activity:transcript.taskExpandTitle')}
              aria-expanded={taskOpen}
              className="flex shrink-0 items-center gap-1 rounded border border-border/60 bg-background/70 px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground transition-colors hover:border-primary/40 hover:text-foreground"
            >
              <Maximize2 className="h-3 w-3" />
              {t('activity:transcript.taskExpand')}
            </button>
          </>
        ) : (
          <span className="flex-1" />
        )}
        {agent != null && (
          <span className="shrink-0 tabular-nums text-[10px] text-muted-foreground">
            iter {agent.iteration} · {agent.toolCalls} {t('activity:agents.tcSuffix')} · $
            {agent.costUsd.toFixed(4)}
          </span>
        )}
        <button
          type="button"
          onClick={() => setSubagentChatFocus(null, agent?.sessionId)}
          aria-label={t('activity:transcript.returnToLeader')}
          className="ml-0.5 inline-flex shrink-0 items-center gap-0.5 rounded bg-primary/15 px-1.5 py-0.5 text-[10px] font-medium text-foreground transition-colors hover:bg-primary/25"
        >
          <X className="h-3 w-3" />
          {t('activity:transcript.returnToLeader')}
        </button>
      </div>

      {/* Transcript body */}
      <div
        ref={scrollRef}
        onScroll={handleScroll}
        role="log"
        aria-label={t('activity:chatView.chatTranscript')}
        aria-live="polite"
        className="min-h-0 flex-1 overflow-y-auto overscroll-contain"
      >
        {rows.length === 0 ? (
          <div className="mx-auto max-w-6xl px-3 pt-6 sm:px-5 lg:px-6">
            <div className="rounded-lg border border-dashed border-border p-6 text-center text-xs text-muted-foreground">
              {t('activity:transcript.empty')}
            </div>
          </div>
        ) : (
          // The leader's own row renderer, with each row wrapped in the same
          // max-width column the leader's virtualized list uses. `readOnly`
          // keeps the leader-lane actions off a transcript the user cannot
          // act on.
          rows.map((row, i) => (
            <ChatRowView
              key={row.key}
              row={row}
              isLoading={isRunning}
              compactMode={compactMode}
              isFirstRow={i === 0}
              groupToolCalls={groupToolCalls}
              sessionId={DEFAULT_LANE_ID}
              readOnly
            />
          ))
        )}
      </div>

      {/* Full task brief — on-demand modal (opened from the strip above) */}
      {agent?.description && (
        <Dialog open={taskOpen} onOpenChange={setTaskOpen}>
          <DialogContent className="flex max-h-[85dvh] max-w-3xl flex-col gap-3 overflow-hidden">
            <DialogHeader>
              <DialogTitle className="flex items-center gap-2 pr-6 text-base">
                <Bot className="h-4 w-4 shrink-0 text-primary" />
                <span className="truncate">
                  {agent.name ?? agentId} · {t('activity:transcript.taskModalTitle')}
                </span>
              </DialogTitle>
              <DialogDescription className="sr-only">
                {t('activity:transcript.taskModalDescription')}
              </DialogDescription>
            </DialogHeader>
            <pre
              data-testid="subagent-task-full"
              className="min-h-0 flex-1 overflow-y-auto whitespace-pre-wrap break-words rounded-md border border-border/60 bg-muted/30 px-3 py-2.5 font-mono text-xs leading-relaxed text-foreground/85"
            >
              {agent.description}
            </pre>
          </DialogContent>
        </Dialog>
      )}
    </div>
  );
}
