/**
 * SubagentTranscriptView — full-pane chat-style history of one subagent.
 *
 * Shown in place of the leader transcript while an agent tab is selected
 * (see AgentTabs). Renders the agent's complete fleet-store transcript —
 * markdown assistant bubbles, collapsible thinking, tool call/result cards,
 * status lines — mirroring the leader chat's visual language, but WITHOUT
 * any input area: subagents are read-only observers here.
 *
 * Auto-scrolls to the newest entry while the user is pinned to the bottom;
 * scrolling up releases the pin so long histories can be read in place.
 */

import {
  AlertCircle,
  Bot,
  Brain,
  Check,
  CircleDot,
  Info,
  Maximize2,
  Wrench,
  X,
} from 'lucide-react';
import { memo, useEffect, useRef, useState } from 'react';
import { useAppTranslation } from '@/i18n';
import { TASK_PREVIEW_CHARS, taskBriefPreview } from '@/lib/task-brief-preview';
import { cn } from '@/lib/utils';
import type { AgentTranscriptEntry } from '@/stores';
import { EMPTY_AGENT_TRANSCRIPT, useFleetStore, useUIStore } from '@/stores';
import { LazyMarkdown as ReactMarkdown } from '../MessageBubble/LazyMarkdown.js';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '../ui/dialog';

/** Status chip tone for the slim identity header — mirrors AgentRosterCard. */
const STATUS_CHIP: Record<string, string> = {
  running: 'bg-success/10 text-success',
  completed: 'bg-success/10 text-success',
  failed: 'bg-destructive/10 text-destructive',
  timeout: 'bg-warning/10 text-warning',
  stopped: 'bg-muted text-muted-foreground',
};

function formatTime(ts: string): string {
  const time = Date.parse(ts);
  if (!Number.isFinite(time)) return '';
  return new Date(time).toLocaleTimeString([], {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
}

const TranscriptRow = memo(function TranscriptRow({ entry }: { entry: AgentTranscriptEntry }) {
  const { t } = useAppTranslation();
  const time = formatTime(entry.ts);

  // Assistant output — rendered like a leader-chat assistant bubble.
  if (entry.kind === 'text') {
    return (
      <div className="flex gap-3">
        <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-accent text-accent-foreground ring-accent/20 ring-offset-background ring-2 ring-offset-2">
          <Bot className="h-4 w-4" />
        </div>
        <div className="min-w-0 flex-1 space-y-1 rounded-lg border border-border/70 bg-card px-4 py-3 shadow-sm">
          <ReactMarkdown>{entry.content}</ReactMarkdown>
          <div className="flex items-center gap-2 text-[9px] tabular-nums text-muted-foreground/60">
            {entry.iteration > 0 && <span>iter {entry.iteration}</span>}
            {time && <span className="ml-auto font-mono">{time}</span>}
          </div>
        </div>
      </div>
    );
  }

  // Extended thinking — collapsed by default, expandable like the leader
  // chat's archived thinking logs.
  if (entry.kind === 'thinking') {
    return (
      <details className="group rounded-lg border border-primary/20 bg-primary/5 px-3 py-2">
        <summary className="flex cursor-pointer select-none items-center gap-2 text-[10px] font-medium uppercase tracking-wider text-primary/80 marker:hidden [&::-webkit-details-marker]:hidden">
          <Brain className="h-3.5 w-3.5 shrink-0" />
          {t('activity:transcript.kindThinking')}
          {entry.iteration > 0 && (
            <span className="rounded bg-primary/10 px-1 py-0.5 text-[9px] normal-case tabular-nums">
              iter {entry.iteration}
            </span>
          )}
          {time && (
            <span className="ml-auto font-mono text-[9px] normal-case text-muted-foreground">
              {time}
            </span>
          )}
        </summary>
        <pre className="mt-2 whitespace-pre-wrap break-words font-mono text-[11px] leading-relaxed text-foreground/75">
          {entry.content}
        </pre>
      </details>
    );
  }

  // Tool lifecycle — call and result get distinct tones like the tool ledger.
  if (entry.kind === 'tool_use' || entry.kind === 'tool_result') {
    const isUse = entry.kind === 'tool_use';
    const ok = entry.toolOk !== false;
    const Icon = isUse ? Wrench : ok ? Check : X;
    return (
      <div
        className={cn(
          'rounded-lg border px-3 py-2',
          isUse
            ? 'border-warning/20 bg-warning/5'
            : ok
              ? 'border-success/20 bg-success/5'
              : 'border-destructive/25 bg-destructive/5',
        )}
      >
        <div className="flex min-w-0 items-center gap-2">
          <Icon
            className={cn(
              'h-3.5 w-3.5 shrink-0',
              isUse ? 'text-warning' : ok ? 'text-success' : 'text-destructive',
            )}
          />
          <span className="shrink-0 text-[10px] font-medium uppercase tracking-wider text-muted-foreground">
            {t(isUse ? 'activity:transcript.kindToolCall' : 'activity:transcript.kindToolResult')}
          </span>
          {entry.toolName && (
            <span className="min-w-0 truncate rounded bg-background/70 px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground">
              {entry.toolName}
            </span>
          )}
          {time && (
            <span className="ml-auto shrink-0 font-mono text-[9px] tabular-nums text-muted-foreground">
              {time}
            </span>
          )}
        </div>
        {entry.content && (
          <pre className="mt-1.5 max-h-64 overflow-y-auto whitespace-pre-wrap break-words font-mono text-[11px] leading-relaxed text-foreground/80">
            {entry.content}
          </pre>
        )}
      </div>
    );
  }

  // Errors — full-width destructive card.
  if (entry.kind === 'error') {
    return (
      <div className="rounded-lg border border-destructive/25 bg-destructive/5 px-3 py-2">
        <div className="flex min-w-0 items-center gap-2">
          <AlertCircle className="h-3.5 w-3.5 shrink-0 text-destructive" />
          <span className="shrink-0 text-[10px] font-medium uppercase tracking-wider text-destructive">
            {t('activity:transcript.kindError')}
          </span>
          {time && (
            <span className="ml-auto shrink-0 font-mono text-[9px] tabular-nums text-muted-foreground">
              {time}
            </span>
          )}
        </div>
        <pre className="mt-1.5 whitespace-pre-wrap break-words font-mono text-[11px] leading-relaxed text-destructive/90">
          {entry.content}
        </pre>
      </div>
    );
  }

  // Status / system events — quiet centered lines, like system rows in chat.
  const Icon = entry.kind === 'status' ? Info : CircleDot;
  return (
    <div className="flex justify-center">
      <div className="flex max-w-full items-center gap-1.5 rounded-full border border-border/50 bg-muted/25 px-3 py-1 text-[10px] text-muted-foreground">
        <Icon className="h-3 w-3 shrink-0" />
        <span className="truncate">{entry.content}</span>
        {time && (
          <span className="shrink-0 font-mono text-[9px] tabular-nums opacity-70">{time}</span>
        )}
      </div>
    </div>
  );
});

export function SubagentTranscriptView({ agentId }: { agentId: string }): React.ReactElement {
  const { t } = useAppTranslation();
  const agent = useFleetStore((s) => s.agents.get(agentId));
  const entries = useFleetStore((s) => s.agentTranscripts.get(agentId) ?? EMPTY_AGENT_TRANSCRIPT);
  const setSubagentChatFocus = useUIStore((s) => s.setSubagentChatFocus);
  const [taskOpen, setTaskOpen] = useState(false);

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
          className="ml-0.5 inline-flex shrink-0 items-center gap-0.5 rounded bg-primary/15 px-1.5 py-0.5 text-[10px] font-medium text-primary transition-colors hover:bg-primary/25"
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
        {entries.length === 0 ? (
          <div className="mx-auto max-w-6xl px-3 pt-6 sm:px-5 lg:px-6">
            <div className="rounded-lg border border-dashed border-border p-6 text-center text-xs text-muted-foreground">
              {t('activity:transcript.empty')}
            </div>
          </div>
        ) : (
          <div className="mx-auto max-w-6xl space-y-2.5 px-3 pb-8 pt-3 sm:px-5 lg:px-6">
            {entries.map((entry) => (
              <TranscriptRow key={entry.id} entry={entry} />
            ))}
          </div>
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
