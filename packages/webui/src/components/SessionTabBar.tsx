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
  useHistoryStore,
  useSessionStore,
  useUIStore,
} from '@/stores';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from './ui/dropdown-menu';

const MAX_VISIBLE_TABS = 8;

export function SessionTabBar() {
  const { t } = useAppTranslation();
  const { resumeSession, newSession, listSessions } = useWebSocket();
  const currentSessionId = useSessionStore((s) => s.session?.id);
  const currentTitle = useSessionStore((s) => s.session?.title);
  const currentNickname = useUIStore((s) => (currentSessionId ? s.sessionNicknames[currentSessionId] : undefined));
  const isLoading = useChatStore((s) => s.isLoading);
  const historyEntries = useHistoryStore((s) => s.entries);

  // Keep track of open session tab IDs in local state
  const [openTabIds, setOpenTabIds] = useState<string[]>(() => {
    return currentSessionId ? [currentSessionId] : [];
  });

  // Ensure the current active session is always in the tab list
  useEffect(() => {
    if (!currentSessionId) return;
    setOpenTabIds((prev) => {
      if (prev.includes(currentSessionId)) return prev;
      // Prepend or append the current session
      const next = [...prev, currentSessionId];
      if (next.length > MAX_VISIBLE_TABS) {
        return next.slice(-MAX_VISIBLE_TABS);
      }
      return next;
    });
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
    if (id === currentSessionId) return;
    resumeSession?.(id);
  };

  const handleCloseTab = (id: string, e: React.MouseEvent) => {
    e.stopPropagation();
    const nextTabs = openTabIds.filter((tabId) => tabId !== id);
    setOpenTabIds(nextTabs);

    // If closing the currently active tab, switch to the last remaining tab
    if (id === currentSessionId && nextTabs.length > 0) {
      const targetId = nextTabs[nextTabs.length - 1];
      if (targetId) {
        resumeSession?.(targetId);
      }
    }
  };

  const handleNewSession = () => {
    newSession?.();
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
                    if (!openTabIds.includes(entry.id)) {
                      setOpenTabIds((prev) => [...prev, entry.id]);
                    }
                    resumeSession?.(entry.id);
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
