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

import { Crown } from 'lucide-react';
import { useShallow } from 'zustand/react/shallow';
import { cn } from '@/lib/utils';
import { useAppTranslation } from '@/i18n';
import type { SubagentView } from '@/stores';
import { selectLeaderName, selectSortedAgentList, useFleetStore, useUIStore } from '@/stores';

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
  const agents = useFleetStore(useShallow(selectSortedAgentList));
  const leaderId = useFleetStore((s) => s.leaderId);
  const leaderName = useFleetStore(selectLeaderName);
  const focusId = useUIStore((s) => s.subagentChatFocusId);
  const setFocus = useUIStore((s) => s.setSubagentChatFocus);

  // The leader already owns the dedicated first tab — never list it twice.
  const subagents = agents.filter((a) => a.id !== leaderId);
  if (subagents.length === 0 && focusId == null) return null;

  return (
    <div
      role="tablist"
      aria-label={t('activity:agents.tabsLabel')}
      className="flex shrink-0 items-center gap-1 overflow-x-auto overscroll-x-contain px-2 pb-1 pt-1 sm:px-3 lg:px-4"
    >
      <button
        type="button"
        role="tab"
        aria-selected={focusId == null}
        onClick={() => setFocus(null)}
        className={cn(
          'flex shrink-0 items-center gap-1 rounded-md px-2.5 py-1 text-[11px] font-medium transition-colors',
          focusId == null
            ? 'bg-primary/10 text-primary'
            : 'text-muted-foreground hover:bg-muted/50 hover:text-foreground',
        )}
      >
        <Crown className="h-3 w-3 shrink-0 text-warning" />
        <span className="max-w-[10rem] truncate">{leaderName ?? t('activity:agents.leaderTab')}</span>
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
              'flex shrink-0 items-center gap-1.5 rounded-md px-2.5 py-1 text-[11px] font-medium transition-colors',
              active
                ? 'bg-primary/10 text-primary'
                : 'text-muted-foreground hover:bg-muted/50 hover:text-foreground',
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
