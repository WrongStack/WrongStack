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
  ChartNoAxesCombined,
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
import { describeSessionActivity } from '@/stores/session-tab-store';
import { useSystemPromptStore } from '@/stores/system-prompt-store';
import { useUIStore } from '@/stores/ui-store';
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

  useEffect(() => {
    if (historyEntries.length === 0) listSessions?.();
  }, [historyEntries.length, listSessions]);

  const handleSelect = (sessionId: string) => {
    setMapOpen(false);
    openTab(sessionId, { resumeSession });
  };

  const handleClose = async (sessionId: string, e: React.MouseEvent) => {
    e.stopPropagation();
    // Gather the complete inventory BEFORE asking: the warning must name
    // everything that will be interrupted — the leader run, every running
    // subagent with its task, queued messages — not just "something runs".
    const report = describeSessionActivity(sessionId);

    // A tab with nothing on record — no chat history, no agents, no queue, no
    // live run — has nothing to lose. Close it on the spot, without asking.
    if (report.isEmpty) {
      closeTab(sessionId);
      return;
    }

    // Everything else (agent history on record, work still in flight) gets to
    // face the user before it dies: bring its tab to the front FIRST —
    // confirming a destructive close while staring at another session is how
    // the wrong conversation gets interrupted — then ask.
    const tab = tabs.find((tb) => tb.sessionId === sessionId);
    if (!tab?.isActive) openTab(sessionId, { resumeSession });

    if (report.isBusy) {
      const ok = await confirmModal({
        title: t('activity:sessions.closeOngoingTabTitle', {
          defaultValue: 'There is an ongoing operation in this session',
        }),
        message: t('activity:sessions.closeOngoingTabQuestion', {
          defaultValue: 'Are you sure you want to close this tab?',
        }),
        details: report.lines,
        confirmLabel: t('activity:sessions.interruptAndClose', {
          defaultValue: 'Interrupt and Close',
        }),
        cancelLabel: t('common:action.cancel', { defaultValue: 'Cancel' }),
        danger: true,
        // Enter/Escape must land on the safe side of a destructive close.
        defaultAction: 'cancel',
      });
      if (!ok) return;
      try {
        // Abort the run this tab owns — never "the current run", which would
        // stop whichever session happened to be on screen.
        getWSClient().sendAbort(sessionId);
      } catch {
        // best-effort
      }
    } else {
      // Idle, but the close still discards this session's history on record.
      const ok = await confirmModal({
        title: t('activity:sessions.closeHistoryTabTitle', {
          defaultValue: 'Close this tab?',
        }),
        message: t('activity:sessions.closeHistoryTabMessage', {
          defaultValue: 'This tab contains agent history. Are you sure you want to close it?',
        }),
        details: report.lines,
        confirmLabel: t('activity:sessions.closeTabAction', {
          defaultValue: 'Close Tab',
        }),
        cancelLabel: t('common:action.cancel', { defaultValue: 'Cancel' }),
        danger: true,
        defaultAction: 'cancel',
      });
      if (!ok) return;
    }
    closeTab(sessionId);
  };

  const handleNewSession = () => {
    setMapOpen(false);
    if (openTabIds.length < MAX_OPEN_TABS) {
      useSystemPromptStore.getState().openPicker({ startsSession: true });
      return;
    }
    toast.info(
      t('activity:sessions.allTabsRunning', {
        defaultValue: 'All 4 tab slots are full. Close a tab before opening a new session.',
      }),
    );
  };

  if (tabs.length === 0 && !currentSessionId) return null;

  return (
    <div className="ws-session-tabs flex h-10 shrink-0 items-center justify-between border-b border-border/70 px-2 text-xs backdrop-blur-md">
      <div
        role="tablist"
        aria-label={t('activity:tabBar.tablistLabel', { defaultValue: 'Open session tabs' })}
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
              tabIndex={tab.isActive ? 0 : -1}
              aria-selected={tab.isActive}
              onClick={() => handleSelect(tab.sessionId)}
              onKeyDown={(e) => {
                if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') {
                  e.preventDefault();
                  const currentIndex = tabs.findIndex((t) => t.sessionId === tab.sessionId);
                  const step = e.key === 'ArrowRight' ? 1 : -1;
                  const nextIndex = (currentIndex + step + tabs.length) % tabs.length;
                  const nextTab = tabs[nextIndex];
                  if (!nextTab) return;
                  // Roving focus follows activation, matching the tab pattern.
                  e.currentTarget.parentElement
                    ?.querySelectorAll<HTMLElement>('[role="tab"]')
                    [nextIndex]?.focus();
                  handleSelect(nextTab.sessionId);
                  return;
                }
                if (e.key !== 'Enter' && e.key !== ' ') return;
                e.preventDefault();
                handleSelect(tab.sessionId);
              }}
              className={cn(
                'ws-session-tab group relative flex h-8 max-w-[220px] min-w-[126px] cursor-pointer items-center gap-1.5 rounded-t-lg border px-2 select-none',
                tab.isActive
                  ? cn(accent.border, accent.activeBg, 'font-semibold text-foreground shadow-xs')
                  : 'border-border/40 bg-muted/20 text-muted-foreground hover:bg-muted/50 hover:text-foreground',
              )}
              title={t('activity:tabBar.tabTitle', {
                defaultValue: 'Slot {{slot}} · {{title}}\n{{provider}}/{{model}}\n{{sessionId}}',
                slot: tab.slot + 1,
                title: tab.title,
                provider: tab.provider,
                model: tab.model,
                sessionId: tab.sessionId,
              })}
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
                  className="shrink-0 rounded bg-primary/15 px-1 text-[9px] font-semibold text-foreground"
                  title={t('activity:tabBar.unreadTitle', {
                    defaultValue: '{{count}} new message(s) since you last looked',
                    count: tab.unread,
                  })}
                >
                  +{tab.unread}
                </span>
              )}

              <span
                className={cn(
                  'inline-flex shrink-0 items-center gap-0.5 rounded px-1 text-[9px] font-semibold',
                  tab.agentsRunning > 0
                    ? 'bg-success/15 text-success'
                    : tab.agentsTotal > 0
                      ? 'bg-muted/60 font-mono text-muted-foreground'
                      : 'bg-muted/30 font-mono text-muted-foreground/65',
                )}
                title={
                  tab.agentsRunning > 0
                    ? t('activity:tabBar.agentsRunningTitle', {
                        defaultValue: '{{running}} running agent(s) in this tab, {{total}} total',
                        running: tab.agentsRunning,
                        total: tab.agentsTotal,
                      })
                    : t('activity:tabBar.agentsTotalTitle', {
                        defaultValue: '{{count}} agent(s) in this tab',
                        count: tab.agentsTotal,
                      })
                }
              >
                <Bot className="h-2.5 w-2.5" />
                {tab.agentsRunning > 0
                  ? `${tab.agentsRunning}/${tab.agentsTotal}`
                  : tab.agentsTotal}
              </span>

              {tabs.length > 1 && (
                <button
                  type="button"
                  onClick={(e) => handleClose(tab.sessionId, e)}
                  title={t('activity:tabBar.closeTab', { defaultValue: 'Close tab' })}
                  // WCAG 2.5.8: the X is 16x16, under the 24px floor. The
                  // coarse-pointer-only .ws-touch-target pseudo grows the hit
                  // area, but the overflow-x-auto strip clips it vertically to
                  // the 28px row (and horizontally at the scroll edge), so the
                  // button itself also floors at 24x24 on coarse pointers —
                  // fine-pointer layout is unchanged.
                  className={cn(
                    'pointer-coarse:min-h-6 pointer-coarse:min-w-6 ws-touch-target',
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
                <div className={cn('absolute inset-x-0 top-0 h-[3px] rounded-t-md', accent.dot)} />
              )}
            </div>
          );
        })}

        <button
          type="button"
          onClick={handleNewSession}
          title={t('chat:newSession', 'New Session')}
          // Icon-only control: `title` alone is a weak accessible name, so
          // the name is stated outright for assistive technology.
          aria-label={t('chat:newSession', 'New Session')}
          className="inline-flex h-7 w-7 shrink-0 items-center justify-center rounded hover:bg-muted text-muted-foreground hover:text-foreground transition-colors"
        >
          <Plus className="h-3.5 w-3.5" />
        </button>
      </div>

      <div className="flex shrink-0 items-center gap-1 pl-1">
        <button
          type="button"
          disabled={!currentSessionId}
          onClick={() => useUIStore.getState().setCurrentView('session-story')}
          title={t('activity:tabBar.storyTitle', {
            defaultValue: 'Visual story of this session and its subagents',
          })}
          aria-label={t('activity:tabBar.storyAriaLabel', {
            defaultValue: 'Open session story',
          })}
          className="inline-flex h-7 items-center gap-1 rounded px-2 text-[11px] text-info hover:bg-muted disabled:opacity-40"
        >
          <ChartNoAxesCombined size={14} />
          <span className="hidden sm:inline">
            {t('activity:tabBar.storyLabel', { defaultValue: 'Story' })}
          </span>
        </button>
        <DropdownMenu open={mapOpen} onOpenChange={setMapOpen}>
          <DropdownMenuTrigger asChild>
            <button
              type="button"
              className="inline-flex h-7 items-center gap-1 rounded px-2 text-[11px] text-muted-foreground hover:bg-muted hover:text-foreground transition-colors"
              title={t('activity:tabBar.mapTitle', { defaultValue: 'What is in each tab' })}
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
              title={t('activity:tabBar.allSessionsTitle', { defaultValue: 'All Sessions' })}
            >
              <History className="h-3 w-3" />
              <span className="hidden sm:inline">Sessions</span>
              <ChevronDown className="h-3 w-3 opacity-60" />
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-64 max-h-80 overflow-y-auto">
            <DropdownMenuLabel className="text-[10px] uppercase tracking-wider text-muted-foreground">
              {t('activity:tabBar.recentSessions', {
                defaultValue: 'Recent Sessions ({{count}})',
                count: historyEntries.length,
              })}
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
                      title={t('activity:tabBar.alreadyOpen', {
                        defaultValue: 'Already open in slot {{slot}}',
                        slot: openSlot + 1,
                      })}
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
