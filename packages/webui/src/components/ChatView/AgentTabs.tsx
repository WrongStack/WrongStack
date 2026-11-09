/**
 * AgentTabs — vertical leader/subagent switcher for the narrow session sidebar.
 *
 * The Leader row restores the normal chat; each subagent row swaps the
 * transcript pane for that agent's full history rendered chat-style
 * (SubagentTranscriptView) and hides the input area. Selection lives in
 * ui-store (`subagentChatFocusId`) so any surface — roster cards, agent
 * detail sections — can jump straight into an agent's chat view.
 */

import { AgentRuntimeBadge } from '@wrongstack/project-surfaces/ui/AgentRuntimeBadge';
import { Bot, CheckCircle2, Crown, Loader2, Square, X } from 'lucide-react';
import { useShallow } from 'zustand/react/shallow';
import { HueChip } from '@/components/ui/hue-chip';
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
    // A `div` + `role="tab"` (not a `<button>`) so the close affordance below can
    // be a REAL focusable button: nesting a button inside a button is invalid
    // HTML, which is why this used to be a `span role="button" tabIndex={-1}` —
    // unreachable by Tab. Mirrors the pattern SessionTabBar already uses.
    <div
      role="tab"
      tabIndex={0}
      aria-selected={active}
      title={agent.description ? taskBriefPreview(agent.description, 180) : agent.name}
      onClick={onOpen}
      onKeyDown={(e) => {
        // The nested close button handles its own Enter/Space; without this
        // guard its keydown bubbles here and opens the tab while closing.
        if (e.target !== e.currentTarget) return;
        if (e.key !== 'Enter' && e.key !== ' ') return;
        e.preventDefault();
        onOpen();
      }}
      className={cn(
        'flex min-h-8 w-full min-w-0 items-center gap-2 border px-2 py-1.5 text-left text-[11px] font-medium transition-colors',
        active
          ? 'border-primary/40 bg-primary/15 text-foreground shadow-xs'
          : 'border-border/60 bg-card/60 text-muted-foreground hover:bg-muted/50 hover:text-foreground',
      )}
    >
      <span
        className={cn('led shrink-0', meta.led, meta.pulse && 'led-pulse')}
        aria-hidden="true"
      />
      <span className="min-w-0 flex-1 break-words [overflow-wrap:anywhere]">{agent.name}</span>
      <AgentRuntimeBadge
        provider={agent.provider}
        model={agent.model}
        showName={false}
        className="shrink-0"
      />
      {onRemove && (
        <button
          type="button"
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
        </button>
      )}
    </div>
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
  const openAgent = (id: string) => {
    setFocus(id, currentSessionId);
    useUIStore.getState().setCurrentView('chat');
  };
  const closeLabel = (name: string) => t('activity:agents.closeTab', { name });

  return (
    <div
      data-testid="agent-tabs"
      className="flex min-w-0 shrink-0 flex-col gap-2 border-b border-border/40 bg-muted/20 p-2 text-xs"
    >
      <div className="flex min-w-0 items-center gap-1.5">
        <span className="flex min-w-0 items-center gap-1 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
          <Bot className="h-3 w-3 shrink-0 text-primary" aria-hidden="true" />
          <span>AGENTS</span>
        </span>
        <span className="bg-muted/60 px-1 font-mono text-[9px] text-muted-foreground">
          {agents.length}
        </span>
      </div>

      <div
        role="tablist"
        aria-label={t('activity:agents.tabsLabel')}
        aria-orientation="vertical"
        className="flex min-w-0 flex-col gap-1"
      >
        <button
          type="button"
          role="tab"
          aria-selected={focusId == null}
          onClick={() => {
            setFocus(null, currentSessionId);
            useUIStore.getState().setCurrentView('chat');
          }}
          className={cn(
            'flex min-h-8 w-full min-w-0 items-center gap-2 border px-2 py-1.5 text-left text-[11px] font-medium transition-colors',
            focusId == null
              ? 'border-primary/40 bg-primary/15 text-foreground shadow-xs'
              : 'border-border/60 bg-card/60 text-muted-foreground hover:bg-muted/50 hover:text-foreground',
          )}
        >
          <Crown className="h-3 w-3 shrink-0 text-warning" aria-hidden="true" />
          <span className="min-w-0 flex-1 break-words [overflow-wrap:anywhere]">
            {leaderName ?? t('activity:agents.leaderTab')}
          </span>
        </button>

        {subagents.map((agent) => (
          <SubagentTabButton
            key={agent.id}
            agent={agent}
            active={focusId === agent.id}
            onOpen={() => openAgent(agent.id)}
            onRemove={agent.status !== 'running' ? () => removeAgent(agent.id) : undefined}
            removeLabel={closeLabel(agent.name)}
          />
        ))}
      </div>

      <div className="flex min-w-0 flex-col gap-1.5 border border-border/50 bg-card/40 p-2">
        {isLoading ? (
          <>
            <HueChip
              tone="primary"
              icon={<Loader2 className="h-2.5 w-2.5 animate-spin" />}
              className="w-full justify-center border border-primary/20 text-[10px] font-medium"
            >
              <span>Processing...</span>
            </HueChip>
            <button
              type="button"
              onClick={() => {
                getWSClient().sendAbort(currentSessionId ?? undefined);
                useChatStore.getState().setLoading(false);
              }}
              title={t('chat:input.abortTitle', 'Stop/Abort')}
              aria-label={t('chat:input.abortTitle', 'Stop/Abort')}
              className="inline-flex min-h-7 w-full items-center justify-center gap-1 border border-destructive/20 bg-destructive/10 px-2 py-1 text-[10px] font-medium text-destructive transition-colors hover:bg-destructive/20"
            >
              <Square className="h-2 w-2 fill-current" aria-hidden="true" />
              <span>Stop</span>
            </button>
          </>
        ) : (
          <span className="inline-flex min-h-7 w-full items-center justify-center gap-1 border border-border/40 bg-muted/40 px-2 py-1 text-center text-[10px] font-medium text-muted-foreground">
            <CheckCircle2 className="h-2.5 w-2.5 shrink-0 text-success" aria-hidden="true" />
            <span>{t('activity:agents.waitingNextPrompt')}</span>
          </span>
        )}

        {subagents.length > 0 ? (
          <span className="block w-full text-center font-mono text-[10px] text-muted-foreground">
            {runningSubs > 0 ? (
              <span className="font-semibold text-success">{runningSubs} active</span>
            ) : null}
            {runningSubs > 0 && finishedSubs > 0 ? ' · ' : null}
            {finishedSubs > 0 ? <span>{finishedSubs} finished</span> : null}
          </span>
        ) : null}
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
