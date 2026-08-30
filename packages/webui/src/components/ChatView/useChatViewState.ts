import { type SetStateAction, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { VListHandle } from 'virtua';
import { useShallow } from 'zustand/react/shallow';
import { useAppTranslation } from '@/i18n';
import { getWSClient } from '@/lib/ws-client';
import {
  useActiveSessionId,
  useChatStore,
  useConfigStore,
  useHistoryStore,
  useSessionStore,
  useSessionTabStore,
  useUIStore,
} from '@/stores';
import { useLocalPrefs } from '@/stores/local-prefs';
import { useMemoryInjectorTraceStore } from '@/stores/memory-injector-store';
import { shouldAutoCollapse } from './auto-collapse.js';
import { buildChatRows } from './utils.js';

function nextBoolean(next: SetStateAction<boolean>, current: boolean): boolean {
  return typeof next === 'function' ? (next as (value: boolean) => boolean)(current) : next;
}

export function useChatViewState() {
  const { t } = useAppTranslation();
  const messages = useChatStore((s) => s.messages);
  const isLoading = useChatStore((s) => s.isLoading);
  const sidebarOpen = useUIStore((s) => s.sidebarOpen);
  const toggleSidebar = useUIStore((s) => s.toggleSidebar);
  const compactMode = useUIStore((s) => s.compactMode);

  const {
    totalTokens,
    startTime,
    lastInputTokens,
    maxContext,
    contextLimitWarning,
    cacheStats,
    iteration,
  } = useSessionStore(
    useShallow((s) => ({
      totalTokens: s.totalTokens,
      startTime: s.startTime,
      lastInputTokens: s.lastInputTokens,
      maxContext: s.maxContext,
      contextLimitWarning: s.contextLimitWarning,
      cacheStats: s.cacheStats,
      iteration: s.iteration,
    })),
  );
  const session = useSessionStore((s) => s.session);
  const sessionId = useActiveSessionId() ?? session?.id;
  const nickname = useUIStore((s) => (sessionId ? s.sessionNicknames[sessionId] : undefined));
  const setSessionNickname = useUIStore((s) => s.setSessionNickname);
  const sessionTitle = session?.title;
  const [renamingTitle, setRenamingTitle] = useState(false);
  const [titleDraft, setTitleDraft] = useState('');

  const historyEntries = useHistoryStore((s) => s.entries);
  const switcherOpen = useUIStore((s) => s.chatSwitcherOpen);
  const setChatSwitcherOpen = useUIStore((s) => s.setChatSwitcherOpen);
  const setSwitcherOpen = useCallback(
    (next: SetStateAction<boolean>) => {
      setChatSwitcherOpen(nextBoolean(next, useUIStore.getState().chatSwitcherOpen));
    },
    [setChatSwitcherOpen],
  );
  const switcherRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!switcherOpen) return;
    const onClick = (e: MouseEvent) => {
      if (!switcherRef.current?.contains(e.target as Node)) setSwitcherOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setSwitcherOpen(false);
    };
    document.addEventListener('mousedown', onClick);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onClick);
      document.removeEventListener('keydown', onKey);
    };
  }, [switcherOpen]);

  const { configProvider, configModel } = useConfigStore(
    useShallow((s) => ({ configProvider: s.provider, configModel: s.model })),
  );
  const provider = session?.provider || configProvider;
  const model = session?.model || configModel;
  const vlistRef = useRef<VListHandle>(null);

  const rows = useMemo(() => buildChatRows(messages), [messages]);
  const childCountRef = useRef(0);
  childCountRef.current = rows.length + 1;

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

  const autonomy = useLocalPrefs((s) => s.autonomy);
  const groupToolCallsPref = useLocalPrefs((s) => s.groupToolCalls);
  const autoCollapseInput = useLocalPrefs((s) => s.autoCollapseInput);

  const handleAutonomyChange = useCallback(
    (mode: 'off' | 'suggest' | 'auto' | 'eternal' | 'eternal-parallel') => {
      useLocalPrefs.getState().set({ autonomy: mode });
      try {
        const ws = getWSClient();
        // Autonomy is per-tab. An unstamped send applied the picker's choice to
        // whichever session the runtime last activated, not the tab on screen.
        if (typeof ws.switchAutonomy === 'function') {
          ws.switchAutonomy(mode);
          return;
        }
        ws.send?.({
          type: 'autonomy.switch',
          payload: ws.withSession?.({ mode }) ?? { mode },
        });
      } catch {
        // No socket yet — the next prefs.get on tab switch will resync.
      }
    },
    [],
  );

  const [processOpen, setProcessOpen] = useState(false);
  const checkpointOpen = useUIStore((s) => s.chatCheckpointOpen);
  const setChatCheckpointOpen = useUIStore((s) => s.setChatCheckpointOpen);
  const setCheckpointOpen = useCallback(
    (next: SetStateAction<boolean>) => {
      setChatCheckpointOpen(nextBoolean(next, useUIStore.getState().chatCheckpointOpen));
    },
    [setChatCheckpointOpen],
  );
  const memoryPanelOpen = useUIStore((s) => s.chatMemoryPanelOpen);
  const setChatMemoryPanelOpen = useUIStore((s) => s.setChatMemoryPanelOpen);
  const setMemoryPanelOpen = useCallback(
    (next: SetStateAction<boolean>) => {
      setChatMemoryPanelOpen(nextBoolean(next, useUIStore.getState().chatMemoryPanelOpen));
    },
    [setChatMemoryPanelOpen],
  );
  const inputCollapsed = useUIStore((s) => s.chatInputCollapsed);
  const setChatInputCollapsed = useUIStore((s) => s.setChatInputCollapsed);
  const setInputCollapsed = useCallback(
    (next: SetStateAction<boolean>) => {
      setChatInputCollapsed(nextBoolean(next, useUIStore.getState().chatInputCollapsed));
    },
    [setChatInputCollapsed],
  );
  const prevLoading = useRef(isLoading);
  const prevHadMessages = useRef(messages.length > 0);
  const prevSessionId = useRef(sessionId);
  const prevAutoCollapse = useRef(autoCollapseInput);

  const breakdownOpen = useUIStore((s) => s.chatContextBreakdownOpen);
  const setBreakdownOpen = useUIStore((s) => s.setChatContextBreakdownOpen);
  const toolStatsOpen = useUIStore((s) => s.chatToolStatsOpen);
  const setChatToolStatsOpen = useUIStore((s) => s.setChatToolStatsOpen);
  const setToolStatsOpen = useCallback(
    (next: SetStateAction<boolean>) => {
      setChatToolStatsOpen(nextBoolean(next, useUIStore.getState().chatToolStatsOpen));
    },
    [setChatToolStatsOpen],
  );
  const editorOpen = useUIStore((s) => s.chatContextEditorOpen);
  const setEditorOpen = useUIStore((s) => s.setChatContextEditorOpen);

  const activeMemoryCount = useMemoryInjectorTraceStore(
    (s) => Object.values(s.contextMemories).filter((m) => m.state !== 'exited').length,
  );

  useEffect(() => {
    const handler = () => setMemoryPanelOpen(true);
    window.addEventListener('open:memory-panel', handler);
    return () => window.removeEventListener('open:memory-panel', handler);
  }, []);

  useEffect(() => {
    const handler = () => setBreakdownOpen(true);
    document.addEventListener('open:context-breakdown', handler);
    return () => document.removeEventListener('open:context-breakdown', handler);
  }, []);

  useEffect(() => {
    const handler = () => setEditorOpen(true);
    document.addEventListener('open:context-editor', handler);
    return () => document.removeEventListener('open:context-editor', handler);
  }, []);

  useEffect(() => {
    const handler = () => setInputCollapsed(false);
    document.addEventListener('chat:session-end', handler);
    document.addEventListener('chat:next-step-countdown', handler);
    return () => {
      document.removeEventListener('chat:session-end', handler);
      document.removeEventListener('chat:next-step-countdown', handler);
    };
  }, []);

  useEffect(() => {
    if (prevLoading.current && !isLoading) {
      setInputCollapsed(false);
    }
    prevLoading.current = isLoading;
  }, [isLoading]);

  useEffect(() => {
    const hasMessages = messages.length > 0;
    const sessionChanged = sessionId != null && sessionId !== prevSessionId.current;
    if (
      !isLoading &&
      shouldAutoCollapse({
        hasMessages,
        autoCollapseInput,
        sessionChanged,
        prevHadMessages: prevHadMessages.current,
        prevAutoCollapse: prevAutoCollapse.current,
      })
    ) {
      setInputCollapsed(true);
    }
    prevSessionId.current = sessionId;
    prevHadMessages.current = hasMessages;
    prevAutoCollapse.current = autoCollapseInput;
  }, [messages.length, autoCollapseInput, sessionId, isLoading]);

  const handleToggleAutoCollapse = useCallback(() => {
    const next = !useLocalPrefs.getState().autoCollapseInput;
    useLocalPrefs.getState().set({ autoCollapseInput: next });
    if (!next) setInputCollapsed(false);
  }, []);

  const ctxPct =
    maxContext > 0 && lastInputTokens > 0
      ? Math.min(100, Math.round((lastInputTokens / maxContext) * 100))
      : 0;

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

  const handleHistorySelect = useCallback((targetSessionId: string) => {
    const ws = getWSClient();
    useSessionTabStore.getState().openTab(targetSessionId, {
      resumeSession: (id) => ws.resumeSession?.(id),
    });
    setSwitcherOpen(false);
  }, []);

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

  useEffect(() => {
    setPinnedToBottom(true);
    setUnreadCount(0);
    lastSeenCount.current = useChatStore.getState().messages.length;
    // Overlays are one global surface. Left standing they would operate on
    // the tab we just switched TO — compacting, killing processes, or
    // rewriting context that belongs to a different conversation.
    setProcessOpen(false);
    setRenamingTitle(false);
    requestAnimationFrame(() => {
      vlistRef.current?.scrollToIndex(childCountRef.current - 1, { align: 'end' });
    });
  }, [sessionId]);

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

  const [runStartedAt, setRunStartedAt] = useState<number | null>(null);
  const [nowTick, setNowTick] = useState<number>(() => Date.now());
  const streamAnchor = useRef<{ id: string; at: number; len: number } | null>(null);

  const lastMessage = messages[messages.length - 1];
  const streamingBubble =
    lastMessage?.role === 'assistant' && lastMessage.streaming && lastMessage.content
      ? lastMessage
      : null;

  // Anchor bookkeeping lives in an effect, not inside the runningStatus memo —
  // a useMemo must stay pure, and a render-phase ref write double-fires under
  // StrictMode.
  useEffect(() => {
    if (streamingBubble) {
      const anchor = streamAnchor.current;
      if (!anchor || anchor.id !== streamingBubble.id) {
        streamAnchor.current = {
          id: streamingBubble.id,
          at: Date.now(),
          len: streamingBubble.content.length,
        };
      }
    } else if (streamAnchor.current) {
      streamAnchor.current = null;
    }
  }, [streamingBubble]);

  const runningStatus = useMemo(() => {
    const last = messages[messages.length - 1];
    const runningTools = messages.filter((m) => m.role === 'tool' && m.toolResult === undefined);
    let label = t('activity:chatView.thinking');
    if (runningTools.length > 0) {
      const names = Array.from(
        new Set(runningTools.map((tool) => tool.toolName).filter(Boolean) as string[]),
      );
      const preview = names.slice(0, 2).join(', ');
      const more = names.length > 2 ? ` +${names.length - 2}` : '';
      label =
        runningTools.length === 1
          ? t('activity:chatView.runningTool', { tool: preview || t('activity:chatView.toolWord') })
          : t('activity:chatView.runningTools', {
              count: runningTools.length,
              preview: `${preview}${more}`,
            });
    } else if (last?.role === 'assistant' && last.content) {
      label = t('activity:chatView.writingReply');
    } else if (last?.role === 'tool' && last.toolResult !== undefined) {
      label = t('activity:chatView.thinkingNextStep');
    }
    const elapsedSec = runStartedAt ? Math.max(0, Math.floor((nowTick - runStartedAt) / 1000)) : 0;
    const elapsed =
      elapsedSec < 60 ? `${elapsedSec}s` : `${Math.floor(elapsedSec / 60)}m ${elapsedSec % 60}s`;
    let speedLabel = '';
    if (streamingBubble) {
      const anchor = streamAnchor.current;
      // Read-only: the anchor itself is maintained by the effect above.
      if (anchor && anchor.id === streamingBubble.id) {
        const dt = Math.max(1, nowTick - anchor.at);
        const dl = Math.max(0, streamingBubble.content.length - anchor.len);
        if (dt > 500 && dl > 0) {
          const cps = (dl * 1000) / dt;
          speedLabel = cps >= 1000 ? `${(cps / 1000).toFixed(1)}k ch/s` : `${Math.round(cps)} ch/s`;
        }
      }
    }
    return { label, elapsed, speedLabel };
  }, [messages, nowTick, runStartedAt, t, streamingBubble]);

  useEffect(() => {
    if (isLoading && runStartedAt === null) setRunStartedAt(Date.now());
    if (!isLoading && runStartedAt !== null) setRunStartedAt(null);
  }, [isLoading, runStartedAt]);

  useEffect(() => {
    if (!isLoading) return;
    const timer = setInterval(() => setNowTick(Date.now()), 500);
    return () => clearInterval(timer);
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

  return {
    messages,
    isLoading,
    sidebarOpen,
    toggleSidebar,
    compactMode,
    totalTokens,
    startTime,
    lastInputTokens,
    maxContext,
    contextLimitWarning,
    cacheStats,
    iteration,
    sessionId,
    nickname,
    sessionTitle,
    renamingTitle,
    setRenamingTitle,
    titleDraft,
    setTitleDraft,
    setSessionNickname,
    historyEntries,
    switcherOpen,
    setSwitcherOpen,
    switcherRef,
    handleHistorySelect,
    provider,
    model,
    vlistRef,
    rows,
    autonomy,
    groupToolCallsPref,
    autoCollapseInput,
    handleAutonomyChange,
    processOpen,
    setProcessOpen,
    checkpointOpen,
    setCheckpointOpen,
    memoryPanelOpen,
    setMemoryPanelOpen,
    inputCollapsed,
    setInputCollapsed,
    breakdownOpen,
    setBreakdownOpen,
    toolStatsOpen,
    setToolStatsOpen,
    editorOpen,
    setEditorOpen,
    activeMemoryCount,
    handleToggleAutoCollapse,
    ctxPct,
    pinnedToBottom,
    unreadCount,
    scrolledDeep,
    handleScroll,
    scrollToBottom,
    scrollToTop,
    runningStatus,
    formatDuration,
    agentState,
    stateTone,
    hasStatusContent,
  };
}
