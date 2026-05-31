import type { Usage } from '@wrongstack/core';
import type { ContentBlock } from '@wrongstack/core';
import { create } from 'zustand';
import { persist } from 'zustand/middleware';

/**
 * Strip immediately-repeated paragraphs/lines from an assistant reply.
 * MiniMax-M2.7 (and other smaller open models) sometimes emit the same
 * paragraph twice in one stream — we don't want that to land in the chat.
 * We only collapse *consecutive* duplicates so legitimate repetition
 * elsewhere in the message is preserved.
 */
function dedupeRepeatedBlocks(text: string): string {
  if (!text) return text;
  // Pass 1: paragraph-level (split on blank lines).
  const paraSplit = text.split(/\n{2,}/);
  const paras: string[] = [];
  for (const p of paraSplit) {
    if (paras.length > 0 && paras[paras.length - 1]!.trim() === p.trim()) continue;
    paras.push(p);
  }
  // Pass 2: line-level within each paragraph (handles models that emit the
  // same sentence twice without a blank line between).
  const cleaned = paras.map((p) => {
    const lines = p.split('\n');
    const out: string[] = [];
    for (const line of lines) {
      if (out.length > 0 && line.trim().length > 0 && out[out.length - 1]!.trim() === line.trim()) {
        continue;
      }
      out.push(line);
    }
    return out.join('\n');
  });
  return cleaned.join('\n\n');
}

// ============================================
// Types
// ============================================

export interface MessageContent {
  role: 'user' | 'assistant' | 'system' | 'tool';
  content: string | ContentBlock[];
}

export interface ToolExecution {
  id: string;
  name: string;
  input?: unknown;
  output?: string;
  durationMs?: number;
  ok: boolean;
  startedAt: number;
  completedAt?: number;
}

export interface ChatMessage {
  id: string;
  content: string;
  role: 'user' | 'assistant' | 'system' | 'tool';
  toolName?: string;
  toolInput?: unknown;
  toolResult?: string;
  /** Wall-clock ms reported by the backend in tool.executed; rendered next
   *  to the tool name so the user can spot slow tools at a glance. */
  toolDurationMs?: number;
  /** Backend's tool_use id (e.g. "toolu_..." from Anthropic). Used to map
   *  tool.executed events back to the right bubble when the model fires
   *  multiple tools in parallel — currentToolId alone only points at the
   *  most recent start and would leave earlier ones stuck on "Running...". */
  toolUseId?: string;
  isError?: boolean;
  timestamp: number;
  usage?: Usage;
  streaming?: boolean;
  parentId?: string;
  /** Live progress lines for an in-flight tool, populated from
   *  tool.progress WS events. Each line is shown in chronological order
   *  inside the tool bubble while it's still running, and cleared once the
   *  final tool.executed lands (toolResult takes over). Capped to the last
   *  ~30 lines so a chatty bash command can't grow this unbounded. */
  progressLines?: string[];
  /** End-of-run summary attached to the last assistant message of a turn
   *  after run.result lands. Populated by the run.result handler in
   *  useWebSocket — gives the user a single-line readout of what just
   *  happened (iterations, tool calls, elapsed time, cost). */
  runSummary?: {
    iterations: number;
    tools: number;
    durationMs: number;
    costDelta: number;
  };
}

export interface SessionInfo {
  id: string;
  startedAt: number;
  provider: string;
  model: string;
  title?: string;
}

// ============================================
// Chat Store
// ============================================

interface ChatState {
  messages: ChatMessage[];
  currentAssistantMessageId: string | null;
  currentToolId: string | null;
  isLoading: boolean;
  abortController: AbortController | null;
  executions: Map<string, ToolExecution>;
  /** Messages typed while the agent was running. Drained one-at-a-time
   *  after run.result lands so the user can stack up follow-ups without
   *  waiting for each turn to finish. */
  queue: string[];
  /** Snapshot taken at the start of the current run (first iteration.started
   *  after idle). Used by run.result to compute the per-turn summary —
   *  duration is now-at minus this `at`, cost delta is the difference
   *  between the session's current cost and the cost captured here. Null
   *  while idle. */
  runStart: { at: number; cost: number } | null;
  /** Transient extended-thinking buffer. Populated by provider.thinking_delta
   *  events and shown as a soft, ephemeral bubble below the chat tail while
   *  the model is reasoning. Cleared the moment the model produces user-
   *  facing output (text_delta) or starts a tool — and at provider.response /
   *  run.result. Never persisted into `messages`, so refresh wipes it. */
  thinkingBuffer: string;
  /** Wall-clock ms when the current thinking burst started, for the chip's
   *  elapsed timer. Reset alongside `thinkingBuffer`. */
  thinkingStartedAt: number | null;

  // Actions
  addMessage: (msg: Omit<ChatMessage, 'id' | 'timestamp'>) => string;
  updateMessage: (id: string, updates: Partial<ChatMessage>) => void;
  appendToMessage: (id: string, text: string) => void;
  /** Clean up an assistant bubble after its provider.response arrived:
   *  collapse model-emitted duplicate paragraphs / consecutive duplicate
   *  lines, flip the streaming flag off. Some models (notably MiniMax-M2.7)
   *  emit the same paragraph twice in one stream — this strips that noise
   *  at the bubble boundary so the persisted content matches what the user
   *  expects to see. */
  finalizeMessage: (id: string) => void;
  setToolResult: (id: string, result: string, ok: boolean) => void;
  /** Append a single progress line to the tool bubble identified by its
   *  ChatMessage id. Capped at 30 lines (oldest dropped) so chatty tools
   *  don't bloat memory or rerender too aggressively. */
  appendToolProgress: (id: string, line: string) => void;
  setLoading: (loading: boolean) => void;
  setAbortController: (ctrl: AbortController | null) => void;
  clearMessages: () => void;
  setCurrentAssistantMessage: (id: string | null) => void;
  setCurrentToolId: (id: string | null) => void;
  /** Remove the message identified by `id` and every message after it.
   *  Used by the "edit + regenerate" action on user bubbles — the user
   *  clicks the pencil, types a corrected prompt, and we want everything
   *  downstream of that point to disappear so the new send looks like a
   *  fresh branch from this question. */
  truncateAfter: (id: string) => void;
  addExecution: (exec: ToolExecution) => void;
  updateExecution: (id: string, updates: Partial<ToolExecution>) => void;
  enqueue: (text: string) => void;
  dequeue: () => string | null;
  removeQueued: (idx: number) => void;
  clearQueue: () => void;
  setRunStart: (s: { at: number; cost: number } | null) => void;
  /** Append a thinking chunk. Lazy-starts the elapsed timer on the first
   *  chunk after a clear. */
  appendThinking: (text: string) => void;
  /** Wipe the thinking buffer + timer. Called by the events that indicate
   *  the model has moved past reasoning (text/tool/response/run end). */
  clearThinking: () => void;
}

export const useChatStore = create<ChatState>()(
  persist(
    (set, get) => ({
      messages: [],
      currentAssistantMessageId: null,
      currentToolId: null,
      isLoading: false,
      abortController: null,
      executions: new Map(),
      queue: [],
      runStart: null,
      thinkingBuffer: '',
      thinkingStartedAt: null,

      addMessage: (msg) => {
        const id = `msg_${Date.now()}_${crypto.randomUUID().slice(0, 8)}`;
        const fullMsg: ChatMessage = { ...msg, id, timestamp: Date.now() };
        set((state) => ({
          messages: [...state.messages, fullMsg],
          currentAssistantMessageId:
            msg.role === 'assistant' ? id : state.currentAssistantMessageId,
        }));
        return id;
      },

      updateMessage: (id, updates) => {
        set((state) => ({
          messages: state.messages.map((m) => (m.id === id ? { ...m, ...updates } : m)),
        }));
      },

      appendToMessage: (id, text) => {
        set((state) => ({
          messages: state.messages.map((m) =>
            m.id === id ? { ...m, content: m.content + text } : m,
          ),
        }));
      },

      finalizeMessage: (id) => {
        set((state) => ({
          messages: state.messages.map((m) =>
            m.id === id ? { ...m, content: dedupeRepeatedBlocks(m.content), streaming: false } : m,
          ),
        }));
      },

      setToolResult: (id, result, ok) => {
        set((state) => ({
          messages: state.messages.map((m) =>
            m.id === id ? { ...m, toolResult: result, isError: !ok, progressLines: undefined } : m,
          ),
        }));
      },

      appendToolProgress: (id, line) => {
        set((state) => ({
          messages: state.messages.map((m) => {
            if (m.id !== id) return m;
            const prev = m.progressLines ?? [];
            const next = [...prev, line];
            // Bounded buffer: keep the most recent 30 lines.
            const trimmed = next.length > 30 ? next.slice(next.length - 30) : next;
            return { ...m, progressLines: trimmed };
          }),
        }));
      },

      setLoading: (loading) => set({ isLoading: loading }),
      setAbortController: (ctrl) => set({ abortController: ctrl }),

      clearMessages: () =>
        set({
          messages: [],
          currentAssistantMessageId: null,
          currentToolId: null,
          executions: new Map(),
        }),

      setCurrentAssistantMessage: (id) => set({ currentAssistantMessageId: id }),

      setCurrentToolId: (id) => set({ currentToolId: id }),

      truncateAfter: (id) =>
        set((state) => {
          const idx = state.messages.findIndex((m) => m.id === id);
          if (idx === -1) return state;
          return {
            messages: state.messages.slice(0, idx),
            currentAssistantMessageId: null,
            currentToolId: null,
          };
        }),

      addExecution: (exec) => {
        set((state) => {
          const newExecutions = new Map(state.executions);
          newExecutions.set(exec.id, exec);
          return { executions: newExecutions };
        });
      },

      updateExecution: (id, updates) => {
        set((state) => {
          const newExecutions = new Map(state.executions);
          const existing = newExecutions.get(id);
          if (existing) {
            newExecutions.set(id, { ...existing, ...updates });
          }
          return { executions: newExecutions };
        });
      },

      enqueue: (text) => set((state) => ({ queue: [...state.queue, text] })),
      dequeue: () => {
        const { queue } = get();
        if (queue.length === 0) return null;
        const [next, ...rest] = queue;
        set({ queue: rest });
        return next!;
      },
      removeQueued: (idx) => set((state) => ({ queue: state.queue.filter((_, i) => i !== idx) })),
      clearQueue: () => set({ queue: [] }),
      setRunStart: (s) => set({ runStart: s }),
      appendThinking: (text) =>
        set((state) => ({
          thinkingBuffer: state.thinkingBuffer + text,
          thinkingStartedAt: state.thinkingStartedAt ?? Date.now(),
        })),
      clearThinking: () => set({ thinkingBuffer: '', thinkingStartedAt: null }),
    }),
    {
      name: 'wrongstack-chat',
      // Intentionally persist nothing. Messages are bound to a backend session;
      // restoring them on reload would resurrect a stale conversation that the
      // backend no longer has context for (the next session.start clearMessages
      // anyway). Keep theme/wsUrl in useConfigStore, transcripts ephemeral.
      partialize: () => ({}),
    },
  ),
);

// ============================================
// Config Store
// ============================================

interface ConfigState {
  provider: string;
  model: string;
  baseUrl?: string;
  apiKey?: string;
  wsUrl: string;
  wsConnected: boolean;
  /** Fine-grained connection state from the WS client. Drives the topbar's
   *  reconnect indicator. */
  wsStatus:
    | { state: 'connecting' }
    | { state: 'open' }
    | { state: 'closed'; error?: string }
    | { state: 'reconnecting'; attempt: number; nextRetryAt: number; lastError?: string };
  theme: 'light' | 'dark' | 'system';
  autoConnect: boolean;
  /** Play a soft synthesized chime when run.result lands with status=done.
   *  Off by default — opt-in via the Command Palette. Persisted so the
   *  preference survives reloads. Actual playback only fires after the
   *  user has interacted with the page (Web Audio autoplay policy). */
  soundOnComplete: boolean;

  setProvider: (provider: string) => void;
  setModel: (model: string) => void;
  setConfig: (
    config: Partial<Omit<ConfigState, 'setProvider' | 'setModel' | 'setConfig' | 'setTheme'>>,
  ) => void;
  setTheme: (theme: 'light' | 'dark' | 'system') => void;
  setWsConnected: (connected: boolean) => void;
  setWsStatus: (s: ConfigState['wsStatus']) => void;
  setSoundOnComplete: (on: boolean) => void;
}

export const useConfigStore = create<ConfigState>()(
  persist(
    (set) => ({
      provider: 'anthropic',
      model: 'claude-sonnet-4-20250514',
      // Default WS URL tracks the page's hostname so loading from 127.0.0.1,
      // localhost, or a LAN IP all just work. For `localhost` we force the
      // literal IPv4 address — see ws-client.ts `defaultWsUrl()` for the
      // Windows IPv6/IPv4 resolution gotcha this avoids.
      wsUrl: (() => {
        if (typeof window === 'undefined' || !window.location?.hostname) {
          return 'ws://127.0.0.1:3457';
        }
        const h = window.location.hostname.toLowerCase();
        if (h === 'localhost' || h === '127.0.0.1' || h === '[::1]' || h === '::1') {
          return 'ws://127.0.0.1:3457';
        }
        return `ws://${window.location.hostname}:3457`;
      })(),
      wsConnected: false,
      wsStatus: { state: 'connecting' },
      theme: 'system',
      autoConnect: true,
      soundOnComplete: false,
      setProvider: (provider) => set({ provider }),
      setModel: (model) => set({ model }),
      setConfig: (config) => set(config),
      setTheme: (theme) => set({ theme }),
      setWsConnected: (connected) => set({ wsConnected: connected }),
      setWsStatus: (wsStatus) => set({ wsStatus, wsConnected: wsStatus.state === 'open' }),
      setSoundOnComplete: (on) => set({ soundOnComplete: on }),
    }),
    {
      name: 'wrongstack-config',
    },
  ),
);

// ============================================
// Session Store
// ============================================

interface SessionState {
  session: SessionInfo | null;
  totalTokens: Usage;
  /** Input tokens of the LAST provider response — used as the "live context
   *  size" indicator in the topbar (matches what TUI's ContextChip shows). */
  lastInputTokens: number;
  cost: number;
  startTime: number | null;
  /** Model max context window, from models.dev catalog. 0 = unknown. */
  maxContext: number;
  /** USD per 1M tokens — used to compute cost deltas on every provider.response. */
  inputCost: number;
  outputCost: number;
  cacheReadCost: number;
  /** basename(projectRoot) for the topbar. */
  projectName: string;
  /** Active mode id (default | code | …). */
  mode: string;
  /** All modes the backend knows about, populated by modes.list. The
   *  topbar mode chip uses this to render a picker; empty until the
   *  backend responds. */
  modes: Array<{ id: string; name: string; description: string }>;
  /** Active context-window policy id (balanced | frugal | deep | archival). */
  contextMode: string;
  /** Context-window policy presets from the backend. */
  contextModes: Array<{
    id: string;
    name: string;
    description: string;
    thresholds?: { warn: number; soft: number; hard: number };
    preserveK?: number;
    eliseThreshold?: number;
  }>;
  /** Iteration progress while the agent is running. Resets on run.result. */
  iteration: { index: number; max: number } | null;
  /** Live snapshot of context.todos — backend broadcasts on every
   *  tool.executed, and the sidebar/overlay reads from here. */
  todos: Array<{
    id: string;
    content: string;
    status: 'pending' | 'in_progress' | 'completed';
    activeForm?: string;
  }>;

  setSession: (session: SessionInfo | null) => void;
  updateUsage: (usage: Usage) => void;
  addCost: (cost: number) => void;
  startSession: (session: SessionInfo) => void;
  endSession: () => void;
  setEnv: (env: {
    maxContext?: number;
    projectName?: string;
    mode?: string;
    contextMode?: string;
    inputCost?: number;
    outputCost?: number;
    cacheReadCost?: number;
  }) => void;
  setIteration: (it: { index: number; max: number } | null) => void;
  setModes: (modes: Array<{ id: string; name: string; description: string }>) => void;
  setContextModes: (modes: SessionState['contextModes']) => void;
  setTodos: (todos: SessionState['todos']) => void;
}

export const useSessionStore = create<SessionState>()(
  persist(
    (set) => ({
      session: null,
      totalTokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      lastInputTokens: 0,
      cost: 0,
      startTime: null,
      maxContext: 0,
      inputCost: 0,
      outputCost: 0,
      cacheReadCost: 0,
      projectName: '',
      mode: 'default',
      modes: [],
      contextMode: 'balanced',
      contextModes: [],
      iteration: null,
      todos: [],

      setSession: (session) => set({ session }),

      updateUsage: (usage) =>
        set((state) => {
          // totalTokens tracks cumulative session totals for the cost panel.
          // These ARE intentionally additive across turns (session cost = sum).
          const inputDelta = usage.input + (usage.cacheRead ?? 0) + (usage.cacheWrite ?? 0);
          const cacheReadDelta = usage.cacheRead ?? 0;
          const cacheWriteDelta = usage.cacheWrite ?? 0;
          return {
            totalTokens: {
              input: state.totalTokens.input + usage.input,
              output: state.totalTokens.output + usage.output,
              cacheRead: (state.totalTokens.cacheRead ?? 0) + cacheReadDelta,
              cacheWrite: (state.totalTokens.cacheWrite ?? 0) + cacheWriteDelta,
            },
            // lastInputTokens = the single most-recent turn's effective input
            // (fresh + cached). This drives the ctx % chip in the topbar and
            // is NOT additive — it's the latest provider response's token count.
            // Use cacheWrite too because cache-write tokens were part of this
            // turn's context cost (written to build the cache for next turn).
            lastInputTokens: inputDelta || state.lastInputTokens,
          };
        }),

      addCost: (cost) => set((state) => ({ cost: state.cost + cost })),

      startSession: (session) =>
        // Full reset on every session boundary. Without this, /new and
        // /clear would keep the previous session's token totals + cost in
        // the status bar — confusing because the chat looks empty but the
        // header insists there were 50k tokens already used.
        set({
          session,
          startTime: Date.now(),
          iteration: null,
          lastInputTokens: 0,
          totalTokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
          cost: 0,
        }),

      endSession: () =>
        set({
          session: null,
          startTime: null,
          iteration: null,
        }),

      setEnv: (env) =>
        set((state) => ({
          maxContext: env.maxContext ?? state.maxContext,
          projectName: env.projectName ?? state.projectName,
          mode: env.mode ?? state.mode,
          contextMode: env.contextMode ?? state.contextMode,
          inputCost: env.inputCost ?? state.inputCost,
          outputCost: env.outputCost ?? state.outputCost,
          cacheReadCost: env.cacheReadCost ?? state.cacheReadCost,
        })),

      setIteration: (iteration) => set({ iteration }),
      setModes: (modes) => set({ modes }),
      setContextModes: (contextModes) => set({ contextModes }),
      setTodos: (todos) => set({ todos }),
    }),
    {
      name: 'wrongstack-session',
      partialize: () => ({}),
    },
  ),
);

// ============================================
// UI Store
// ============================================

interface UIState {
  sidebarOpen: boolean;
  settingsOpen: boolean;
  currentView: 'chat' | 'history' | 'settings';
  showConfirmDialog: boolean;
  confirmInfo: {
    id: string;
    toolName: string;
    input: unknown;
    suggestedPattern: string;
  } | null;
  /** ⌘K palette is mounted globally; this flag controls its visibility. */
  paletteOpen: boolean;
  /** "?" shortcuts overlay visibility. */
  shortcutsOpen: boolean;
  /** Ctrl+F chat-content search. */
  searchOpen: boolean;
  searchQuery: string;
  /** Rolling list of recently sent user prompts so ↑ in an empty input can
   *  recall them like a terminal. Capped to ~50 to keep storage bounded. */
  promptHistory: string[];
  /** Sidebar width in pixels. User can drag the right edge to resize.
   *  Clamped to [200, 480] in the drag handler. Persisted. */
  sidebarWidth: number;
  /** Assistant message ids the user pinned. Persisted across reloads so a
   *  user who pins a long debugging answer doesn't lose the bookmark on a
   *  refresh. Note: messages themselves aren't persisted, so a pin's only
   *  useful within the same in-memory session — the sidebar Pinned panel
   *  prunes ids that no longer correspond to a live message. */
  pinnedIds: string[];
  /** "Compact mode" — denser spacing throughout the chat. Off by default;
   *  power users with long sessions like the tighter layout. Toggle via
   *  Ctrl+Shift+D globally. */
  compactMode: boolean;
  /** Open state for the Quick Model Switcher overlay. Lives in the store
   *  so the topbar's model chip can open it imperatively without smuggling
   *  synthetic keyboard events through the DOM. Ctrl+M toggles this too. */
  modelSwitcherOpen: boolean;
  /** Session ids the user starred in the history list. Persisted across
   *  reloads. Starred sessions float to the top of the history sidebar
   *  regardless of date bucket so a long-running project session stays
   *  reachable without scrolling. */
  favoriteSessionIds: string[];
  /** Local UI nicknames for sessions, keyed by session id. The backend
   *  session.title is auto-derived from the first user message and isn't
   *  user-editable yet; this lets a user rename a session in the WebUI
   *  ("Auth refactor exploration") without a backend round-trip. Used by
   *  the History list, recent-sessions cards, and the tab title. */
  sessionNicknames: Record<string, string>;
  /** Right info panel (fleet, context, tokens) visibility. */
  rightPanelOpen: boolean;

  toggleSidebar: () => void;
  setSidebarOpen: (open: boolean) => void;
  setSettingsOpen: (open: boolean) => void;
  setCurrentView: (view: 'chat' | 'history' | 'settings') => void;
  showConfirm: (info: UIState['confirmInfo']) => void;
  hideConfirm: () => void;
  setPaletteOpen: (open: boolean) => void;
  setShortcutsOpen: (open: boolean) => void;
  setSearchOpen: (open: boolean) => void;
  setSearchQuery: (q: string) => void;
  pushPrompt: (text: string) => void;
  setSidebarWidth: (px: number) => void;
  togglePin: (id: string) => void;
  unpinAll: () => void;
  toggleCompactMode: () => void;
  setModelSwitcherOpen: (open: boolean) => void;
  toggleFavoriteSession: (id: string) => void;
  setSessionNickname: (id: string, nickname: string) => void;
}

export const useUIStore = create<UIState>()(
  persist(
    (set) => ({
      sidebarOpen: true,
      settingsOpen: false,
      currentView: 'chat',
      showConfirmDialog: false,
      confirmInfo: null,
      paletteOpen: false,
      shortcutsOpen: false,
      searchOpen: false,
      searchQuery: '',
      promptHistory: [],
      sidebarWidth: 288,
      pinnedIds: [],
      compactMode: false,
      modelSwitcherOpen: false,
      favoriteSessionIds: [],
      sessionNicknames: {},
      rightPanelOpen: false,

      toggleSidebar: () => set((state) => ({ sidebarOpen: !state.sidebarOpen })),
      setSidebarOpen: (open) => set({ sidebarOpen: open }),
      setSettingsOpen: (open) => set({ settingsOpen: open }),
      setCurrentView: (view) => set({ currentView: view }),
      showConfirm: (info) => set({ showConfirmDialog: true, confirmInfo: info }),
      hideConfirm: () => set({ showConfirmDialog: false, confirmInfo: null }),
      setPaletteOpen: (open) => set({ paletteOpen: open }),
      setShortcutsOpen: (open) => set({ shortcutsOpen: open }),
      setSearchOpen: (open) => set({ searchOpen: open, searchQuery: open ? '' : '' }),
      setSearchQuery: (q) => set({ searchQuery: q }),
      pushPrompt: (text) =>
        set((state) => {
          const trimmed = text.trim();
          if (!trimmed) return state;
          // Dedupe consecutive duplicates and cap the buffer.
          const filtered = state.promptHistory.filter((p) => p !== trimmed);
          return { promptHistory: [trimmed, ...filtered].slice(0, 50) };
        }),
      setSidebarWidth: (px) => set({ sidebarWidth: Math.max(200, Math.min(480, Math.round(px))) }),
      togglePin: (id) =>
        set((state) => {
          const has = state.pinnedIds.includes(id);
          return {
            pinnedIds: has ? state.pinnedIds.filter((p) => p !== id) : [...state.pinnedIds, id],
          };
        }),
      unpinAll: () => set({ pinnedIds: [] }),
      toggleCompactMode: () => set((s) => ({ compactMode: !s.compactMode })),
      setModelSwitcherOpen: (open) => set({ modelSwitcherOpen: open }),
      toggleFavoriteSession: (id) =>
        set((state) => {
          const has = state.favoriteSessionIds.includes(id);
          return {
            favoriteSessionIds: has
              ? state.favoriteSessionIds.filter((s) => s !== id)
              : [...state.favoriteSessionIds, id],
          };
        }),
      setSessionNickname: (id, nickname) =>
        set((state) => {
          const trimmed = nickname.trim();
          const next = { ...state.sessionNicknames };
          if (trimmed) next[id] = trimmed;
          else delete next[id];
          return { sessionNicknames: next };
        }),
      setRightPanelOpen: (open) => set({ rightPanelOpen: open }),
    }),
    {
      name: 'wrongstack-ui',
      // Persist only what's useful across reloads — sidebar state and the
      // prompt history. Modal flags (palette/shortcuts/search) reset on
      // load so the user doesn't reopen the app into an open dialog.
      partialize: (s) => ({
        sidebarOpen: s.sidebarOpen,
        sidebarWidth: s.sidebarWidth,
        promptHistory: s.promptHistory,
        pinnedIds: s.pinnedIds,
        compactMode: s.compactMode,
        favoriteSessionIds: s.favoriteSessionIds,
        sessionNicknames: s.sessionNicknames,
      }),
    },
  ),
);

// ============================================
// History Store
// ============================================

/** A row in the sidebar's History tab. Mirrors core's SessionSummary +
 *  isCurrent so the active session can be highlighted. Timestamps are
 *  ISO-8601 strings as stored on disk; the UI parses them lazily. */
export interface SessionHistoryEntry {
  id: string;
  title: string;
  startedAt: string;
  model: string;
  provider: string;
  tokenTotal: number;
  isCurrent: boolean;
}

interface HistoryState {
  entries: SessionHistoryEntry[];
  loading: boolean;
  error: string | null;
  setEntries: (entries: SessionHistoryEntry[], error?: string | null) => void;
  setLoading: (loading: boolean) => void;
  removeEntry: (id: string) => void;
  clearHistory: () => void;
}

export const useHistoryStore = create<HistoryState>()((set) => ({
  entries: [],
  loading: false,
  error: null,
  setEntries: (entries, error = null) => set({ entries, error, loading: false }),
  setLoading: (loading) => set({ loading }),
  removeEntry: (id) =>
    set((state) => ({
      entries: state.entries.filter((e) => e.id !== id),
    })),
  clearHistory: () => set({ entries: [] }),
}));

// ── Worktree store (live backend state; not persisted) ──────────────────────

import type { WorktreeHandleView } from '../types.js';

interface WorktreeActivity {
  handleId: string;
  kind: string;
  text: string;
  at: number;
}

interface WorktreeState {
  worktrees: WorktreeHandleView[];
  baseBranch: string;
  /** Bounded rolling activity feed for the flowing strip / ticker. */
  activity: WorktreeActivity[];
  setSnapshot: (worktrees: WorktreeHandleView[], baseBranch: string) => void;
  pushEvent: (e: WorktreeActivity) => void;
}

export const useWorktreeStore = create<WorktreeState>()((set) => ({
  worktrees: [],
  baseBranch: '',
  activity: [],
  setSnapshot: (worktrees, baseBranch) => set({ worktrees, baseBranch }),
  pushEvent: (e) => set((s) => ({ activity: [...s.activity, e].slice(-40) })),
}));
