/**
 * SessionTabBar — the four slots, made visible.
 *
 * Each slot carries a fixed number and colour so a tab is identifiable without
 * reading a session id, and each entry says what is inside it: running or idle,
 * how many messages arrived while you were elsewhere, how many subagents it
 * owns, whether it is waiting on you. The `Map` button opens the full picture.
 *
 * Everything rendered here is derived from the lane registries (see
 * `SessionTabBar/summaries.ts`). The strip has no state of its own to fall out
 * of step with the tabs it describes.
 */

import {
  Bot,
  ChevronDown,
  History,
  Loader2,
  MessageSquare,
  Plus,
  TriangleAlert,
  X,
} from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { useWebSocket } from '@/hooks/useWebSocket';
import { useAppTranslation } from '@/i18n';
import { cn } from '@/lib/utils';
import { getWSClient } from '@/lib/ws-client';
import { MAX_OPEN_TABS, useActiveSessionId, useHistoryStore, useSessionTabStore } from '@/stores';
import { isTabBusy } from '@/stores/session-tab-store';
import { useSystemPromptStore } from '@/stores/system-prompt-store';
import { confirmModal } from './ConfirmModal';
import { slotAccent, useTabSummaries } from './SessionTabBar/summaries';
import { TabMap } from './SessionTabBar/TabMap';
import { toast } from './Toaster';
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
  const { resumeSession, listSessions } = useWebSocket();
  // The lane pointer, not the lane's SessionInfo: a tab opened moments ago has
  // no SessionInfo until its `session.start` lands, and reading that instead
  // let the purge effect below decide the brand-new tab was not the current
  // session and drop its slot (disposing its lanes) before it ever filled.
  const currentSessionId = useActiveSessionId();
  const historyEntries = useHistoryStore((s) => s.entries);
  const openTabIds = useSessionTabStore((s) => s.openTabIds);
  const setOpenTabIds = useSessionTabStore((s) => s.setOpenTabIds);
  const openTab = useSessionTabStore((s) => s.openTab);
  const closeTab = useSessionTabStore((s) => s.closeTab);
  const [mapOpen, setMapOpen] = useState(false);

  const historyTitles = useMemo(() => {
    const map = new Map<string, string>();
    for (const entry of historyEntries) {
      map.set(entry.id, entry.name || entry.title || entry.id.slice(0, 8));
    }
    return map;
  }, [historyEntries]);

  const tabs = useTabSummaries(historyTitles);

  // Purge slots whose session the server no longer knows about.
  useEffect(() => {
    if (historyEntries.length === 0) return;
    const valid = new Set(historyEntries.map((e) => e.id));
    if (currentSessionId) valid.add(currentSessionId);
    const kept = openTabIds.filter((id) => valid.has(id));
    if (currentSessionId && !kept.includes(currentSessionId)) kept.push(currentSessionId);
    if (kept.length !== openTabIds.length) setOpenTabIds(kept.slice(-MAX_OPEN_TABS));
  }, [historyEntries, currentSessionId, openTabIds, setOpenTabIds]);

  useEffect(() => {
    if (historyEntries.length === 0) listSessions?.();
  }, [historyEntries.length, listSessions]);

  const handleSelect = (sessionId: string) => {
    setMapOpen(false);
    openTab(sessionId, { resumeSession });
  };

  const handleClose = async (sessionId: string, e: React.MouseEvent) => {
    e.stopPropagation();
    if (isTabBusy(sessionId)) {
      const ok = await confirmModal({
        title: t('activity:sessions.closeRunningTabTitle', {
          defaultValue: 'Close running session?',
        }),
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
        // Abort the run this tab owns — never "the current run", which would
        // stop whichever session happened to be on screen.
        getWSClient().sendAbort(sessionId);
      } catch {
        // best-effort
      }
    }
    closeTab(sessionId);
  };

  const handleNewSession = () => {
    setMapOpen(false);
    if (openTabIds.length < MAX_OPEN_TABS) {
      useSystemPromptStore.getState().openPicker({ startsSession: true });
      return;
    }
    // Full: recycle an idle slot rather than growing past four.
    const recyclable = openTabIds.find((id) => id !== currentSessionId && !isTabBusy(id));
    if (recyclable) {
      setOpenTabIds(openTabIds.filter((id) => id !== recyclable));
      useSystemPromptStore.getState().openPicker({ startsSession: true });
      return;
    }
    toast.info(
      t('activity:sessions.allTabsRunning', {
        defaultValue:
          'All 4 open tabs have active runs in progress. Please stop or close a tab before opening a new one.',
      }),
    );
  };

  if (tabs.length === 0 && !currentSessionId) return null;

  return (
    <div className="flex h-9 shrink-0 items-center justify-between border-b border-border/70 bg-card/60 px-2 text-xs backdrop-blur-md">
      <div
        role="tablist"
        aria-label="Open session tabs"
        className="flex min-w-0 flex-1 items-center gap-1 overflow-x-auto overscroll-contain [scrollbar-gutter:stable] no-scrollbar"
      >
        {tabs.map((tab) => {
          const accent = slotAccent(tab.slot);
          return (
            // A div rather than a button: the close control nests inside, and
            // a button inside a button is invalid. `role="tab"` + key handling
            // gives keyboard users the same affordance.
            <div
              key={tab.sessionId}
              role="tab"
              tabIndex={0}
              aria-selected={tab.isActive}
              onClick={() => handleSelect(tab.sessionId)}
              onKeyDown={(e) => {
                if (e.key !== 'Enter' && e.key !== ' ') return;
                e.preventDefault();
                handleSelect(tab.sessionId);
              }}
              className={cn(
                'group relative flex h-7 max-w-[220px] min-w-[126px] cursor-pointer items-center gap-1.5 rounded-t-md border-t border-x px-2 transition-colors select-none',
                tab.isActive
                  ? 'border-border/80 bg-background text-foreground font-medium shadow-xs'
                  : 'border-transparent bg-transparent text-muted-foreground hover:bg-muted/40 hover:text-foreground',
              )}
              title={`Slot ${tab.slot + 1} · ${tab.title}\n${tab.provider}/${tab.model}\n${tab.sessionId}`}
            >
              {/* Slot number — the stable handle on "which tab is this". */}
              <span
                className={cn(
                  'inline-flex h-4 w-4 shrink-0 items-center justify-center rounded text-[9px] font-bold',
                  accent.soft,
                  accent.text,
                )}
              >
                {tab.slot + 1}
              </span>

              <span className="shrink-0">
                {tab.needsAttention ? (
                  <TriangleAlert className="h-3 w-3 text-warning" />
                ) : tab.isRunning ? (
                  <Loader2 className="h-3 w-3 animate-spin text-primary" />
                ) : (
                  <MessageSquare className="h-3 w-3 opacity-50" />
                )}
              </span>

              <span className="truncate text-[11px] font-mono leading-tight">{tab.title}</span>

              {tab.unread > 0 && (
                <span
                  className="shrink-0 rounded bg-primary/15 px-1 text-[9px] font-semibold text-primary"
                  title={`${tab.unread} new message(s) since you last looked`}
                >
                  +{tab.unread}
                </span>
              )}

              {tab.agentsTotal > 0 && (
                <span
                  className={cn(
                    'inline-flex shrink-0 items-center gap-0.5 rounded px-1 text-[9px] font-semibold',
                    tab.agentsRunning > 0
                      ? 'bg-success/15 text-success'
                      : 'bg-muted/60 font-mono text-muted-foreground',
                  )}
                  title={
                    tab.agentsRunning > 0
                      ? `${tab.agentsRunning} running subagent(s) in this tab`
                      : `${tab.agentsTotal} finished subagent(s) in this tab`
                  }
                >
                  <Bot className="h-2.5 w-2.5" />
                  {tab.agentsRunning > 0 ? tab.agentsRunning : tab.agentsTotal}
                </span>
              )}

              {tabs.length > 1 && (
                <button
                  type="button"
                  onClick={(e) => handleClose(tab.sessionId, e)}
                  title="Close tab"
                  className={cn(
                    'ml-auto h-4 w-4 shrink-0 inline-flex items-center justify-center rounded hover:bg-muted text-muted-foreground hover:text-foreground transition-colors',
                    tab.isActive
                      ? 'opacity-70 hover:opacity-100'
                      : 'opacity-0 group-hover:opacity-100',
                  )}
                >
                  <X className="h-2.5 w-2.5" />
                </button>
              )}

              {tab.isActive && (
                <div className={cn('absolute inset-x-0 -bottom-[1px] h-[2px]', accent.dot)} />
              )}
            </div>
          );
        })}

        <button
          type="button"
          onClick={handleNewSession}
          title={t('chat:newSession', 'New Session')}
          className="inline-flex h-7 w-7 shrink-0 items-center justify-center rounded hover:bg-muted text-muted-foreground hover:text-foreground transition-colors"
        >
          <Plus className="h-3.5 w-3.5" />
        </button>
      </div>

      <div className="flex shrink-0 items-center gap-1 pl-1">
        <DropdownMenu open={mapOpen} onOpenChange={setMapOpen}>
          <DropdownMenuTrigger asChild>
            <button
              type="button"
              className="inline-flex h-7 items-center gap-1 rounded px-2 text-[11px] text-muted-foreground hover:bg-muted hover:text-foreground transition-colors"
              title="What is in each tab"
            >
              <span className="font-mono">
                {tabs.length}/{MAX_OPEN_TABS}
              </span>
              <span className="hidden sm:inline">Map</span>
              <ChevronDown className="h-3 w-3 opacity-60" />
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="p-0">
            <TabMap tabs={tabs} onSelect={handleSelect} onNew={handleNewSession} />
          </DropdownMenuContent>
        </DropdownMenu>

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
              const openSlot = openTabIds.indexOf(entry.id);
              const title = entry.name || entry.title || entry.id.slice(0, 8);
              return (
                <DropdownMenuItem
                  key={entry.id}
                  onSelect={() => handleSelect(entry.id)}
                  className="flex items-center justify-between text-xs font-mono"
                >
                  <div className="flex items-center gap-2 truncate">
                    <MessageSquare
                      className={cn(
                        'h-3.5 w-3.5 shrink-0',
                        entry.id === currentSessionId ? 'text-primary' : 'text-muted-foreground',
                      )}
                    />
                    <span
                      className={cn(
                        'truncate',
                        entry.id === currentSessionId && 'text-primary font-medium',
                      )}
                    >
                      {title}
                    </span>
                  </div>
                  {openSlot >= 0 && (
                    <span
                      className={cn('ml-1 text-[10px] font-semibold', slotAccent(openSlot).text)}
                      title={`Already open in slot ${openSlot + 1}`}
                    >
                      ▪ {openSlot + 1}
                    </span>
                  )}
                </DropdownMenuItem>
              );
            })}
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    </div>
  );
}
