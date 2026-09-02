/**
 * AgentTabs — leader/subagent switcher above the chat transcript.
 *
 * Renders only when the fleet roster is non-empty (the leader is part of
 * it). The Leader tab restores the normal chat; each subagent tab swaps
 * the transcript pane for that agent's full history rendered chat-style
 * (SubagentTranscriptView) and hides the input area. Selection lives in
 * ui-store (`subagentChatFocusId`) so any surface — roster cards, agent
 * detail sections — can jump straight into an agent's chat view.
 */

import { Bot, Check, CheckCircle2, ChevronDown, Crown, Loader2, Square, X } from 'lucide-react';
import { useShallow } from 'zustand/react/shallow';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { useAppTranslation } from '@/i18n';
import { agentBelongsToSession } from '@/lib/agent-session';
import { taskBriefPreview } from '@/lib/task-brief-preview';
import { cn } from '@/lib/utils';
import { getWSClient } from '@/lib/ws-client';
import type { SubagentView } from '@/stores';
import {
  selectSortedAgentList,
  useActiveSessionId,
  useChatStore,
  useFleetStore,
  useSessionLeaderId,
  useUIStore,
} from '@/stores';

/** Status LED colors for tab dots — mirrors AgentRosterCard's STATUS_LED. */
const TAB_LED: Record<SubagentView['status'], { led: string; pulse: boolean }> = {
  running: { led: 'bg-success', pulse: true },
  completed: { led: 'bg-success', pulse: false },
  failed: { led: 'bg-destructive', pulse: false },
  timeout: { led: 'bg-warning', pulse: false },
  stopped: { led: 'bg-muted-foreground', pulse: false },
};

/**
 * Inline tab budget before the rest of the roster collapses into the
 * overflow dropdown. Three subagent tabs + the leader tab + the AGENTS
 * label leave the session summary pill (Stop/Waiting) room even with
 * worst-case 10rem-wide names, so the bar never overflows.
 */
const MAX_INLINE_SUBAGENTS = 3;

function SubagentTabButton({
  agent,
  active,
  onOpen,
  onRemove,
  removeLabel,
}: {
  agent: SubagentView;
  active: boolean;
  onOpen: () => void;
  /** Present only on finished agents — removes the agent from the roster. */
  onRemove?: (() => void) | undefined;
  removeLabel?: string | undefined;
}) {
  const meta = TAB_LED[agent.status] ?? TAB_LED.stopped;
  return (
    <button
      type="button"
      role="tab"
      aria-selected={active}
      title={agent.description ? taskBriefPreview(agent.description, 180) : agent.name}
      onClick={onOpen}
      className={cn(
        'flex shrink-0 items-center gap-1.5 rounded-md px-2 py-0.5 text-[11px] font-medium transition-colors border',
        active
          ? 'bg-primary/15 text-primary border-primary/30 shadow-xs'
          : 'text-muted-foreground border-transparent hover:bg-muted/50 hover:text-foreground',
      )}
    >
      <span
        className={cn('led shrink-0', meta.led, meta.pulse && 'led-pulse')}
        aria-hidden="true"
      />
      <span className="max-w-[10rem] truncate">{agent.name}</span>
      {onRemove && (
        <span
          role="button"
          tabIndex={-1}
          data-testid="agent-tab-close"
          aria-label={removeLabel}
          title={removeLabel}
          onClick={(e) => {
            e.stopPropagation();
            onRemove();
          }}
          className="-mr-0.5 flex shrink-0 items-center rounded-sm p-0.5 text-muted-foreground/60 transition-colors hover:bg-destructive/15 hover:text-destructive"
        >
          <X className="h-2.5 w-2.5" aria-hidden="true" />
        </span>
      )}
    </button>
  );
}

export function AgentTabs() {
  const { t } = useAppTranslation();
  const currentSessionId = useActiveSessionId();
  const isLoading = useChatStore((s) => s.isLoading);
  const allAgents = useFleetStore(useShallow(selectSortedAgentList));
  // This tab's leader, not the process-wide one — otherwise a second tab
  // promoting its leader made this tab list its own leader as a subagent.
  const leaderId = useSessionLeaderId(currentSessionId ?? undefined);
  // Named from THIS tab's leader — `selectLeaderName` resolves the
  // process-wide pointer, which names another tab's leader as often as not.
  const leaderName = useFleetStore((s) => (leaderId ? s.agents.get(leaderId)?.name : undefined));
  const focusId = useUIStore((s) => s.subagentChatFocusId);
  const setFocus = useUIStore((s) => s.setSubagentChatFocus);
  const removeAgent = useFleetStore((s) => s.removeAgent);

  // The leader already owns the dedicated first tab — never list it twice.
  //
  // Agents are listed fail-CLOSED: an agent must name this session to appear.
  // The old `!a.sessionId ||` allowance meant one untagged agent showed up in
  // all four tabs at once, which is the roster half of the cross-tab bleed.
  const agents = allAgents.filter((a) => agentBelongsToSession(a.sessionId, currentSessionId));
  const subagents = agents.filter((a) => a.id !== leaderId);

  const runningSubs = subagents.filter((a) => a.status === 'running').length;
  const finishedSubs = subagents.length - runningSubs;

  // Collapsed roster: first MAX_INLINE_SUBAGENTS stay as tabs, the rest live
  // behind the "+N" overflow dropdown so the bar never pushes the Stop /
  // summary pill out of view.
  const inlineSubs = subagents.slice(0, MAX_INLINE_SUBAGENTS);
  const overflowSubs = subagents.slice(MAX_INLINE_SUBAGENTS);
  const overflowFocusActive = overflowSubs.some((a) => a.id === focusId);
  const anyOverflowRunning = overflowSubs.some((a) => a.status === 'running');
  const openAgent = (id: string) => {
    setFocus(id, currentSessionId);
    useUIStore.getState().setCurrentView('chat');
  };
  const closeLabel = (name: string) => t('activity:agents.closeTab', { name });

  return (
    <div
      role="tablist"
      aria-label={t('activity:agents.tabsLabel')}
      data-testid="agent-tabs"
      className="flex shrink-0 items-center justify-between gap-2 overflow-x-auto overscroll-x-contain px-3 py-1 border-b border-border/40 bg-muted/20 text-xs no-scrollbar"
    >
      <div className="flex items-center gap-1.5 min-w-0">
        <span className="text-[10px] font-semibold text-muted-foreground uppercase tracking-wider flex items-center gap-1 shrink-0">
          <Bot className="h-3 w-3 text-primary" /> AGENTS
          <span className="rounded bg-muted/60 px-1 font-mono text-[9px] text-muted-foreground">
            {agents.length}
          </span>
        </span>
        <button
          type="button"
          role="tab"
          aria-selected={focusId == null}
          onClick={() => {
            setFocus(null, currentSessionId);
            useUIStore.getState().setCurrentView('chat');
          }}
          className={cn(
            'flex shrink-0 items-center gap-1 rounded-md px-2 py-0.5 text-[11px] font-medium transition-colors border',
            focusId == null
              ? 'bg-primary/15 text-primary border-primary/30 shadow-xs'
              : 'text-muted-foreground border-transparent hover:bg-muted/50 hover:text-foreground',
          )}
        >
          <Crown className="h-3 w-3 shrink-0 text-warning" />
          <span className="max-w-[10rem] truncate">
            {leaderName ?? t('activity:agents.leaderTab')}
          </span>
        </button>
        {inlineSubs.map((a) => (
          <SubagentTabButton
            key={a.id}
            agent={a}
            active={focusId === a.id}
            onOpen={() => openAgent(a.id)}
            onRemove={a.status !== 'running' ? () => removeAgent(a.id) : undefined}
            removeLabel={closeLabel(a.name)}
          />
        ))}
        {overflowSubs.length > 0 && (
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <button
                type="button"
                data-testid="agent-tabs-overflow"
                title={t('activity:agents.moreTabsTitle', { n: overflowSubs.length })}
                aria-label={t('activity:agents.moreTabsTitle', { n: overflowSubs.length })}
                className={cn(
                  'flex shrink-0 items-center gap-1 rounded-md px-2 py-0.5 text-[11px] font-medium transition-colors border',
                  overflowFocusActive
                    ? 'bg-primary/15 text-primary border-primary/30 shadow-xs'
                    : 'text-muted-foreground border-transparent hover:bg-muted/50 hover:text-foreground',
                )}
              >
                <span
                  className={cn(
                    'led shrink-0',
                    anyOverflowRunning ? 'bg-success led-pulse' : 'bg-muted-foreground',
                  )}
                  aria-hidden="true"
                />
                <span className="font-mono">+{overflowSubs.length}</span>
                <ChevronDown className="h-3 w-3 shrink-0 opacity-60" />
              </button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start" className="max-h-72 w-60 overflow-y-auto">
              {overflowSubs.map((a) => {
                const meta = TAB_LED[a.status] ?? TAB_LED.stopped;
                const active = focusId === a.id;
                return (
                  <DropdownMenuItem
                    key={a.id}
                    data-testid="agent-tabs-overflow-item"
                    title={a.description ? taskBriefPreview(a.description, 180) : a.name}
                    onSelect={() => openAgent(a.id)}
                  >
                    <span
                      className={cn('led shrink-0', meta.led, meta.pulse && 'led-pulse')}
                      aria-hidden="true"
                    />
                    <span className="max-w-[12rem] flex-1 truncate">{a.name}</span>
                    {active && (
                      <Check className="h-3 w-3 shrink-0 text-primary" aria-hidden="true" />
                    )}
                    {a.status !== 'running' && (
                      <span
                        role="button"
                        tabIndex={-1}
                        data-testid="agent-tab-close"
                        aria-label={closeLabel(a.name)}
                        title={closeLabel(a.name)}
                        onClick={(e) => {
                          // Keep the menu open so several finished agents can
                          // be dismissed in one pass; stopPropagation also
                          // keeps the click from selecting the item.
                          e.stopPropagation();
                          removeAgent(a.id);
                        }}
                        className="flex shrink-0 items-center rounded-sm p-1 text-muted-foreground/60 transition-colors hover:bg-destructive/15 hover:text-destructive"
                      >
                        <X className="h-3 w-3" aria-hidden="true" />
                      </span>
                    )}
                  </DropdownMenuItem>
                );
              })}
            </DropdownMenuContent>
          </DropdownMenu>
        )}
      </div>

      {/* Session & Fleet Summary Pill */}
      <div className="flex shrink-0 items-center gap-2 pl-2 border-l border-border/30">
        {isLoading ? (
          <div className="inline-flex items-center gap-1">
            <span className="inline-flex items-center gap-1 text-[10px] font-medium text-primary bg-primary/10 px-1.5 py-0.5 rounded border border-primary/20">
              <Loader2 className="h-2.5 w-2.5 animate-spin" />
              <span>Processing...</span>
            </span>
            <button
              type="button"
              onClick={() => {
                getWSClient().sendAbort(currentSessionId ?? undefined);
                useChatStore.getState().setLoading(false);
              }}
              title={t('chat:input.abortTitle', 'Stop/Abort')}
              aria-label={t('chat:input.abortTitle', 'Stop/Abort')}
              className="inline-flex items-center gap-1 text-[10px] font-medium text-destructive bg-destructive/10 hover:bg-destructive/20 px-1.5 py-0.5 rounded border border-destructive/20 transition-colors"
            >
              <Square className="h-2 w-2 fill-current" />
              <span>Stop</span>
            </button>
          </div>
        ) : (
          <span className="inline-flex items-center gap-1 text-[10px] font-medium text-muted-foreground bg-muted/40 px-1.5 py-0.5 rounded border border-border/40">
            <CheckCircle2 className="h-2.5 w-2.5 text-success" />
            <span>Waiting for next prompt</span>
          </span>
        )}
        {subagents.length > 0 && (
          <span className="text-[10px] font-mono text-muted-foreground hidden md:inline">
            {runningSubs > 0 ? (
              <span className="text-success font-semibold">{runningSubs} active</span>
            ) : null}
            {runningSubs > 0 && finishedSubs > 0 ? ' · ' : null}
            {finishedSubs > 0 ? <span>{finishedSubs} finished</span> : null}
          </span>
        )}
      </div>
    </div>
  );
}

/** Pure focus-retention rule: a focused subagent id only survives while the
 *  agent still exists in the fleet roster. Null focus never clears. Exported
 *  for direct unit testing (consumed by ChatView's stale-focus effect). */
export function shouldAutoClearSubagentFocus(
  focusId: string | null,
  agentExists: boolean,
): boolean {
  return focusId != null && !agentExists;
}
