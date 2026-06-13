import { cn } from '@/lib/utils';
import { getWSClient } from '@/lib/ws-client';
import { useChatStore, useHistoryStore, useSessionStore, useUIStore } from '@/stores';
import { useLocalPrefs } from '@/stores/local-prefs';
import { useConfigStore } from '@/stores';
import {
  Activity,
  ArrowDown,
  ArrowUp,
  Bot,
  ChevronDown,
  Clock,
  Cpu,
  History,
  PanelLeftOpen,
  Pencil,
  Terminal,
  Zap,
} from 'lucide-react';
import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { VList, type VListHandle } from 'virtua';
import { AutonomyPicker } from '../AutonomyPicker';
import { ChatInput } from '../ChatInput';
import { CheckpointTimeline } from '../CheckpointTimeline';
import { ContextModePicker } from '../ContextModePicker';
import { ContextFillBar } from '../ContextBar';
import { ContextBreakdownModal } from '../ContextBreakdownModal';
import { CostChip } from '../CostChip';
import { MessageBubble } from '../MessageBubble';
import { ModePicker } from '../ModePicker';
import { ProcessMonitor } from '../ProcessMonitor';
import { SearchOverlay } from '../SearchOverlay';
import { ToolGroup } from '../ToolGroup';
import { WelcomeScreen } from '../WelcomeScreen';
import { Button } from '../ui/button';
import { type ChatRow, buildChatRows, fmtTok } from './utils.js';
import { ThinkingBubble } from './ThinkingBubble.js';

/**
 * One virtualized chat row. Module-scoped + memoized so a stable row keeps its
 * identity across renders; the heavy markdown lives in MessageBubble (also
 * memoized on `message` identity), which `appendToMessage` preserves for every
 * message except the one being streamed.
 */
const ChatRowView = memo(function ChatRowView({
  row,
  isLoading,
  compactMode,
  isFirstRow,
}: {
  row: ChatRow;
  isLoading: boolean;
  compactMode: boolean;
  isFirstRow: boolean;
}) {
  const wrap = cn(
    'mx-auto max-w-5xl w-full px-4',
    isFirstRow && 'pt-4',
    compactMode ? 'pb-3' : 'pb-6',
  );
  if (row.kind === 'day') {
    return (
      <div className={wrap}>
        <div className="flex items-center gap-3 py-1 text-[11px] text-muted-foreground/70 uppercase tracking-wider font-medium">
          <div className="flex-1 h-px bg-border/50" />
          <span>{row.label}</span>
          <div className="flex-1 h-px bg-border/50" />
        </div>
      </div>
    );
  }
  if (row.kind === 'user') {
    return (
      <div className={wrap}>
        <MessageBubble message={row.message} isFirst />
      </div>
    );
  }
  return (
    <div className={wrap}>
      <div className={cn('chat-turn', compactMode ? 'space-y-1' : 'space-y-1.5')}>
        {row.items.map((it) => {
          if (it.kind === 'msg') {
            return (
              <MessageBubble
                key={it.key}
                message={it.message}
                isFirst={it.isFirst}
                isContinuation={it.isContinuation}
              />
            );
          }
          const defaultOpen = row.isLastTurn && it.isLastGroup && isLoading && it.hasRunningTool;
          return (
            <ToolGroup
              key={it.key}
              tools={it.tools}
              defaultOpen={defaultOpen}
              isContinuation={it.isContinuation}
            />
          );
        })}
      </div>
    </div>
  );
});

export function ChatView() {
  // Narrow selectors — subscribing to the whole store re-rendered ChatView on
  // every stream delta (thinking / tool progress) even when the message list
  // was untouched.
  const messages = useChatStore((s) => s.messages);
  const isLoading = useChatStore((s) => s.isLoading);
  const sidebarOpen = useUIStore((s) => s.sidebarOpen);
  const toggleSidebar = useUIStore((s) => s.toggleSidebar);
  const compactMode = useUIStore((s) => s.compactMode);
  const { totalTokens, startTime, lastInputTokens, maxContext, iteration } = useSessionStore();
  const session = useSessionStore((s) => s.session);
  const sessionId = session?.id;
  const nickname = useUIStore((s) => (sessionId ? s.sessionNicknames[sessionId] : undefined));
  const setSessionNickname = useUIStore((s) => s.setSessionNickname);
  const sessionTitle = session?.title;
  const [renamingTitle, setRenamingTitle] = useState(false);
  const [titleDraft, setTitleDraft] = useState('');

  // Session switcher state
  const historyEntries = useHistoryStore((s) => s.entries);
  const [switcherOpen, setSwitcherOpen] = useState(false);
  const switcherRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!switcherOpen) return;
    const onClick = (e: MouseEvent) => {
      if (!switcherRef.current?.contains(e.target as Node)) setSwitcherOpen(false);
    };
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setSwitcherOpen(false); };
    document.addEventListener('mousedown', onClick);
    document.addEventListener('keydown', onKey);
    return () => { document.removeEventListener('mousedown', onClick); document.removeEventListener('keydown', onKey); };
  }, [switcherOpen]);

  const { provider, model } = useConfigStore();
  const vlistRef = useRef<VListHandle>(null);

  // Grouped, memoized rows — recomputed only when the messages array identity
  // changes (i.e. a coalesced stream flush), not on every unrelated store write.
  const rows = useMemo(() => buildChatRows(messages), [messages]);
  // VList children = rows + the trailing live-activity item. Kept in a ref so
  // scroll callbacks read the latest count without re-creating on every change.
  const childCountRef = useRef(0);
  childCountRef.current = rows.length + 1;

  // message id → row index, for search-jump into a virtualized-out hit.
  const rowIndexById = useMemo(() => {
    const map = new Map<string, number>();
    rows.forEach((row, i) => {
      if (row.kind === 'user') map.set(row.message.id, i);
      else if (row.kind === 'agent') {
        for (const it of row.items) {
          if (it.kind === 'msg') map.set(it.message.id, i);
          else for (const t of it.tools) map.set(t.id, i);
        }
      }
    });
    return map;
  }, [rows]);
  const scrollTarget = useUIStore((s) => s.scrollTarget);

  // Autonomy mode — read from the shared local-prefs store (seeded from the
  // server's config-backed snapshot on connect), NOT component-local state.
  // A local useState here always rendered "off" regardless of the real mode.
  const autonomy = useLocalPrefs((s) => s.autonomy);

  const handleAutonomyChange = useCallback((mode: 'off' | 'suggest' | 'auto' | 'eternal' | 'eternal-parallel') => {
    useLocalPrefs.getState().set({ autonomy: mode });
    const ws = getWSClient();
    ws?.send?.({ type: 'autonomy.switch', payload: { mode } });
  }, []);

  // Overlay toggles — triggered by header buttons
  const [processOpen, setProcessOpen] = useState(false);
  const [checkpointOpen, setCheckpointOpen] = useState(false);

  // Context breakdown modal
  const [breakdownOpen, setBreakdownOpen] = useState(false);

  // Listen for the custom event fired by ContextModePicker's ops menu → "Debug Context"
  useEffect(() => {
    const handler = () => setBreakdownOpen(true);
    document.addEventListener('open:context-breakdown', handler);
    return () => document.removeEventListener('open:context-breakdown', handler);
  }, []);

  // Context window usage — uncapped so over-limit (>100%) is visible
  const ctxPct =
    maxContext > 0 && lastInputTokens > 0
      ? Math.round((lastInputTokens / maxContext) * 100)
      : 0;
  const ctxTone =
    ctxPct >= 85
      ? 'bg-red-500/15 text-red-600 dark:text-red-400'
      : ctxPct >= 70
        ? 'bg-amber-500/15 text-amber-600 dark:text-amber-400'
        : 'bg-muted text-muted-foreground';

  // Auto-scroll with "user is reading older messages" lock. Scroll metrics now
  // come from the VList imperative handle instead of the Radix viewport.
  const [pinnedToBottom, setPinnedToBottom] = useState(true);
  const [unreadCount, setUnreadCount] = useState(0);
  const [scrolledDeep, setScrolledDeep] = useState(false);
  const lastSeenCount = useRef(messages.length);

  const handleScroll = useCallback(() => {
    const h = vlistRef.current;
    if (!h) return;
    const dist = h.scrollSize - h.scrollOffset - h.viewportSize;
    const nowPinned = dist < 120;
    setPinnedToBottom(nowPinned);
    if (nowPinned) {
      setUnreadCount(0);
      lastSeenCount.current = useChatStore.getState().messages.length;
    }
    setScrolledDeep(h.scrollOffset > h.viewportSize && h.scrollSize > h.viewportSize * 2.5);
  }, []);

  // Follow new content while pinned; otherwise accumulate the unread count.
  useEffect(() => {
    const h = vlistRef.current;
    if (!h) return;
    if (pinnedToBottom) {
      h.scrollToIndex(childCountRef.current - 1, { align: 'end' });
      lastSeenCount.current = messages.length;
    } else {
      const delta = messages.length - lastSeenCount.current;
      if (delta > 0) setUnreadCount(delta);
    }
  }, [messages, pinnedToBottom]);

  // A session switch (resume / new) repopulates the transcript wholesale —
  // open it pinned to the end even if the user had scrolled up in the
  // previous session, so the replayed history starts at its latest turn.
  // biome-ignore lint/correctness/useExhaustiveDependencies: re-run only on session change
  useEffect(() => {
    setPinnedToBottom(true);
    setUnreadCount(0);
    lastSeenCount.current = useChatStore.getState().messages.length;
    // Rows reflect the freshly-replayed transcript on the next frame.
    requestAnimationFrame(() => {
      vlistRef.current?.scrollToIndex(childCountRef.current - 1, { align: 'end' });
    });
  }, [sessionId]);

  // Search-jump: scroll a (possibly virtualized-out) hit into view.
  useEffect(() => {
    if (!scrollTarget) return;
    const idx = rowIndexById.get(scrollTarget.id);
    if (idx === undefined) return;
    vlistRef.current?.scrollToIndex(idx, { align: 'center', smooth: true });
  }, [scrollTarget, rowIndexById]);

  const scrollToBottom = useCallback(() => {
    vlistRef.current?.scrollToIndex(childCountRef.current - 1, { align: 'end', smooth: true });
    setPinnedToBottom(true);
    setUnreadCount(0);
    lastSeenCount.current = useChatStore.getState().messages.length;
  }, []);

  const scrollToTop = useCallback(() => {
    vlistRef.current?.scrollToIndex(0, { align: 'start', smooth: true });
  }, []);

  // Live "agent is busy" indicator
  const [runStartedAt, setRunStartedAt] = useState<number | null>(null);
  const [nowTick, setNowTick] = useState<number>(() => Date.now());
  const streamAnchor = useRef<{ id: string; at: number; len: number } | null>(null);
  useEffect(() => {
    if (isLoading && runStartedAt === null) setRunStartedAt(Date.now());
    if (!isLoading && runStartedAt !== null) setRunStartedAt(null);
  }, [isLoading, runStartedAt]);
  useEffect(() => {
    if (!isLoading) return;
    const t = setInterval(() => setNowTick(Date.now()), 500);
    return () => clearInterval(t);
  }, [isLoading]);

  const formatDuration = (start: number | null) => {
    if (!start) return '--';
    const seconds = Math.floor((Date.now() - start) / 1000);
    if (seconds < 60) return `${seconds}s`;
    const minutes = Math.floor(seconds / 60);
    const secs = seconds % 60;
    return `${minutes}m ${secs}s`;
  };

  const agentState = (() => {
    if (!isLoading) return 'idle' as const;
    const last = messages[messages.length - 1];
    const isStreaming = last?.role === 'assistant' && !!last.content && last.streaming;
    return isStreaming ? ('streaming' as const) : ('thinking' as const);
  })();
  const stateTone =
    agentState === 'idle'
      ? 'bg-muted text-muted-foreground'
      : agentState === 'streaming'
        ? 'bg-blue-500/10 text-blue-600 dark:text-blue-400'
        : 'bg-amber-500/10 text-amber-600 dark:text-amber-400';

  const hasStatusContent =
    (maxContext > 0 && lastInputTokens > 0) || totalTokens.input > 0 || !!startTime;

  return (
    <div className="flex flex-col flex-1 min-h-0">
      {/* Header */}
      <header className="flex flex-col border-b bg-card/95 backdrop-blur-sm supports-[backdrop-filter]:bg-card/80 shrink-0 sticky top-0 z-20">
        <div className="flex items-center justify-between gap-2 px-3 py-2">
          {/* Static text chips live in the overflow-hidden group so long
              session titles clip cleanly on narrow viewports. The
              dropdown-bearing chips (model picker, mode/ctx pickers,
              autonomy picker, session switcher) sit in their own sibling
              below — overflow-hidden would otherwise chop their
              `position: absolute` dropdown panels off at the row edge
              and the user sees no menu open. */}
          <div className="flex items-center gap-1.5 min-w-0 flex-1 overflow-hidden">
            {!sidebarOpen && (
              <Button
                variant="ghost"
                size="icon"
                className="h-7 w-7 shrink-0"
                onClick={toggleSidebar}
                title="Open sidebar (Ctrl+\\)"
              >
                <PanelLeftOpen className="h-4 w-4" />
              </Button>
            )}
            {!sidebarOpen && (
              <div className="flex items-center gap-1.5 shrink-0 mr-1">
                <div className="w-5 h-5 rounded bg-primary flex items-center justify-center">
                  <Zap className="h-3 w-3 text-primary-foreground" />
                </div>
              </div>
            )}
            {/* Connection / project / cwd moved out of this header — the
                ActivityBar dot + ConnectionBanner own connection state and
                the Session panel owns project/cwd. Keeps this row narrow. */}
            <span
              className={cn(
                'flex items-center gap-1 px-1.5 py-0.5 rounded-full text-[11px] font-medium shrink-0 tabular-nums',
                stateTone,
              )}
              title={`Agent state: ${agentState}`}
            >
              {agentState !== 'idle' && (
                <span className="h-1.5 w-1.5 rounded-full bg-current animate-pulse" />
              )}
              <span>{agentState}</span>
            </span>
            {/* Session title — click to rename, shows nickname if set */}
            {sessionId && (
              renamingTitle ? (
                <input
                  value={titleDraft}
                  onChange={(e) => setTitleDraft(e.target.value)}
                  onBlur={() => { if (titleDraft.trim()) setSessionNickname(sessionId, titleDraft); setRenamingTitle(false); }}
                  onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); if (titleDraft.trim()) setSessionNickname(sessionId, titleDraft); setRenamingTitle(false); } else if (e.key === 'Escape') { e.preventDefault(); setRenamingTitle(false); } }}
                  placeholder="Session name…"
                  className="h-5 px-1.5 text-[11px] bg-background border border-primary/40 rounded focus:outline-none focus:ring-1 focus:ring-ring shrink-0 w-32"
                  autoFocus
                />
              ) : (
                <button
                  type="button"
                  onClick={() => { setTitleDraft(nickname || sessionTitle || ''); setRenamingTitle(true); }}
                  className="flex items-center gap-1 text-[11px] font-medium text-foreground/80 hover:text-foreground truncate max-w-[12rem] shrink-0 px-1 -mx-1 rounded hover:bg-muted/50 transition-colors"
                  title="Click to rename session"
                >
                  <Pencil className="h-2.5 w-2.5 text-muted-foreground shrink-0" />
                  <span className="truncate">{nickname || sessionTitle || 'Untitled'}</span>
                </button>
              )
            )}
          </div>
          {/* Interactive chips (model picker, mode/ctx, autonomy, session
              switcher, iter). No overflow-hidden so their absolutely
              positioned dropdowns can extend below the row. shrink-0 so
              they stay full-size when the header is narrow. */}
          <div className="flex items-center gap-1.5 shrink-0">
            {/* Session switcher — quick dropdown to jump between recent sessions */}
            {historyEntries.length > 1 && (
              <div ref={switcherRef} className="relative shrink-0">
                <button
                  type="button"
                  onClick={() => setSwitcherOpen((v) => !v)}
                  className="flex items-center gap-0.5 px-1 py-0.5 rounded text-[10px] text-muted-foreground hover:text-foreground hover:bg-muted/50 transition-colors"
                  title="Switch session"
                >
                  <History className="h-3 w-3" />
                  <ChevronDown className="h-2.5 w-2.5" />
                </button>
                {switcherOpen && (
                  <div className="absolute left-0 top-full mt-1 z-40 w-64 rounded-md border bg-popover shadow-lg p-1 max-h-60 overflow-y-auto">
                    {historyEntries.slice(0, 15).map((e) => (
                      <button
                        key={e.id}
                        type="button"
                        onClick={() => {
                          const ws = getWSClient();
                          ws?.resumeSession?.(e.id);
                          setSwitcherOpen(false);
                        }}
                        className={cn(
                          'w-full text-left px-2 py-1.5 rounded text-xs hover:bg-accent transition-colors',
                          e.isCurrent && 'bg-primary/10',
                        )}
                      >
                        <div className="font-medium truncate">{e.title || '(empty)'}</div>
                        <div className="text-[10px] text-muted-foreground font-mono truncate">{e.provider}/{e.model} · {e.tokenTotal.toLocaleString()} tok</div>
                      </button>
                    ))}
                  </div>
                )}
              </div>
            )}
            <button
              type="button"
              onClick={() => useUIStore.getState().setModelSwitcherOpen(true)}
              className="group hidden sm:flex items-center gap-1 px-2 py-0.5 rounded-md border bg-background/50 hover:bg-accent hover:border-primary/40 transition-colors text-[11px] min-w-0 shrink-0"
              title="Change provider / model (Ctrl+M)"
            >
              <Cpu className="h-3 w-3 text-muted-foreground group-hover:text-foreground shrink-0" />
              <span className="font-mono truncate max-w-[9rem] xl:max-w-[16rem]">
                <span className="text-muted-foreground">{provider || 'no-provider'}</span>
                <span className="text-muted-foreground/40 mx-0.5">/</span>
                <span className="font-medium">{model || 'no-model'}</span>
              </span>
            </button>
            {/* Mode pickers fold away below md — both remain reachable via
                the command palette and Settings. */}
            <div className="hidden md:flex items-center gap-1.5 shrink-0">
              <ModePicker />
              <ContextModePicker />
            </div>
            {iteration && (
              <button
                type="button"
                className="flex items-center gap-1 px-1.5 py-0.5 rounded-full text-[11px] font-medium bg-primary/10 text-primary shrink-0 hover:bg-primary/20 transition-colors cursor-pointer"
                title="Agent iteration — click to jump to live activity"
                onClick={() => document.getElementById('chat-activity')?.scrollIntoView({ behavior: 'smooth', block: 'center' })}
              >
                <Activity className="h-3 w-3 animate-pulse" />
                iter {iteration.index}
                {iteration.max > 0 ? `/${iteration.max}` : ''}
              </button>
            )}
            {/* Todos / fleet / goal / worktree live in the WorkspaceDock
                strip directly below this header — no duplicate chips here. */}
            <AutonomyPicker value={autonomy} onChange={handleAutonomyChange} compact />
          </div>

          {/* Only the session-scoped tools stay here — palette, theme, help
              and settings are global app controls and live in the
              ActivityBar's bottom group now. */}
          <div className="flex items-center gap-0.5 shrink-0">
            <Button
              variant={processOpen ? 'secondary' : 'ghost'}
              size="icon"
              className={cn('h-7 w-7 relative', processOpen && 'bg-amber-500/10 text-amber-600 dark:text-amber-400')}
              onClick={() => setProcessOpen((v) => !v)}
              title="Running processes"
            >
              <Terminal className="h-4 w-4" />
              {processOpen && (
                <span className="absolute -bottom-0.5 left-1/2 -translate-x-1/2 w-1 h-1 rounded-full bg-amber-500" />
              )}
            </Button>
            <Button
              variant={checkpointOpen ? 'secondary' : 'ghost'}
              size="icon"
              className={cn('h-7 w-7 relative', checkpointOpen && 'bg-violet-500/10 text-violet-600 dark:text-violet-400')}
              onClick={() => setCheckpointOpen((v) => !v)}
              title="Session checkpoints — rewind"
            >
              <History className="h-4 w-4" />
              {checkpointOpen && (
                <span className="absolute -bottom-0.5 left-1/2 -translate-x-1/2 w-1 h-1 rounded-full bg-violet-500" />
              )}
            </Button>
          </div>
        </div>

        {hasStatusContent && (
          <div className="flex items-center justify-between gap-3 px-3 py-1 border-t bg-muted/20 text-[11px] text-muted-foreground">
            <div className="flex items-center gap-3 min-w-0 flex-1 tabular-nums">
              {lastInputTokens > 0 && (
                <ContextFillBar
                  pct={ctxPct}
                  tokens={lastInputTokens}
                  maxTokens={maxContext > 0 ? maxContext : undefined}
                  onClick={() => setBreakdownOpen(true)}
                />
              )}
              {totalTokens.input > 0 && (
                <>
                  <span className="flex items-center gap-1">
                    <span className="font-medium text-foreground">{fmtTok(totalTokens.input)}</span>
                    <span>in</span>
                  </span>
                  <span className="flex items-center gap-1">
                    <span className="font-medium text-foreground">
                      {fmtTok(totalTokens.output)}
                    </span>
                    <span>out</span>
                  </span>
                  {totalTokens.cacheRead &&
                    totalTokens.cacheRead > 0 &&
                    (() => {
                      const denom = (totalTokens.cacheRead ?? 0) + totalTokens.input;
                      const pct =
                        denom > 0 ? Math.round(((totalTokens.cacheRead ?? 0) / denom) * 100) : 0;
                      return (
                        <span
                          className="flex items-center gap-1"
                          title={`Cache hit ratio: ${pct}%`}
                        >
                          <span className="font-medium text-foreground">
                            {fmtTok(totalTokens.cacheRead)}
                          </span>
                          <span>cache ({pct}%)</span>
                        </span>
                      );
                    })()}
                  <CostChip />
                </>
              )}
            </div>
            {startTime && (
              <span className="text-muted-foreground/70 tabular-nums shrink-0">
                {formatDuration(startTime)}
              </span>
            )}
          </div>
        )}
      </header>

      {/* Messages */}
      <div className="flex-1 relative overflow-hidden">
        <SearchOverlay />
        {!pinnedToBottom && (
          <button
            type="button"
            onClick={scrollToBottom}
            className={cn(
              'absolute bottom-4 left-1/2 -translate-x-1/2 z-10 jump-bottom',
              'flex items-center gap-2 px-4 py-2 rounded-full shadow-lg',
              'bg-primary text-primary-foreground text-xs font-medium',
              'hover:bg-primary/90 transition-colors animate-message',
            )}
          >
            <ArrowDown className="h-3.5 w-3.5" />
            {unreadCount > 0
              ? `${unreadCount} new message${unreadCount === 1 ? '' : 's'}`
              : 'Jump to latest'}
          </button>
        )}
        {scrolledDeep && (
          <button
            type="button"
            onClick={scrollToTop}
            title="Scroll to top (oldest)"
            className={cn(
              'absolute top-3 right-3 z-10',
              'flex items-center gap-1 px-2.5 py-1 rounded-full shadow-md border',
              'bg-background/90 backdrop-blur-sm text-[11px] text-muted-foreground',
              'hover:text-foreground hover:bg-background transition-colors animate-message',
            )}
          >
            <ArrowUp className="h-3 w-3" />
            <span>Top</span>
          </button>
        )}
        {rows.length === 0 && !isLoading ? (
          <div className="mx-auto max-w-5xl w-full px-4 pt-4">
            <WelcomeScreen />
          </div>
        ) : (
          <VList ref={vlistRef} className="h-full" onScroll={handleScroll}>
            {rows.map((row, i) => (
              <ChatRowView
                key={row.key}
                row={row}
                isLoading={isLoading}
                compactMode={compactMode}
                isFirstRow={i === 0}
              />
            ))}

            {/* Trailing live-activity item — always the last VList row so its
                frequent updates (thinking / running status) re-render only it. */}
            <div
              key="__live"
              id="chat-activity"
              className={cn('mx-auto max-w-5xl w-full px-4', compactMode ? 'pb-3' : 'pb-8')}
            >
              <ThinkingBubble />

              {/* Running status bubble */}
              {isLoading &&
                (() => {
                const last = messages[messages.length - 1];
                const runningTools = messages.filter(
                  (m) => m.role === 'tool' && m.toolResult === undefined,
                );
                let label = 'Thinking…';
                if (runningTools.length > 0) {
                  const names = Array.from(
                    new Set(runningTools.map((t) => t.toolName).filter(Boolean) as string[]),
                  );
                  const preview = names.slice(0, 2).join(', ');
                  const more = names.length > 2 ? ` +${names.length - 2}` : '';
                  label =
                    runningTools.length === 1
                      ? `Running ${preview || 'tool'}…`
                      : `Running ${runningTools.length} tools (${preview}${more})…`;
                } else if (last?.role === 'assistant' && last.content) {
                  label = 'Writing reply…';
                } else if (last?.role === 'tool' && last.toolResult !== undefined) {
                  label = 'Thinking about the next step…';
                }
                const elapsedSec = runStartedAt
                  ? Math.max(0, Math.floor((nowTick - runStartedAt) / 1000))
                  : 0;
                const elapsed =
                  elapsedSec < 60
                    ? `${elapsedSec}s`
                    : `${Math.floor(elapsedSec / 60)}m ${elapsedSec % 60}s`;
                let speedLabel = '';
                const streamingBubble =
                  last?.role === 'assistant' && last.streaming && last.content ? last : null;
                if (streamingBubble) {
                  const anchor = streamAnchor.current;
                  if (!anchor || anchor.id !== streamingBubble.id) {
                    streamAnchor.current = {
                      id: streamingBubble.id,
                      at: Date.now(),
                      len: streamingBubble.content.length,
                    };
                  } else {
                    const dt = Math.max(1, nowTick - anchor.at);
                    const dl = Math.max(0, streamingBubble.content.length - anchor.len);
                    if (dt > 500 && dl > 0) {
                      const cps = (dl * 1000) / dt;
                      speedLabel =
                        cps >= 1000
                          ? `${(cps / 1000).toFixed(1)}k ch/s`
                          : `${Math.round(cps)} ch/s`;
                    }
                  }
                } else if (streamAnchor.current) {
                  streamAnchor.current = null;
                }
                return (
                  <div className="flex gap-3 animate-message">
                    <div className="flex-shrink-0 w-8 h-8 rounded-full flex items-center justify-center bg-accent text-accent-foreground ring-2 ring-offset-2 ring-offset-background ring-accent/20">
                      <Bot className="h-4 w-4" />
                    </div>
                    <div className="flex flex-col gap-1.5">
                      <div className="rounded-2xl px-4 py-3 bg-card border text-foreground">
                        <div className="flex items-center gap-3 text-sm">
                          <span className="flex gap-1">
                            <span className="h-1.5 w-1.5 rounded-full bg-primary/70 animate-bounce [animation-delay:-0.3s]" />
                            <span className="h-1.5 w-1.5 rounded-full bg-primary/70 animate-bounce [animation-delay:-0.15s]" />
                            <span className="h-1.5 w-1.5 rounded-full bg-primary/70 animate-bounce" />
                          </span>
                          <span className="text-foreground/90">{label}</span>
                          <span className="text-xs text-muted-foreground tabular-nums">
                            {elapsed}
                          </span>
                          {iteration && (
                            <span className="text-xs text-muted-foreground tabular-nums">
                              · iter {iteration.index}
                              {iteration.max > 0 ? `/${iteration.max}` : ''}
                            </span>
                          )}
                          {speedLabel && (
                            <span className="text-xs text-muted-foreground/80 tabular-nums">
                              · {speedLabel}
                            </span>
                          )}
                        </div>
                      </div>
                    </div>
                  </div>
                );
              })()}
            </div>
          </VList>
        )}
      </div>

      {/* Input */}
      <div className="border-t bg-card/50 backdrop-blur supports-[backdrop-filter]:bg-card/50 shrink-0">
        {/* Keyboard shortcut hints — subtle, always visible */}
        <div className="max-w-5xl mx-auto px-4 pt-1.5 flex items-center gap-3 text-[10px] text-muted-foreground/50 select-none overflow-x-auto">
          <span title="Enter" className="inline-flex items-center gap-1">
            <kbd>Enter</kbd> send
          </span>
          <span className="opacity-50">·</span>
          <span title="Shift+Enter" className="inline-flex items-center gap-1">
            <kbd>Shift</kbd>+<kbd>↵</kbd> newline
          </span>
          <span className="opacity-50">·</span>
          <span title="Ctrl+\\" className="inline-flex items-center gap-1">
            <kbd>Ctrl+\</kbd> sidebar
          </span>
          <span className="opacity-50">·</span>
          <span title="Ctrl+F" className="inline-flex items-center gap-1">
            <kbd>Ctrl+F</kbd> search
          </span>
          <span className="opacity-50">·</span>
          <span title="Ctrl+K" className="inline-flex items-center gap-1">
            <kbd>Ctrl+K</kbd> palette
          </span>
          <span className="opacity-50">·</span>
          <span title="Ctrl+L / Ctrl+N" className="inline-flex items-center gap-1">
            <kbd>Ctrl+L</kbd> clear
          </span>
          <span className="opacity-50">·</span>
          <span title="j/k to navigate" className="inline-flex items-center gap-1">
            <kbd>j</kbd><kbd>k</kbd> navigate
          </span>
          <span className="opacity-50">·</span>
          <span title="Ctrl+M" className="inline-flex items-center gap-1">
            <kbd>Ctrl+M</kbd> model
          </span>
          <span className="opacity-50">·</span>
          <span title="Ctrl+Shift+D" className="inline-flex items-center gap-1">
            <kbd>Ctrl+⇧D</kbd> density
          </span>
        </div>
        <div className="p-4">
          <div className="max-w-5xl mx-auto">
            <ChatInput onOpenBreakdown={() => setBreakdownOpen(true)} />
          </div>
        </div>
      </div>

      {/* Overlays — triggered by header buttons */}
      <ProcessMonitor open={processOpen} onClose={() => setProcessOpen(false)} />
      <CheckpointTimeline open={checkpointOpen} onClose={() => setCheckpointOpen(false)} />
      <ContextBreakdownModal open={breakdownOpen} onClose={() => setBreakdownOpen(false)} />
    </div>
  );
}
