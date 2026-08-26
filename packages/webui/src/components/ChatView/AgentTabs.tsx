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

import { Bot, CheckCircle2, Crown, Loader2 } from 'lucide-react';
import { useShallow } from 'zustand/react/shallow';
import { useAppTranslation } from '@/i18n';
import { agentBelongsToSession } from '@/lib/agent-session';
import { cn } from '@/lib/utils';
import type { SubagentView } from '@/stores';
import {
  selectSortedAgentList,
  useChatStore,
  useFleetStore,
  useSessionLeaderId,
  useSessionStore,
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

export function AgentTabs() {
  const { t } = useAppTranslation();
  const currentSessionId = useSessionStore((s) => s.session?.id);
  const isLoading = useChatStore((s) => s.isLoading);
  const allAgents = useFleetStore(useShallow(selectSortedAgentList));
  // This tab's leader, not the process-wide one — otherwise a second tab
  // promoting its leader made this tab list its own leader as a subagent.
  const leaderId = useSessionLeaderId(currentSessionId);
  // Named from THIS tab's leader — `selectLeaderName` resolves the
  // process-wide pointer, which names another tab's leader as often as not.
  const leaderName = useFleetStore((s) => (leaderId ? s.agents.get(leaderId)?.name : undefined));
  const focusId = useUIStore((s) => s.subagentChatFocusId);
  const setFocus = useUIStore((s) => s.setSubagentChatFocus);

  // The leader already owns the dedicated first tab — never list it twice.
  //
  // Agents are listed fail-CLOSED: an agent must name this session to appear.
  // The old `!a.sessionId ||` allowance meant one untagged agent showed up in
  // all four tabs at once, which is the roster half of the cross-tab bleed.
  const agents = allAgents.filter((a) => agentBelongsToSession(a.sessionId, currentSessionId));
  const subagents = agents.filter((a) => a.id !== leaderId);
  if (subagents.length === 0 && focusId == null && !isLoading) return null;

  const runningSubs = subagents.filter((a) => a.status === 'running').length;
  const finishedSubs = subagents.length - runningSubs;

  return (
    <div
      role="tablist"
      aria-label={t('activity:agents.tabsLabel')}
      className="flex shrink-0 items-center justify-between gap-2 overflow-x-auto overscroll-x-contain px-3 py-1 border-b border-border/40 bg-muted/20 text-xs no-scrollbar"
    >
      <div className="flex items-center gap-1.5 min-w-0">
        <span className="text-[10px] font-semibold text-muted-foreground uppercase tracking-wider flex items-center gap-1 shrink-0">
          <Bot className="h-3 w-3 text-primary" /> Agents:
        </span>
        <button
          type="button"
          role="tab"
          aria-selected={focusId == null}
          onClick={() => {
            setFocus(null);
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
        {subagents.map((a) => {
          const meta = TAB_LED[a.status] ?? TAB_LED.stopped;
          const active = focusId === a.id;
          return (
            <button
              key={a.id}
              type="button"
              role="tab"
              aria-selected={active}
              title={a.description ?? a.name}
              onClick={() => setFocus(a.id)}
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
              <span className="max-w-[10rem] truncate">{a.name}</span>
            </button>
          );
        })}
      </div>

      {/* Session & Fleet Summary Pill */}
      <div className="flex shrink-0 items-center gap-2 pl-2 border-l border-border/30">
        {isLoading ? (
          <span className="inline-flex items-center gap-1 text-[10px] font-medium text-primary bg-primary/10 px-1.5 py-0.5 rounded border border-primary/20">
            <Loader2 className="h-2.5 w-2.5 animate-spin" />
            <span>Processing...</span>
          </span>
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
