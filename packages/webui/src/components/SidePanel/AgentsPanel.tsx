/**
 * AgentsPanel — live fleet roster for the side panel.
 *
 * Running agents sort first; clicking a row opens the full AgentDetail
 * overlay (the old FlowSidebar wired the overlay but never the click).
 */

import { Bot, CheckCircle2, LayoutGrid, ListFilter, Trash2 } from 'lucide-react';
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { useShallow } from 'zustand/react/shallow';
import { AgentRosterCard } from '@/components/agents/AgentRosterCard';
import { FleetSummaryBar } from '@/components/agents/FleetSummaryBar';
import { useAppTranslation } from '@/i18n';
import { agentBelongsToSession } from '@/lib/agent-session';
import { cn } from '@/lib/utils';
import { openMainView, showPanel } from '@/lib/view-navigation';
import {
  selectSortedAgentList,
  useActiveSessionId,
  useFleetStore,
  useSessionLeaderId,
  useUIStore,
} from '@/stores';
import { onLaneDisposed } from '@/stores/chat-lanes';

type AgentFilter = 'all' | 'running' | 'completed' | 'failed';
type AgentsPanelChrome = {
  filter: AgentFilter;
  expandedAgentId: string | null;
  focusedIndex: number;
  showHint: boolean;
};

const AGENTS_PANEL_NO_SESSION = '__no_session__';
const agentsPanelChromeBySession = new Map<string, AgentsPanelChrome>();
const disposedAgentPanelSessions = new Set<string>();

onLaneDisposed((sessionId) => {
  agentsPanelChromeBySession.delete(sessionId);
  disposedAgentPanelSessions.add(sessionId);
});

const FILTER_OPTIONS: Array<{
  value: AgentFilter;
  translationKey: `activity:agents.filter${string}`;
}> = [
  { value: 'all', translationKey: 'activity:agents.filterAll' },
  { value: 'running', translationKey: 'activity:agents.filterRunning' },
  { value: 'completed', translationKey: 'activity:agents.filterCompleted' },
  { value: 'failed', translationKey: 'activity:agents.filterFailed' },
];

export function AgentsPanel() {
  // This derived selector allocates on every invocation. Zustand 5 reads it
  // through useSyncExternalStore, so the selected snapshot must keep its
  // reference while the underlying values are unchanged.
  const fleetList = useFleetStore(useShallow(selectSortedAgentList));
  const clearFinishedAgents = useFleetStore((s) => s.clearFinishedAgents);
  const currentSessionId = useActiveSessionId();
  // Leader and its name come from THIS tab — the process-wide pointer and
  // `selectLeaderName` name whichever session promoted a leader last.
  const leaderId = useSessionLeaderId(currentSessionId ?? undefined);
  const leaderName = useFleetStore((s) => (leaderId ? s.agents.get(leaderId)?.name : undefined));
  const { t } = useAppTranslation();

  const [filter, setFilter] = useState<AgentFilter>('all');
  const [expandedAgentId, setExpandedAgentId] = useState<string | null>(null);
  const [focusedIndex, setFocusedIndex] = useState<number>(-1);
  const rosterRef = useRef<HTMLDivElement>(null);
  const [showHint, setShowHint] = useState(true);
  const chromeKey = currentSessionId ?? AGENTS_PANEL_NO_SESSION;
  const chromeKeyRef = useRef(chromeKey);

  useLayoutEffect(() => {
    if (chromeKeyRef.current === chromeKey) return;
    if (!disposedAgentPanelSessions.has(chromeKeyRef.current)) {
      agentsPanelChromeBySession.set(chromeKeyRef.current, {
        filter,
        expandedAgentId,
        focusedIndex,
        showHint,
      });
    }
    const next = agentsPanelChromeBySession.get(chromeKey) ?? {
      filter: 'all',
      expandedAgentId: null,
      focusedIndex: -1,
      showHint: true,
    };
    disposedAgentPanelSessions.delete(chromeKey);
    chromeKeyRef.current = chromeKey;
    setFilter(next.filter);
    setExpandedAgentId(next.expandedAgentId);
    setFocusedIndex(next.focusedIndex);
    setShowHint(next.showHint);
  }, [chromeKey, expandedAgentId, filter, focusedIndex, showHint]);

  const sessionFleetList = useMemo(
    () => fleetList.filter((a) => agentBelongsToSession(a.sessionId, currentSessionId)),
    [fleetList, currentSessionId],
  );

  const filteredList = useMemo(() => {
    if (filter === 'all') return sessionFleetList;
    return sessionFleetList.filter((a) => {
      if (filter === 'running') return a.status === 'running';
      if (filter === 'completed') return a.status === 'completed';
      if (filter === 'failed') return a.status === 'failed' || a.status === 'timeout';
      return true;
    });
  }, [sessionFleetList, filter]);

  // Agents are bounded (active fleet), show all without pagination.

  const hasFinished = sessionFleetList.some((a) => a.status !== 'running');

  const openFleetInspector = useCallback(
    (agentId?: string) => {
      if (agentId) {
        useUIStore.getState().setSubagentChatFocus(agentId, currentSessionId ?? undefined);
        showPanel('chat');
      } else {
        openMainView('roster');
      }
    },
    [currentSessionId],
  );

  const toggleAgent = useCallback((id: string) => {
    setExpandedAgentId((prev) => (prev === id ? null : id));
  }, []);

  // ── Keyboard navigation ─────────────────────────────────────────
  const handleRosterKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      const page = filteredList;
      if (page.length === 0) return;

      switch (e.key) {
        case 'ArrowDown': {
          e.preventDefault();
          setFocusedIndex((prev) => {
            const next = Math.min(prev + 1, page.length - 1);
            setShowHint(false);
            return next;
          });
          break;
        }
        case 'ArrowUp': {
          e.preventDefault();
          setFocusedIndex((prev) => {
            const next = Math.max(prev - 1, 0);
            setShowHint(false);
            return next;
          });
          break;
        }
        case 'Enter':
        case ' ':
          e.preventDefault();
          if (focusedIndex >= 0 && focusedIndex < page.length) {
            toggleAgent(page[focusedIndex]!.id);
          }
          break;
        case 'Escape':
          e.preventDefault();
          if (expandedAgentId) {
            setExpandedAgentId(null);
          }
          break;
      }
    },
    [filteredList, focusedIndex, toggleAgent, expandedAgentId],
  );

  // Focus the card element when focusedIndex changes.
  useEffect(() => {
    if (focusedIndex >= 0 && rosterRef.current) {
      const cards = rosterRef.current.querySelectorAll('[data-agent-card]');
      const el = cards[focusedIndex] as HTMLElement | undefined;
      el?.focus();
    }
  }, [focusedIndex]);

  useEffect(() => {
    if (focusedIndex >= filteredList.length) setFocusedIndex(-1);
  }, [filteredList.length, focusedIndex]);

  // ── Empty states ──────────────────────────────────────────────────
  // Three distinct states: no agents ever, filtered out, all finished.
  // All read the SESSION roster — the global one counts other tabs' agents,
  // which inflated this panel's stats and mis-fired its empty states.
  const allFinished =
    sessionFleetList.length > 0 && sessionFleetList.every((a) => a.status !== 'running');
  const toolbar = (
    <div className="flex shrink-0 items-center gap-1 border-b border-border/70 px-2 py-1">
      {FILTER_OPTIONS.map((opt) => (
        <button
          key={opt.value}
          type="button"
          onClick={() => setFilter(opt.value)}
          aria-pressed={filter === opt.value}
          className={cn(
            'rounded px-1.5 py-0.5 text-[10px] font-medium transition-colors',
            filter === opt.value
              ? 'bg-primary/10 text-primary'
              : 'text-muted-foreground hover:bg-muted/50 hover:text-foreground',
          )}
        >
          {t(opt.translationKey)}
        </button>
      ))}
      <span className="flex-1" />
      {hasFinished && (
        <button
          type="button"
          onClick={() => clearFinishedAgents(currentSessionId)}
          aria-label={t('activity:agents.clearFinishedTitle')}
          title={t('activity:agents.clearFinishedTitle')}
          className="inline-flex items-center gap-0.5 rounded px-1.5 py-0.5 text-[10px] text-muted-foreground transition-colors hover:bg-destructive/10 hover:text-destructive"
        >
          <Trash2 className="h-2.5 w-2.5" />
          {t('activity:agents.clearFinished')}
        </button>
      )}
    </div>
  );

  if (sessionFleetList.length === 0) {
    return (
      <div className="flex min-h-0 flex-1 items-center justify-center bg-[hsl(var(--surface-2)/0.35)] p-3">
        <div className="ws-surface flex max-w-[15rem] flex-col items-center gap-3 rounded-xl p-5 text-center text-muted-foreground">
          <span className="flex h-11 w-11 items-center justify-center rounded-lg bg-primary/10 text-primary">
            <Bot className="h-5 w-5" />
          </span>
          <div>
            <p className="text-sm font-semibold text-foreground">{t('activity:agents.empty')}</p>
            <p className="mt-1 text-xs">{t('activity:agents.emptyHint')}</p>
          </div>
        </div>
      </div>
    );
  }

  if (filteredList.length === 0 && filter !== 'all') {
    return (
      <>
        <FleetSummaryBar sessionId={currentSessionId ?? undefined} leaderName={leaderName} />
        {toolbar}
        <div className="flex min-h-0 flex-1 items-center justify-center bg-[hsl(var(--surface-2)/0.35)] p-3">
          <div className="ws-surface flex max-w-[15rem] flex-col items-center gap-3 rounded-xl p-5 text-center text-muted-foreground">
            <span className="flex h-11 w-11 items-center justify-center rounded-lg bg-muted/60 text-muted-foreground">
              <ListFilter className="h-5 w-5" />
            </span>
            <div>
              <p className="text-sm font-semibold text-foreground">
                {t('activity:agents.emptyFilteredTitle')}
              </p>
              <p className="mt-1 text-xs">{t('activity:agents.emptyFilteredHint')}</p>
            </div>
            <button
              type="button"
              onClick={() => setFilter('all')}
              className="h-7 rounded-md border border-border px-3 text-[11px] font-medium text-foreground hover:bg-accent transition-colors"
            >
              {t('activity:agents.emptyFilteredClear')}
            </button>
          </div>
        </div>
      </>
    );
  }

  if (allFinished && filter === 'all') {
    return (
      <>
        <FleetSummaryBar sessionId={currentSessionId ?? undefined} leaderName={leaderName} />
        <div className="flex min-h-0 flex-1 items-center justify-center bg-[hsl(var(--surface-2)/0.35)] p-3">
          <div className="ws-surface flex max-w-[15rem] flex-col items-center gap-3 rounded-xl p-5 text-center text-muted-foreground">
            <span className="flex h-11 w-11 items-center justify-center rounded-lg bg-success/10 text-success">
              <CheckCircle2 className="h-5 w-5" />
            </span>
            <div>
              <p className="text-sm font-semibold text-foreground">
                {t('activity:agents.emptyFinishedTitle')}
              </p>
              <p className="mt-1 text-xs">{t('activity:agents.emptyFinishedHint')}</p>
              <p className="mt-2 text-[11px] tabular-nums text-muted-foreground">
                {t('activity:agents.emptyFinishedStats', {
                  completed: sessionFleetList.filter((a) => a.status === 'completed').length,
                  failed: sessionFleetList.filter(
                    (a) => a.status === 'failed' || a.status === 'timeout',
                  ).length,
                })}
              </p>
            </div>
          </div>
        </div>
        <div className="shrink-0 border-t border-border/70 bg-card/75 px-3 py-2">
          <button
            type="button"
            onClick={() => clearFinishedAgents(currentSessionId)}
            className="w-full flex items-center justify-center gap-1.5 h-7 rounded-md border border-border text-[11px] text-muted-foreground hover:text-foreground hover:bg-accent transition-colors"
          >
            <Trash2 className="h-3 w-3" />
            {t('activity:agents.clearFinished')}
          </button>
        </div>
      </>
    );
  }

  return (
    <>
      <FleetSummaryBar sessionId={currentSessionId ?? undefined} leaderName={leaderName} />
      {toolbar}

      {/* Agent roster */}
      <div
        ref={rosterRef}
        role="listbox"
        aria-label={t('activity:agentsPanel.agentRoster')}
        aria-activedescendant={
          focusedIndex >= 0 ? `agent-card-${filteredList[focusedIndex]?.id}` : undefined
        }
        tabIndex={0}
        onKeyDown={handleRosterKeyDown}
        className="min-h-0 min-w-0 flex-1 space-y-1.5 overflow-y-auto overscroll-contain bg-[hsl(var(--surface-2)/0.35)] p-2"
      >
        {showHint && focusedIndex === -1 && (
          <div className="text-[9px] text-muted-foreground/60 text-center py-1 italic select-none">
            {t('activity:agents.rosterHint')}
          </div>
        )}
        {filteredList.map((a) => (
          <AgentRosterCard
            key={a.id}
            agent={a}
            isLeader={a.id === leaderId}
            isExpanded={expandedAgentId === a.id}
            isFocused={focusedIndex >= 0 && filteredList[focusedIndex]?.id === a.id}
            onToggle={() => toggleAgent(a.id)}
            onOpenInspector={() => openFleetInspector(a.id)}
          />
        ))}
      </div>
      <div className="shrink-0 border-t border-border/70 bg-card/75 px-3 py-2">
        <button
          type="button"
          onClick={() => openFleetInspector()}
          className="w-full flex items-center justify-center gap-1.5 h-7 rounded-md border border-border text-[11px] text-muted-foreground hover:text-foreground hover:bg-accent transition-colors"
        >
          <LayoutGrid className="h-3 w-3" />
          {t('activity:agents.openFull')}
        </button>
      </div>
    </>
  );
}
