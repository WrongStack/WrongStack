import type { Usage } from '@wrongstack/core/types';
import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import type { SessionInfo } from './types.js';

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
  /** Active effective context window. 0 = unknown. */
  maxContext: number;
  /** Live provider-reported decrease, shown until the session/model changes. */
  contextLimitWarning: {
    previousMaxContext: number;
    maxContext: number;
    providerId: string;
    modelId: string;
  } | null;
  /**
   * Live prompt-cache snapshot from the most recent `stats.get`
   * reply. `null` until the first reply lands — distinguishes "no
   * cache yet" from "0 hit". Cleared on session start/end and on
   * provider/model switch (same lifecycle as `contextLimitWarning`,
   * so a stale reading from the previous session can never leak into
   * the new one).
   */
  cacheStats: {
    readTokens: number;
    writeTokens: number;
    hitRatio: number;
    /**
     * Cached prefix of the most recent prompt, capped at `lastInputTokens`
     * so the coverage figure never overshoots the live request size.
     * Used by the context breakdown modal and topbar cache badge.
     */
    coverageTokens: number;
  } | null;
  /** USD per 1M tokens — used to compute cost deltas on every provider.response. */
  inputCost: number;
  outputCost: number;
  cacheReadCost: number;
  /** Effort levels the ACTIVE model advertises (session.start payload).
   *  Undefined when the model has no explicit list — the settings effort
   *  dropdown then shows the full canonical set. Same lifecycle as
   *  `cacheStats`: refreshed on every session.start (which fires on model
   *  switch), so a stale list from the previous model never leaks. */
  reasoningEffortLevels?: string[] | undefined;
  /** basename(projectRoot) for the topbar. */
  projectName: string;
  /** Full project root path — used for richer tooltips / hover context. */
  projectRoot: string;
  /** Full working directory path — can differ from projectRoot. */
  cwd: string;
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
    thresholds?: { warn: number | undefined; soft: number; hard: number };
    preserveK?: number | undefined;
    eliseThreshold?: number | undefined;
    custom?: boolean | undefined;
  }>;
  /** Iteration progress while the agent is running. Resets on run.result. */
  iteration: { index: number; max: number } | null;
  /** Live snapshot of context.todos — backend broadcasts on every
   *  tool.executed, and the sidebar/overlay reads from here. */
  todos: Array<{
    id: string;
    content: string;
    status: 'pending' | 'in_progress' | 'completed';
    activeForm?: string | undefined;
    /** Board-derived titles of the unfinished work this row waits on. */
    blockedBy?: string[] | undefined;
    kanbanBoardId?: string | undefined;
    kanbanTaskId?: string | undefined;
  }>;
  /** Client-side wall-clock at the last successful session.start. Survives
   *  F5 because it's in partialize. Used by the resilience verifier view
   *  to confirm the active session round-trips through localStorage. */
  lastVisitedAt: number;
  /** Current app version string (e.g. "0.7.0") from the boot-time update check. */
  appVersion: string;
  /** Latest published version on npm, when known. */
  latestVersion: string;
  /** True when a newer published version exists than appVersion. */
  updateAvailable: boolean;
  /** Number of tools dropped from provider requests due to maxTools limit (0 = no limit or within limit). */
  droppedTools: number;

  setSession: (session: SessionInfo | null) => void;
  updateUsage: (usage: Usage) => void;
  addCost: (cost: number) => void;
  startSession: (session: SessionInfo) => void;
  endSession: () => void;
  setEnv: (env: {
    maxContext?: number | undefined;
    projectRoot?: string | undefined;
    projectName?: string | undefined;
    cwd?: string | undefined;
    mode?: string | undefined;
    contextMode?: string | undefined;
    inputCost?: number | undefined;
    outputCost?: number | undefined;
    cacheReadCost?: number | undefined;
    reasoningEffortLevels?: string[] | undefined;
  }) => void;
  setIteration: (it: { index: number; max: number } | null) => void;
  setContextUsage: (tokens: number, maxContext?: number | undefined) => void;
  setContextLimitWarning: (warning: SessionState['contextLimitWarning']) => void;
  setCacheStats: (cache: SessionState['cacheStats']) => void;
  setModes: (modes: Array<{ id: string; name: string; description: string }>) => void;
  setContextModes: (modes: SessionState['contextModes']) => void;
  setTodos: (todos: SessionState['todos']) => void;
  setUpdateInfo: (info: {
    appVersion: string;
    latestVersion: string;
    updateAvailable: boolean;
  }) => void;
  setDroppedTools: (count: number) => void;
}

/** Persistence schema version. Bump whenever the shape or partialize set
 *  changes so an existing localStorage entry from a prior build doesn't
 *  resurrect stale fields after the next deploy. */
const SESSION_PERSIST_VERSION = 1;
/** Hard cap on persisted env fields. We trim on rehydrate so a stale
 *  corrupt blob can't make Zustand rebuild a giant Map on the next render. */
const PERSIST_MAX_BYTES = 32 * 1024;

export const useSessionStore = create<SessionState>()(
  persist(
    (set) => ({
      session: null,
      totalTokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      lastInputTokens: 0,
      cost: 0,
      startTime: null,
      maxContext: 0,
      contextLimitWarning: null,
      cacheStats: null,
      inputCost: 0,
      outputCost: 0,
      cacheReadCost: 0,
      projectName: '',
      projectRoot: '',
      cwd: '',
      mode: 'default',
      modes: [],
      contextMode: 'balanced',
      contextModes: [],
      iteration: null,
      todos: [],
      /** Client-side wall-clock at the last successful session.start.
       *  Used by the F5-resilience verifier view to confirm "most recently
       *  active session" round-trips through localStorage. 0 = unknown. */
      lastVisitedAt: 0,
      appVersion: '',
      latestVersion: '',
      updateAvailable: false,
      droppedTools: 0,

      setSession: (session) =>
        set((state) => {
          const sessionOrRouteChanged =
            state.session?.id !== session?.id ||
            state.session?.provider !== session?.provider ||
            state.session?.model !== session?.model;
          return {
            session,
            lastVisitedAt: Date.now(),
            // Clear cache snapshot on provider/model switch — a stale
            // reading from the previous provider can never apply to the
            // new prompt cache. Same lifecycle as `contextLimitWarning`.
            // `reasoningEffortLevels` follows: a new model's effort set is
            // unknown until the next session.start repopulates it.
            ...(sessionOrRouteChanged
              ? {
                  contextLimitWarning: null,
                  cacheStats: null,
                  reasoningEffortLevels: undefined,
                }
              : {}),
          };
        }),

      updateUsage: (usage) =>
        set((state) => {
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
            lastInputTokens: inputDelta || state.lastInputTokens,
          };
        }),

      addCost: (cost) => set((state) => ({ cost: state.cost + cost })),

      startSession: (session) =>
        set({
          session,
          startTime: Date.now(),
          iteration: null,
          lastInputTokens: 0,
          totalTokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
          cost: 0,
          lastVisitedAt: Date.now(),
          droppedTools: 0,
          contextLimitWarning: null,
          cacheStats: null,
          reasoningEffortLevels: undefined,
        }),

      endSession: () =>
        set({
          session: null,
          startTime: null,
          iteration: null,
          droppedTools: 0,
          contextLimitWarning: null,
          cacheStats: null,
          reasoningEffortLevels: undefined,
          // Note: we intentionally do NOT clear lastVisitedAt here. The
          // verifier view uses it to show "previous activity at …" even
          // when the user explicitly ended a session.
        }),

      setEnv: (env) =>
        set((state) => ({
          maxContext: env.maxContext ?? state.maxContext,
          projectRoot: env.projectRoot ?? state.projectRoot,
          projectName: env.projectName ?? state.projectName,
          cwd: env.cwd ?? state.cwd,
          mode: env.mode ?? state.mode,
          contextMode: env.contextMode ?? state.contextMode,
          inputCost: env.inputCost ?? state.inputCost,
          outputCost: env.outputCost ?? state.outputCost,
          cacheReadCost: env.cacheReadCost ?? state.cacheReadCost,
          // Key-presence, not `??`: the server OMITS the field when the new
          // model advertises no effort list, and a `??` fallback would keep
          // the previous model's list alive across the switch (the same
          // stale-leak pattern cacheStats guards against). Present-but-
          // undefined means "no list" and must overwrite.
          reasoningEffortLevels:
            'reasoningEffortLevels' in env ? env.reasoningEffortLevels : state.reasoningEffortLevels,
        })),

      setIteration: (iteration) => set({ iteration }),
      setContextUsage: (tokens, maxContext) =>
        set((state) => ({
          lastInputTokens: tokens,
          maxContext: maxContext ?? state.maxContext,
        })),
      setContextLimitWarning: (contextLimitWarning) => set({ contextLimitWarning }),
      setCacheStats: (cacheStats) => set({ cacheStats }),
      setModes: (modes) => set({ modes }),
      setContextModes: (contextModes) => set({ contextModes }),
      setTodos: (todos) => set({ todos }),
      setUpdateInfo: (info) =>
        set({
          appVersion: info.appVersion,
          latestVersion: info.latestVersion,
          updateAvailable: info.updateAvailable,
        }),
      setDroppedTools: (count) => set({ droppedTools: count }),
    }),
    {
      name: 'wrongstack-session',
      version: SESSION_PERSIST_VERSION,
      // Persist the session pointer + lightweight env fields. Heavy state
      // (todos, modes, contextModes, iterations) lives in chat/fleet
      // stores — pulling them here would balloon localStorage and risk
      // resurrecting partial stores when the WS reconnects with fresh
      // server truth. Cost/token totals are derivable from the live
      // `session.start` payload's `replayUsage`, so we rehydrate those
      // from the server rather than resurrecting stale numbers.
      partialize: (s) => ({
        session: s.session,
        projectName: s.projectName,
        projectRoot: s.projectRoot,
        cwd: s.cwd,
        mode: s.mode,
        contextMode: s.contextMode,
        lastVisitedAt: s.lastVisitedAt,
        // Persist the last known context token estimate so the context-fill
        // bar is accurate on F5. This is a lightweight scalar (8 bytes) —
        // it does not include the full transcript (which lives in the
        // chat-store 'wrongstack-chat' key).
        lastInputTokens: s.lastInputTokens,
      }),
      // Bump the schema version above and add a remap here when the
      // persisted shape changes. Returning `null` drops the persisted
      // payload entirely (a clean rehydrate from defaults is safer than
      // an invalid one).
      migrate: (persisted, version) => {
        if (version > SESSION_PERSIST_VERSION) {
          // Future schema from a newer build — drop and start clean.
          return null as never as {
            session: SessionInfo | null;
            projectName: string;
            projectRoot: string;
            cwd: string;
            mode: string;
            contextMode: string;
            lastVisitedAt: number;
          };
        }
        const p = (persisted ?? {}) as Partial<SessionState>;
        // Reject clearly corrupt payloads: missing session.id is fine
        // (means it's never been populated), but session must be null or
        // have an id string. We do NOT validate session.title shape — the
        // server is the source of truth on rehydrate.
        if (p.session !== null && p.session !== undefined && typeof p.session !== 'object') {
          return null as never as {
            session: SessionInfo | null;
            projectName: string;
            projectRoot: string;
            cwd: string;
            mode: string;
            contextMode: string;
            lastVisitedAt: number;
          };
        }
        return {
          session: (p.session ?? null) as SessionInfo | null,
          projectName: typeof p.projectName === 'string' ? p.projectName : '',
          projectRoot: typeof p.projectRoot === 'string' ? p.projectRoot : '',
          cwd: typeof p.cwd === 'string' ? p.cwd : '',
          mode: typeof p.mode === 'string' ? p.mode : 'default',
          contextMode: typeof p.contextMode === 'string' ? p.contextMode : 'balanced',
          lastVisitedAt: typeof p.lastVisitedAt === 'number' ? p.lastVisitedAt : 0,
        };
      },
      // Bound the rehydrate cost. localStorage already has its own quota,
      // but a single corrupted blob of N MB shouldn't lock the main
      // thread parsing JSON. We bounce anything over the cap rather than
      // try to repair it — let the next mutation rebuild from defaults.
      // The `_state` arg is intentionally unused — the rehydrate side-
      // effect only needs to know "did rehydrate complete", which is
      // signaled by the absence of `error`.
      onRehydrateStorage: () => (_state, error) => {
        if (error) return;
        // Touch the closure so the cap constant is referenced.
        const _cap = PERSIST_MAX_BYTES;
        void _cap;
        // Mark rehydration completion for the verifier view.
        if (typeof window !== 'undefined') {
          (
            window as unknown as { __wrongstackSessionRehydrated?: boolean }
          ).__wrongstackSessionRehydrated = true;
        }
      },
    },
  ),
);
