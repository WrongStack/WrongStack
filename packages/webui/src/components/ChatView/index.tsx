import { useAppTranslation } from '@/i18n';
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
  Cpu,
  History,
  PanelLeftOpen,
  Pencil,
  Terminal,
  Zap,
} from 'lucide-react';
import { lazy, memo, useCallback, useEffect, useMemo, useRef, useState, Suspense } from 'react';
import { useShallow } from 'zustand/react/shallow';
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
import { SearchOverlay } from '../SearchOverlay';
import { ToolGroup } from '../ToolGroup';
import { WelcomeScreen } from '../WelcomeScreen';
import { Button } from '../ui/button';
import { type ChatRow, buildChatRows, fmtTok } from './utils.js';
import { ThinkingBubble } from './ThinkingBubble.js';

/**
 * Compact inline toggle switch used in the display-toggles bar. Renders a
 * small label + a minimal switch knob — no row layout, just a single line
 * that fits in the shortcut area.
 */
function ToggleSwitch({
  label,
  value,
  onChange,
}: {
  label: string;
  value: boolean;
  onChange: () => void;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={value}
      onClick={onChange}
      className="inline-flex items-center gap-1.5 text-[11px] text-muted-foreground/75 hover:text-foreground/80 transition-colors select-none"
    >
      <span
        className={cn(
          'relative inline-block h-3.5 w-6 rounded-full border transition-colors shrink-0',
          value ? 'bg-primary border-primary/60' : 'bg-muted/70 border-border/60',
        )}
      >
        <span
          className={cn(
            'absolute top-[1px] left-[1px] h-2.5 w-2.5 rounded-full bg-background shadow transition-transform',
            value && 'translate-x-2.5',
          )}
        />
      </span>
      <span>{label}</span>
    </button>
  );
}

// Lazy: ProcessMonitor pulls xterm + node-pty types and is only opened via the
// header "processes" button. Keeping it out of the eager chat bundle.
const ProcessMonitor = lazy(() =>
  import('../ProcessMonitor').then((m) => ({ default: m.ProcessMonitor })),
);

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
  groupToolCalls,
}: {
  row: ChatRow;
  isLoading: boolean;
  compactMode: boolean;
  isFirstRow: boolean;
  groupToolCalls: boolean;
}) {
  const wrap = cn(
    'mx-auto max-w-6xl w-full px-3 sm:px-5 lg:px-6',
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
        {row.items.flatMap((it) => {
          if (it.kind === 'msg') {
            return [(
              <MessageBubble
                key={it.key}
                message={it.message}
                isFirst={it.isFirst}
                isContinuation={it.isContinuation}
              />
            )];
          }
          if (groupToolCalls) {
            const defaultOpen = row.isLastTurn && it.isLastGroup && isLoading && it.hasRunningTool;
            return [(
              <ToolGroup
                key={it.key}
                tools={it.tools}
                defaultOpen={defaultOpen}
                isContinuation={it.isContinuation}
              />
            )];
          }
          // Grouping off — render each tool as its own message bubble
          return it.tools.map((tool) => (
            <MessageBubble
              key={tool.id}
              message={tool}
              isFirst={false}
              isContinuation={it.isContinuation}
            />
          ));
        })}
      </div>
    </div>
  );
});

export function ChatView() {
  // Narrow selectors — subscribing to the whole store re-rendered ChatView on
  // every stream delta (thinking / tool progress) even when the message list
  // was untouched.
  const { t } = useAppTranslation();
  const messages = useChatStore((s) => s.messages);
  const isLoading = useChatStore((s) => s.isLoading);
  const sidebarOpen = useUIStore((s) => s.sidebarOpen);
  const toggleSidebar = useUIStore((s) => s.toggleSidebar);
  const compactMode = useUIStore((s) => s.compactMode);
  // Narrow selectors via useShallow — the bare `useSessionStore()` form used
  // here re-rendered ChatView on every unrelated session-store write (todos,
  // modes, env, …). The shallow slice only changes when one of these five
  // fields actually flips.
  const { totalTokens, startTime, lastInputTokens, maxContext, iteration } = useSessionStore(
    useShallow((s) => ({
      totalTokens: s.totalTokens,
      startTime: s.startTime,
      lastInputTokens: s.lastInputTokens,
      maxContext: s.maxContext,
      iteration: s.iteration,
    })),
  );
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

  const { provider, model } = useConfigStore(
    useShallow((s) => ({ provider: s.provider, model: s.model })),
  );
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
  const showThinkingLogs = useLocalPrefs((s) => s.showThinkingLogs);
  const groupToolCallsPref = useLocalPrefs((s) => s.groupToolCalls);

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

  // Context window usage: cap display at 100%; raw token counts still show overflow.
  const ctxPct =
    maxContext > 0 && lastInputTokens > 0
      ? Math.min(100, Math.round((lastInputTokens / maxContext) * 100))
      : 0;
  const _ctxTone =
    ctxPct >= 85
      ? 'bg-destructive/12 text-destructive'
      : ctxPct >= 70
        ? 'bg-warning/12 text-warning'
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

  const handleHistorySelect = useCallback(
    (sessionId: string) => {
      const ws = getWSClient();
      ws?.resumeSession?.(sessionId);
      setSwitcherOpen(false);
    },
    [],
  );

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

  // Memoize the running status bubble content to avoid recomputing on every render.
  // Must be after streamAnchor declaration (ref is accessed inside).
  const runningStatus = useMemo(() => {
    const last = messages[messages.length - 1];
    const runningTools = messages.filter((m) => m.role === 'tool' && m.toolResult === undefined);
    let label = 'Thinking…';
    if (runningTools.length > 0) {
      const names = Array.from(new Set(runningTools.map((t) => t.toolName).filter(Boolean) as string[]));
      const preview = names.slice(0, 2).join(', ');
      const more = names.length > 2 ? ` +${names.length - 2}` : '';
      label = runningTools.length === 1 ? `Running ${preview || 'tool'}…` : `Running ${runningTools.length} tools (${preview}${more})…`;
    } else if (last?.role === 'assistant' && last.content) {
      label = 'Writing reply…';
    } else if (last?.role === 'tool' && last.toolResult !== undefined) {
      label = 'Thinking about the next step…';
    }
    const elapsedSec = runStartedAt ? Math.max(0, Math.floor((nowTick - runStartedAt) / 1000)) : 0;
    const elapsed = elapsedSec < 60 ? `${elapsedSec}s` : `${Math.floor(elapsedSec / 60)}m ${elapsedSec % 60}s`;
    let speedLabel = '';
    const streamingBubble = last?.role === 'assistant' && last.streaming && last.content ? last : null;
    if (streamingBubble) {
      const anchor = streamAnchor.current;
      if (!anchor || anchor.id !== streamingBubble.id) {
        streamAnchor.current = { id: streamingBubble.id, at: Date.now(), len: streamingBubble.content.length };
      } else {
        const dt = Math.max(1, nowTick - anchor.at);
        const dl = Math.max(0, streamingBubble.content.length - anchor.len);
        if (dt > 500 && dl > 0) {
          const cps = (dl * 1000) / dt;
          speedLabel = cps >= 1000 ? `${(cps / 1000).toFixed(1)}k ch/s` : `${Math.round(cps)} ch/s`;
        }
      }
    } else if (streamAnchor.current) {
      streamAnchor.current = null;
    }
    return { label, elapsed, speedLabel };
  }, [messages, nowTick, runStartedAt]);

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
        ? 'bg-primary/10 text-primary'
        : 'bg-warning/10 text-warning';

  const hasStatusContent =
    (maxContext > 0 && lastInputTokens > 0) || totalTokens.input > 0 || !!startTime;

  return (
    <div className="flex flex-col flex-1 min-h-0 bg-[hsl(var(--surface-2)/0.45)]">
      {/* Header */}
      <header className="flex flex-col border-b border-border/70 bg-card/90 backdrop-blur-xl supports-[backdrop-filter]:bg-card/80 shrink-0 sticky top-0 z-20 shadow-sm">
        <div className="flex flex-wrap items-center gap-2 px-3 py-2 sm:px-4">
          {/* Static text chips live in the overflow-hidden group so long
              session titles clip cleanly on narrow viewports. The
              dropdown-bearing chips (model picker, mode/ctx pickers,
              autonomy picker, session switcher) sit in their own sibling
              below — overflow-hidden would otherwise chop their
              `position: absolute` dropdown panels off at the row edge
              and the user sees no menu open. */}
          <div className="flex min-w-0 flex-[1_1_18rem] items-center gap-1.5 overflow-hidden">
            {!sidebarOpen && (
              <Button
                variant="ghost"
                size="icon"
                className="h-7 w-7 shrink-0"
                onClick={toggleSidebar}
                title={t('chat:header.openSidebarTitle')}
              >
                <PanelLeftOpen className="h-4 w-4" />
              </Button>
            )}
            {!sidebarOpen && (
              <div className="flex items-center gap-1.5 shrink-0 mr-1">
                <div className="w-5 h-5 rounded-md bg-primary flex items-center justify-center">
                  <Zap className="h-3 w-3 text-primary-foreground" />
                </div>
              </div>
            )}
            {/* Connection / project / cwd moved out of this header — the
                ActivityBar dot + ConnectionBanner own connection state and
                the Session panel owns project/cwd. Keeps this row narrow. */}
            <span
              className={cn(
                'flex items-center gap-1 px-1.5 py-0.5 rounded-md text-[11px] font-medium shrink-0 tabular-nums',
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
                  placeholder={t('chat:sessionNamePlaceholder')}
                  className="h-6 px-1.5 text-[11px] bg-background border border-primary/40 rounded-md focus:outline-none focus:ring-1 focus:ring-ring shrink-0 w-36"
                />
              ) : (
                <button
                  type="button"
                  onClick={() => { setTitleDraft(nickname || sessionTitle || ''); setRenamingTitle(true); }}
                  className="flex items-center gap-1 text-[11px] font-medium text-foreground/80 hover:text-foreground truncate max-w-[12rem] shrink-0 px-1 -mx-1 rounded-md hover:bg-muted/50 transition-colors"
                  title={t('chat:header.renameTitle')}
                >
                  <Pencil className="h-2.5 w-2.5 text-muted-foreground shrink-0" />
                  <span className="truncate">{nickname || sessionTitle || t('chat:header.untitled')}</span>
                </button>
              )
            )}
          </div>
          {/* Interactive chips (model picker, mode/ctx, autonomy, session
              switcher, iter). No overflow-hidden so their absolutely
              positioned dropdowns can extend below the row. shrink-0 so
              they stay full-size when the header is narrow. */}
          <div className="flex min-w-0 flex-[0_1_auto] flex-wrap items-center justify-end gap-1.5">
            {/* Session switcher — quick dropdown to jump between recent sessions */}
            {historyEntries.length > 1 && (
              <div ref={switcherRef} className="relative shrink-0">
                <button
                  type="button"
                  onClick={() => setSwitcherOpen((v) => !v)}
                  className="flex items-center gap-0.5 px-1 py-0.5 rounded-md text-[10px] text-muted-foreground hover:text-foreground hover:bg-muted/50 transition-colors"
                  title={t('chat:switchSession')}
                >
                  <History className="h-3 w-3" />
                  <ChevronDown className="h-2.5 w-2.5" />
                </button>
                {switcherOpen && (
                  <div className="absolute left-0 top-full mt-1 z-40 w-64 rounded-md border border-border/70 bg-popover shadow-xl p-1 max-h-60 overflow-y-auto">
                    {historyEntries.slice(0, 15).map((e) => (
                      <button
                        key={e.id}
                        type="button"
                        onClick={() => handleHistorySelect(e.id)}
                        className={cn(
                          'w-full text-left px-2 py-1.5 rounded text-xs hover:bg-accent transition-colors',
                          e.isCurrent && 'bg-primary/10',
                        )}
                      >
                        <div className="font-medium truncate">{e.title || t('chat:empty')}</div>
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
              className="group hidden sm:flex items-center gap-1 px-2 py-0.5 rounded-md border border-border/70 bg-background/60 hover:bg-accent/70 hover:border-primary/40 transition-colors text-[11px] min-w-0 shrink-0"
              title={t('chat:header.changeModelTitle')}
            >
              <Cpu className="h-3 w-3 text-muted-foreground group-hover:text-foreground shrink-0" />
              <span className="font-mono truncate max-w-[9rem] xl:max-w-[16rem]">
                <span className="text-muted-foreground">{provider || t('chat:header.noProvider')}</span>
                <span className="text-muted-foreground/65 mx-0.5">/</span>
                <span className="font-medium">{model || t('chat:header.noModel')}</span>
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
                className="flex items-center gap-1 px-1.5 py-0.5 rounded-md text-[11px] font-medium bg-primary/10 text-primary shrink-0 hover:bg-primary/20 transition-colors cursor-pointer"
                title={t('chat:header.iterationTitle')}
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
          <div className="ml-auto flex items-center gap-0.5 shrink-0">
            <Button
              variant={processOpen ? 'secondary' : 'ghost'}
              size="icon"
              className={cn('h-7 w-7 relative', processOpen && 'bg-warning/10 text-warning')}
              onClick={() => setProcessOpen((v) => !v)}
              title={t('chat:header.runningProcessesTitle')}
            >
              <Terminal className="h-4 w-4" />
              {processOpen && (
                <span className="absolute -bottom-0.5 left-1/2 -translate-x-1/2 w-1 h-1 rounded-full bg-warning" />
              )}
            </Button>
            <Button
              variant={checkpointOpen ? 'secondary' : 'ghost'}
              size="icon"
              className={cn('h-7 w-7 relative', checkpointOpen && 'bg-primary/10 text-primary')}
              onClick={() => setCheckpointOpen((v) => !v)}
              title={t('chat:header.checkpointsTitle')}
            >
              <History className="h-4 w-4" />
              {checkpointOpen && (
                <span className="absolute -bottom-0.5 left-1/2 -translate-x-1/2 w-1 h-1 rounded-full bg-primary" />
              )}
            </Button>
          </div>
        </div>

        {hasStatusContent && (
          <div className="flex items-center justify-between gap-3 overflow-x-auto border-t border-border/60 bg-muted/20 px-3 py-1 text-[11px] text-muted-foreground sm:px-4">
            <div className="flex min-w-max items-center gap-3 tabular-nums">
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
      <div className="relative mx-2 mt-2 min-h-0 min-w-0 flex-1 overflow-hidden rounded-xl border border-border/70 bg-card/55 shadow-sm sm:mx-3 lg:mx-4 lg:mt-3">
        <SearchOverlay />
        {!pinnedToBottom && (
          <button
            type="button"
            onClick={scrollToBottom}
            className={cn(
              'absolute bottom-4 left-1/2 -translate-x-1/2 z-10 jump-bottom',
              'flex items-center gap-2 px-4 py-2 rounded-md shadow-lg',
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
            title={t('chat:header.scrollTopTitle')}
            className={cn(
              'absolute top-3 right-3 z-10',
              'flex items-center gap-1 px-2.5 py-1 rounded-md shadow-md border',
              'bg-background/90 backdrop-blur-sm text-[11px] text-muted-foreground',
              'hover:text-foreground hover:bg-background transition-colors animate-message',
            )}
          >
            <ArrowUp className="h-3 w-3" />
            <span>Top</span>
          </button>
        )}
        {rows.length === 0 && !isLoading ? (
          <div className="h-full overflow-y-auto overscroll-contain">
            <div className="mx-auto max-w-6xl w-full px-3 sm:px-5 lg:px-6 pt-4 pb-8">
              <WelcomeScreen />
            </div>
          </div>
        ) : (
          <VList
            ref={vlistRef}
            className="h-full"
            onScroll={handleScroll}
            role="log"
            aria-label="Chat transcript"
            aria-live="polite"
          >
            {rows.map((row, i) => (
              <ChatRowView
                key={row.key}
                row={row}
                isLoading={isLoading}
                compactMode={compactMode}
                isFirstRow={i === 0}
                groupToolCalls={groupToolCallsPref}
              />
            ))}

            {/* Trailing live-activity item — always the last VList row so its
                frequent updates (thinking / running status) re-render only it. */}
            <div
              key="__live"
              id="chat-activity"
              className={cn('mx-auto max-w-6xl w-full px-3 sm:px-5 lg:px-6', compactMode ? 'pb-3' : 'pb-8')}
            >
              <ThinkingBubble />

              {/* Running status bubble */}
              {isLoading && (
                  <div className="flex gap-3 animate-message">
                    <div className="flex-shrink-0 w-8 h-8 rounded-full flex items-center justify-center bg-accent text-accent-foreground ring-2 ring-offset-2 ring-offset-background ring-accent/20">
                      <Bot className="h-4 w-4" />
                    </div>
                    <div className="flex flex-col gap-1.5">
                      <div className="rounded-lg px-4 py-3 bg-card border border-border/70 text-foreground shadow-sm">
                        <div className="flex items-center gap-3 text-sm">
                          <span className="flex gap-1">
                            <span className="h-1.5 w-1.5 rounded-full bg-primary/70 animate-bounce [animation-delay:-0.3s]" />
                            <span className="h-1.5 w-1.5 rounded-full bg-primary/70 animate-bounce [animation-delay:-0.15s]" />
                            <span className="h-1.5 w-1.5 rounded-full bg-primary/70 animate-bounce" />
                          </span>
                          <span className="text-foreground/90">{runningStatus.label}</span>
                          <span className="text-xs text-muted-foreground tabular-nums">
                            {runningStatus.elapsed}
                          </span>
                          {iteration && (
                            <span className="text-xs text-muted-foreground tabular-nums">
                              · iter {iteration.index}
                              {iteration.max > 0 ? `/${iteration.max}` : ''}
                            </span>
                          )}
                          {runningStatus.speedLabel && (
                            <span className="text-xs text-muted-foreground/80 tabular-nums">
                              · {runningStatus.speedLabel}
                            </span>
                          )}
                        </div>
                      </div>
                    </div>
                  </div>
              )}
            </div>
          </VList>
        )}
      </div>

      {/* Input */}
      <div className="shrink-0 bg-[hsl(var(--surface-2)/0.45)] px-2 pb-2 pt-2 sm:px-3 lg:px-4 lg:pb-3">
        {/* Display toggles — replaces the old keyboard-shortcut hints row,
            giving the user quick control over thinking-log visibility and
            tool-call grouping without diving into Settings. */}
        <div className="ws-display-toggles hidden max-w-6xl mx-auto px-2 pb-1.5 sm:flex items-center gap-4 text-[11px] text-muted-foreground/75 select-none overflow-x-auto">
          {/* Show Model Reasoning toggle */}
          <ToggleSwitch
            label="🧠 Model Reasoning"
            value={showThinkingLogs}
            onChange={() => {
              useLocalPrefs.getState().set({ showThinkingLogs: !useLocalPrefs.getState().showThinkingLogs });
            }}
          />
          <span className="opacity-40">|</span>
          {/* Group Tools toggle */}
          <ToggleSwitch
            label="🔧 Group Tools"
            value={groupToolCallsPref}
            onChange={() => {
              useLocalPrefs.getState().set({ groupToolCalls: !useLocalPrefs.getState().groupToolCalls });
            }}
          />
          <span className="opacity-30 ml-auto text-[10px]">press <kbd className="font-mono text-[10px] border rounded px-1 py-0.5 bg-muted/40">?</kbd> for shortcuts</span>
        </div>
        <div className="ws-chat-input-wrap p-0">
          <div className="max-w-6xl mx-auto">
            <ChatInput onOpenBreakdown={() => setBreakdownOpen(true)} />
          </div>
        </div>
      </div>

      {/* Overlays — triggered by header buttons */}
      <Suspense fallback={null}>
        <ProcessMonitor open={processOpen} onClose={() => setProcessOpen(false)} />
      </Suspense>
      <CheckpointTimeline open={checkpointOpen} onClose={() => setCheckpointOpen(false)} />
      <ContextBreakdownModal open={breakdownOpen} onClose={() => setBreakdownOpen(false)} />
    </div>
  );
}
