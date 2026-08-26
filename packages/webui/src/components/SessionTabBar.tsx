/**
 * SessionTabBar — Multi-session browser tab strip.
 *
 * Sits directly below the WorkbenchTopbar and above the work surface.
 * Displays open and recent sessions as browser-like tabs, allows instant
 * context switching without full page reload, and provides a 1-click
 * "New Session" button.
 */

import {
  Bot,
  ChevronDown,
  History,
  MessageSquare,
  Plus,
  Sparkles,
  X,
} from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { useAppTranslation } from '@/i18n';
import { useWebSocket } from '@/hooks/useWebSocket';
import { cn } from '@/lib/utils';
import {
  useChatStore,
  useFleetStore,
  useHistoryStore,
  useSessionStore,
  useSessionTabStore,
  useUIStore,
  MAX_OPEN_TABS,
} from '@/stores';
import { useSystemPromptStore } from '@/stores/system-prompt-store';
import { toast } from './Toaster';
import { confirmModal } from './ConfirmModal';
import { getWSClient } from '@/lib/ws-client';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from './ui/dropdown-menu';

export function SessionTabBar() {
  const { t } = useAppTranslation();
  const { resumeSession, newSession, listSessions } = useWebSocket();
  const currentSessionId = useSessionStore((s) => s.session?.id);
  const currentTitle = useSessionStore((s) => s.session?.title);
  const currentNickname = useUIStore((s) => (currentSessionId ? s.sessionNicknames[currentSessionId] : undefined));
  const isLoading = useChatStore((s) => s.isLoading);
  const historyEntries = useHistoryStore((s) => s.entries);
  const fleetAgents = useFleetStore((s) => s.agents);
  const openTabIds = useSessionTabStore((s) => s.openTabIds);
  const { setOpenTabIds, openTab, closeTab } = useSessionTabStore();

  const tabAgentsMap = useMemo(() => {
    const map = new Map<string, { running: number; total: number }>();
    for (const agent of fleetAgents.values()) {
      if (!agent.sessionId) continue;
      const cur = map.get(agent.sessionId) ?? { running: 0, total: 0 };
      cur.total++;
      if (agent.status === 'running') cur.running++;
      map.set(agent.sessionId, cur);
    }
    return map;
  }, [fleetAgents]);

  // Reconcile open tabs with the server's session history — purge any deleted sessions
  useEffect(() => {
    if (historyEntries.length === 0) return;
    const validIds = new Set(historyEntries.map((e) => e.id));
    if (currentSessionId) validIds.add(currentSessionId);

    const valid = openTabIds.filter((id) => validIds.has(id));
    if (currentSessionId && !valid.includes(currentSessionId)) {
      valid.push(currentSessionId);
    }
    if (valid.length !== openTabIds.length || (currentSessionId && !openTabIds.includes(currentSessionId))) {
      setOpenTabIds(valid.slice(-MAX_OPEN_TABS));
    }
  }, [historyEntries, currentSessionId, openTabIds, setOpenTabIds]);

  // Ensure the current active session is reflected in the URL
  useEffect(() => {
    if (!currentSessionId) return;
    try {
      const url = new URL(window.location.href);
      if (url.searchParams.get('session') !== currentSessionId) {
        url.searchParams.set('session', currentSessionId);
        window.history.replaceState({}, '', url.toString());
      }
    } catch {
      // ignore
    }
  }, [currentSessionId]);

  // Load session list if empty
  useEffect(() => {
    if (historyEntries.length === 0) {
      listSessions?.();
    }
  }, [historyEntries.length, listSessions]);

  // Map of session metadata by ID
  const sessionMetaMap = useMemo(() => {
    const map = new Map<string, { title: string; date?: string }>();
    for (const entry of historyEntries) {
      map.set(entry.id, {
        title: entry.name || entry.title || entry.id.slice(0, 8),
        date: entry.lastActivityAt || entry.startedAt,
      });
    }
    if (currentSessionId) {
      map.set(currentSessionId, {
        title: currentNickname || currentTitle || currentSessionId.slice(0, 8),
      });
    }
    return map;
  }, [historyEntries, currentSessionId, currentTitle, currentNickname]);

  const handleSelectTab = (id: string) => {
    openTab(id, { resumeSession });
  };

  const handleCloseTab = async (id: string, e: React.MouseEvent) => {
    e.stopPropagation();

    // Check if this tab is currently running or has active subagents
    const isRunning =
      (id === currentSessionId && isLoading) || (tabAgentsMap.get(id)?.running ?? 0) > 0;
    if (isRunning) {
      const ok = await confirmModal({
        title: t('activity:sessions.closeRunningTabTitle', { defaultValue: 'Close running session?' }),
        message: t('activity:sessions.closeRunningTabMessage', {
          defaultValue:
            'This session has an active run or subagent in progress. Closing the tab will abort the process. Do you want to continue?',
        }),
        confirmLabel: t('common:action.delete', { defaultValue: 'Stop and Close' }),
        cancelLabel: t('common:action.cancel', { defaultValue: 'Cancel' }),
        danger: true,
      });
      if (!ok) return;

      try {
        getWSClient().send({ type: 'abort', payload: { sessionId: id } });
      } catch {
        // best-effort
      }
    }

    closeTab(id);
  };

  const handleNewSession = () => {
    if (openTabIds.length >= MAX_OPEN_TABS) {
      // Find an inactive tab that isn't currently running
      const inactiveTab = openTabIds.find((id) => {
        const isRunning =
          (id === currentSessionId && isLoading) || (tabAgentsMap.get(id)?.running ?? 0) > 0;
        return !isRunning && id !== currentSessionId;
      });

      if (inactiveTab) {
        // Automatically rotate out the inactive tab
        setOpenTabIds(openTabIds.filter((id) => id !== inactiveTab));
        useSystemPromptStore.getState().openPicker({ startsSession: true });
        return;
      }

      toast.info(
        t('activity:sessions.allTabsRunning', {
          defaultValue:
            'All 4 open tabs have active runs in progress. Please stop or close a tab before opening a new one.',
        }),
      );
      return;
    }
    useSystemPromptStore.getState().openPicker({ startsSession: true });
  };

  if (openTabIds.length === 0 && !currentSessionId) {
    return null;
  }

  return (
    <div className="flex h-9 shrink-0 items-center justify-between border-b border-border/70 bg-card/60 px-2 text-xs backdrop-blur-md">
      {/* Scrollable Tab Strip */}
      <div className="flex min-w-0 flex-1 items-center gap-1 overflow-x-auto overscroll-contain [scrollbar-gutter:stable] no-scrollbar">
        {openTabIds.map((id) => {
          const isActive = id === currentSessionId;
          const meta = sessionMetaMap.get(id);
          const label = meta?.title || id.slice(0, 8);

          return (
            <div
              key={id}
              onClick={() => handleSelectTab(id)}
              className={cn(
                'group relative flex h-7 max-w-[200px] min-w-[110px] cursor-pointer items-center justify-between gap-1.5 rounded-t-md border-t border-x px-2.5 transition-colors select-none',
                isActive
                  ? 'border-border/80 bg-background text-foreground font-medium shadow-xs'
                  : 'border-transparent bg-transparent text-muted-foreground hover:bg-muted/40 hover:text-foreground',
              )}
              title={label}
            >
              {/* Tab Icon & Status */}
              <span className="shrink-0">
                {isActive && isLoading ? (
                  <Bot className="h-3 w-3 animate-pulse text-primary" />
                ) : isActive ? (
                  <Sparkles className="h-3 w-3 text-primary" />
                ) : (
                  <MessageSquare className="h-3 w-3 opacity-60" />
                )}
              </span>

              {/* Tab Title */}
              <span className="truncate text-[11px] font-mono leading-tight">
                {label}
              </span>

              {/* Subagent Count Badge */}
              {(() => {
                const stats = tabAgentsMap.get(id);
                if (!stats || stats.total === 0) return null;
                if (stats.running > 0) {
                  return (
                    <span
                      className="inline-flex items-center gap-1 rounded bg-success/15 px-1 py-0.2 text-[9px] font-semibold text-success shrink-0"
                      title={`${stats.running} running subagent(s)`}
                    >
                      <span className="h-1.5 w-1.5 rounded-full bg-success animate-pulse" />
                      {stats.running}
                    </span>
                  );
                }
                return (
                  <span
                    className="inline-flex items-center rounded bg-muted/60 px-1 py-0.2 text-[9px] font-mono text-muted-foreground shrink-0"
                    title={`${stats.total} finished subagent(s)`}
                  >
                    {stats.total}
                  </span>
                );
              })()}

              {/* Close Button */}
              {openTabIds.length > 1 && (
                <button
                  type="button"
                  onClick={(e) => handleCloseTab(id, e)}
                  title="Close tab"
                  className={cn(
                    'h-4 w-4 shrink-0 inline-flex items-center justify-center rounded hover:bg-muted text-muted-foreground hover:text-foreground transition-colors',
                    isActive ? 'opacity-70 hover:opacity-100' : 'opacity-0 group-hover:opacity-100',
                  )}
                >
                  <X className="h-2.5 w-2.5" />
                </button>
              )}

              {/* Bottom active indicator */}
              {isActive && (
                <div className="absolute inset-x-0 -bottom-[1px] h-[2px] bg-primary" />
              )}
            </div>
          );
        })}

        {/* New Session Button */}
        <button
          type="button"
          onClick={handleNewSession}
          title={t('chat:newSession', 'New Session')}
          className="inline-flex h-7 w-7 shrink-0 items-center justify-center rounded hover:bg-muted text-muted-foreground hover:text-foreground transition-colors"
        >
          <Plus className="h-3.5 w-3.5" />
        </button>
      </div>

      {/* Quick Session Switcher Dropdown */}
      <div className="shrink-0 pl-1">
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <button
              type="button"
              className="inline-flex h-7 items-center gap-1 rounded px-2 text-[11px] text-muted-foreground hover:bg-muted hover:text-foreground transition-colors"
              title="All Sessions"
            >
              <History className="h-3 w-3" />
              <span className="hidden sm:inline">Sessions</span>
              <ChevronDown className="h-3 w-3 opacity-60" />
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-64 max-h-80 overflow-y-auto">
            <DropdownMenuLabel className="text-[10px] uppercase tracking-wider text-muted-foreground">
              Recent Sessions ({historyEntries.length})
            </DropdownMenuLabel>
            <DropdownMenuSeparator />
            {historyEntries.slice(0, 15).map((entry) => {
              const isActive = entry.id === currentSessionId;
              const title = entry.name || entry.title || entry.id.slice(0, 8);
              return (
                <DropdownMenuItem
                  key={entry.id}
                  onSelect={() => {
                    openTab(entry.id, { resumeSession });
                  }}
                  className="flex items-center justify-between text-xs font-mono"
                >
                  <div className="flex items-center gap-2 truncate">
                    <MessageSquare className={cn('h-3.5 w-3.5 shrink-0', isActive ? 'text-primary' : 'text-muted-foreground')} />
                    <span className={cn('truncate', isActive && 'text-primary font-medium')}>{title}</span>
                  </div>
                  {isActive && <span className="ml-1 text-[10px] text-primary font-semibold">● ACTIVE</span>}
                </DropdownMenuItem>
              );
            })}
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    </div>
  );
}
