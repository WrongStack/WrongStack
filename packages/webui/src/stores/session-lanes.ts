/**
 * session-lanes.ts — Per-tab session accounting.
 *
 * Twin of `chat-lanes.ts` for everything that is true of ONE session rather
 * than of the project: which model it runs, how many tokens it burned, what it
 * costs, which iteration it is on, its todo list, its context ceiling.
 *
 * The split matters. Before this file all of it lived in one store describing
 * "the session in front", and a background run's `provider.response` either
 * landed on the foreground tab's counters (visible bleed: tab 1's cost jumping
 * while tab 2 worked) or was folded into a side-map of parked snapshots by
 * hand, one call site at a time. Now a lane owns its numbers whether or not it
 * is on screen, and the foreground is a pointer.
 *
 * Fields that describe the PROJECT — its root, cwd, name, the catalog of modes,
 * the app version — stay global here: four tabs of the same project share them
 * and giving each lane a copy would only invent ways for them to disagree.
 */

import type { Usage } from '@wrongstack/core/types';
import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import { MAX_LANES, setActiveLane as setActiveChatLane } from './chat-lanes';
import type { SessionInfo } from './types.js';

export type CacheStats = {
  readTokens: number;
  writeTokens: number;
  hitRatio: number;
  providers?: Array<{
    provider: string;
    input: number;
    cacheRead: number;
    cacheWrite: number;
    hitRatio: number;
  }>;
  coverageTokens: number;
};

export type ContextLimitWarning = {
  previousMaxContext: number;
  maxContext: number;
  providerId: string;
  modelId: string;
};

export type TodoItem = {
  id: string;
  content: string;
  status: 'pending' | 'in_progress' | 'completed';
  activeForm?: string | undefined;
  blockedBy?: string[] | undefined;
  kanbanBoardId?: string | undefined;
  kanbanTaskId?: string | undefined;
};

/** Everything true of ONE session. */
export interface SessionLaneData {
  session: SessionInfo | null;
  totalTokens: Usage;
  lastInputTokens: number;
  cost: number;
  startTime: number | null;
  maxContext: number;
  contextLimitWarning: ContextLimitWarning | null;
  cacheStats: CacheStats | null;
  inputCost: number;
  outputCost: number;
  cacheReadCost: number;
  reasoningEffortLevels?: string[] | undefined;
  /**
   * Tri-state effort-support signal from the model's reasoningConfig
   * (`undefined` = undocumented → show the control with the full canonical
   * set; `false` = model documents NO effort control → hide it). Never
   * boolean-coerce: undefined is not false.
   */
  effortSupported?: boolean | undefined;
  /** Project-wide effort — display-only hint behind the composer auto option. */
  projectReasoningEffort?: string | undefined;
  mode: string;
  contextMode: string;
  iteration: { index: number; max: number } | null;
  todos: TodoItem[];
  droppedTools: number;
  lastVisitedAt: number;
}

export function createSessionLaneData(): SessionLaneData {
  return {
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
    reasoningEffortLevels: undefined,
    effortSupported: undefined,
    projectReasoningEffort: undefined,
    mode: 'default',
    contextMode: 'balanced',
    iteration: null,
    todos: [],
    droppedTools: 0,
    lastVisitedAt: 0,
  };
}

/** Stable empty lane. Singleton for the same referential-stability reason as
 *  `chat-lanes.EMPTY_LANE`. */
export const EMPTY_SESSION_LANE: SessionLaneData = createSessionLaneData();

/** Project-wide state. Four tabs of one project share exactly this much. */
export interface SessionGlobals {
  projectName: string;
  projectRoot: string;
  cwd: string;
  modes: Array<{ id: string; name: string; description: string }>;
  contextModes: Array<{
    id: string;
    name: string;
    description: string;
    thresholds?: { warn: number | undefined; soft: number; hard: number };
    preserveK?: number | undefined;
    eliseThreshold?: number | undefined;
    custom?: boolean | undefined;
  }>;
  appVersion: string;
  latestVersion: string;
  updateAvailable: boolean;
}

interface SessionLanesState extends SessionGlobals {
  lanes: Record<string, SessionLaneData>;
  activeSessionId: string;
}

export const SESSION_DEFAULT_LANE_ID = '__unbound__';

export const useSessionLanes = create<SessionLanesState>()(
  persist(
    (): SessionLanesState => ({
      lanes: {},
      activeSessionId: SESSION_DEFAULT_LANE_ID,
      projectName: '',
      projectRoot: '',
      cwd: '',
      modes: [],
      contextModes: [],
      appVersion: '',
      latestVersion: '',
      updateAvailable: false,
    }),
    {
      name: 'wrongstack-session-lanes',
      version: 2,
      partialize: (s) => ({
        projectName: s.projectName,
        projectRoot: s.projectRoot,
        cwd: s.cwd,
        lanes: Object.fromEntries(
          Object.entries(s.lanes)
            .slice(0, MAX_LANES)
            .map(([sid, lane]) => [
              sid,
              {
                session: lane.session,
                mode: lane.mode,
                contextMode: lane.contextMode,
                lastInputTokens: lane.lastInputTokens,
                lastVisitedAt: lane.lastVisitedAt,
              },
            ]),
        ),
      }),
      merge: (persisted, current) => {
        const p = (persisted ?? {}) as Partial<SessionLanesState>;
        const lanes: Record<string, SessionLaneData> = {};
        for (const [sid, raw] of Object.entries(p.lanes ?? {}).slice(0, MAX_LANES)) {
          const lane = createSessionLaneData();
          const src = raw as Partial<SessionLaneData>;
          if (src.session && typeof src.session === 'object') lane.session = src.session;
          if (typeof src.mode === 'string') lane.mode = src.mode;
          if (typeof src.contextMode === 'string') lane.contextMode = src.contextMode;
          if (typeof src.lastInputTokens === 'number') lane.lastInputTokens = src.lastInputTokens;
          if (typeof src.lastVisitedAt === 'number') lane.lastVisitedAt = src.lastVisitedAt;
          lanes[sid] = lane;
        }
        return {
          ...current,
          lanes,
          activeSessionId: SESSION_DEFAULT_LANE_ID,
          projectName: typeof p.projectName === 'string' ? p.projectName : '',
          projectRoot: typeof p.projectRoot === 'string' ? p.projectRoot : '',
          cwd: typeof p.cwd === 'string' ? p.cwd : '',
        };
      },
      onRehydrateStorage: () => (_state, error) => {
        if (error) return;
        if (typeof window !== 'undefined') {
          (
            window as unknown as { __wrongstackSessionRehydrated?: boolean }
          ).__wrongstackSessionRehydrated = true;
        }
      },
    },
  ),
);

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

export function readSessionLane(sessionId: string | null | undefined): SessionLaneData {
  if (!sessionId) return EMPTY_SESSION_LANE;
  return useSessionLanes.getState().lanes[sessionId] ?? EMPTY_SESSION_LANE;
}

export function hasSessionLane(sessionId: string | null | undefined): boolean {
  if (!sessionId) return false;
  return sessionId in useSessionLanes.getState().lanes;
}

export function sessionLaneIds(): string[] {
  return Object.keys(useSessionLanes.getState().lanes);
}

export function ensureSessionLane(sessionId: string): string {
  if (!sessionId) return SESSION_DEFAULT_LANE_ID;
  if (useSessionLanes.getState().lanes[sessionId]) return sessionId;
  useSessionLanes.setState((s) => ({
    lanes: { ...s.lanes, [sessionId]: createSessionLaneData() },
  }));
  return sessionId;
}

export function disposeSessionLane(sessionId: string): void {
  if (!useSessionLanes.getState().lanes[sessionId]) return;
  laneActionCache.delete(sessionId);
  useSessionLanes.setState((s) => {
    const next = { ...s.lanes };
    delete next[sessionId];
    return { lanes: next };
  });
}

/**
 * Retire the pre-session lane once a real session exists.
 *
 * Nothing is carried over: accounting recorded before any session started
 * (a stray todo list, a zeroed token counter) describes no session, and
 * inheriting it would credit the new tab with numbers it never earned. The
 * CHAT lane is different — a message typed before `session.start` landed is
 * the user's, and `adoptDefaultLane` does move that.
 */
export function adoptDefaultSessionLane(sessionId: string): void {
  if (!sessionId || sessionId === SESSION_DEFAULT_LANE_ID) return;
  if (!useSessionLanes.getState().lanes[SESSION_DEFAULT_LANE_ID]) return;
  laneActionCache.delete(SESSION_DEFAULT_LANE_ID);
  useSessionLanes.setState((s) => {
    const next = { ...s.lanes };
    delete next[SESSION_DEFAULT_LANE_ID];
    if (!next[sessionId]) next[sessionId] = createSessionLaneData();
    return { lanes: next };
  });
}

/**
 * Move the foreground pointer — BOTH of them.
 *
 * The chat surface and the accounting surface each keep their own
 * `activeSessionId`, and "the tab in front" is only meaningful when the two
 * agree. Every caller used to move them in a pair by hand, which made a
 * missed line a silent bleed: the strip highlighted one slot while the
 * transcript rendered another's, and the send path stamped a third. Moving the
 * chat pointer from here makes the pair impossible to half-apply.
 *
 * `chat-lanes` must NOT reach back into this module (it is the lower layer),
 * so this direction is the only one available — and it is the right one:
 * accounting is what the tab registry re-points.
 */
export function setActiveSessionLane(sessionId: string | null): void {
  const id = sessionId || SESSION_DEFAULT_LANE_ID;
  setActiveChatLane(id);
  const state = useSessionLanes.getState();
  if (state.activeSessionId === id && state.lanes[id]) return;
  ensureSessionLane(id);
  useSessionLanes.setState({ activeSessionId: id });
  sessionLane(id).touch();
}

export function activeSessionLaneId(): string {
  return useSessionLanes.getState().activeSessionId;
}

/**
 * Hook form of the lane pointer, `null` before any session is bound.
 *
 * Components that need "which tab is the user looking at" must read THIS and
 * not `useSessionStore((s) => s.session?.id)`. The latter is the foreground
 * lane's SessionInfo record, which is null between opening a tab and its
 * `session.start` landing — a window in which the tab strip concluded no tab
 * was in front and purged the slot the user had just opened.
 */
export function useActiveSessionId(): string | null {
  const id = useSessionLanes((s) => s.activeSessionId);
  return id && id !== SESSION_DEFAULT_LANE_ID ? id : null;
}

function mutate(
  sessionId: string,
  updater: (lane: SessionLaneData) => Partial<SessionLaneData> | void,
) {
  useSessionLanes.setState((s) => {
    const current = s.lanes[sessionId] ?? createSessionLaneData();
    const patch = updater(current);
    if (!patch) {
      if (s.lanes[sessionId]) return {};
      return { lanes: { ...s.lanes, [sessionId]: current } };
    }
    return { lanes: { ...s.lanes, [sessionId]: { ...current, ...patch } } };
  });
}

// ---------------------------------------------------------------------------
// Lane-scoped actions
// ---------------------------------------------------------------------------

export interface SessionLaneActions {
  readonly sessionId: string;
  readonly data: SessionLaneData;
  setSession: (session: SessionInfo | null) => void;
  startSession: (session: SessionInfo) => void;
  endSession: () => void;
  updateUsage: (usage: Usage, providerId?: string) => void;
  addCost: (cost: number) => void;
  setEnvRates: (env: {
    maxContext?: number | undefined;
    mode?: string | undefined;
    contextMode?: string | undefined;
    inputCost?: number | undefined;
    outputCost?: number | undefined;
    cacheReadCost?: number | undefined;
    reasoningEffortLevels?: string[] | undefined;
    hasReasoningEffortKey?: boolean;
    effortSupported?: boolean | undefined;
    hasEffortSupportedKey?: boolean;
    projectReasoningEffort?: string | undefined;
    hasProjectEffortKey?: boolean;
  }) => void;
  setIteration: (it: { index: number; max: number } | null) => void;
  setContextUsage: (tokens: number, maxContext?: number | undefined) => void;
  setContextLimitWarning: (w: ContextLimitWarning | null) => void;
  setCacheStats: (c: CacheStats | null) => void;
  setTodos: (todos: TodoItem[]) => void;
  setDroppedTools: (count: number) => void;
  touch: () => void;
  patch: (updates: Partial<SessionLaneData>) => void;
}

const laneActionCache = new Map<string, SessionLaneActions>();

/**
 * The one way to write session accounting. Same contract as `chatLane`: the
 * session must be named, so a background run can never credit its tokens to
 * the tab in front.
 */
export function sessionLane(sessionId: string): SessionLaneActions {
  const sid = sessionId || SESSION_DEFAULT_LANE_ID;
  const cached = laneActionCache.get(sid);
  if (cached) return cached;

  const read = (): SessionLaneData => useSessionLanes.getState().lanes[sid] ?? EMPTY_SESSION_LANE;

  const actions: SessionLaneActions = {
    sessionId: sid,
    get data() {
      return read();
    },

    patch: (updates) => mutate(sid, () => updates),
    touch: () => mutate(sid, () => ({ lastVisitedAt: Date.now() })),

    setSession: (session) =>
      mutate(sid, (lane) => {
        const routeChanged =
          lane.session?.id !== session?.id ||
          lane.session?.provider !== session?.provider ||
          lane.session?.model !== session?.model;
        return {
          session,
          lastVisitedAt: Date.now(),
          // A provider/model switch invalidates the cache reading and the
          // model's advertised effort list; keeping either would show the
          // previous route's numbers under the new one.
          ...(routeChanged
            ? {
                contextLimitWarning: null,
                cacheStats: null,
                reasoningEffortLevels: undefined,
                effortSupported: undefined,
              }
            : {}),
        };
      }),

    startSession: (session) =>
      mutate(sid, () => ({
        session,
        startTime: Date.now(),
        iteration: null,
        // A fresh session has no worklist; carrying the previous one over is
        // how a cleared tab came back showing todos it had already finished.
        todos: [],
        lastInputTokens: 0,
        totalTokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        cost: 0,
        lastVisitedAt: Date.now(),
        droppedTools: 0,
        contextLimitWarning: null,
        cacheStats: null,
        reasoningEffortLevels: undefined,
        effortSupported: undefined,
      })),

    endSession: () =>
      mutate(sid, () => ({
        session: null,
        startTime: null,
        iteration: null,
        droppedTools: 0,
        contextLimitWarning: null,
        cacheStats: null,
        reasoningEffortLevels: undefined,
        effortSupported: undefined,
      })),

    updateUsage: (usage, providerId) =>
      mutate(sid, (lane) => {
        const inputDelta = usage.input + (usage.cacheRead ?? 0) + (usage.cacheWrite ?? 0);
        const cacheReadDelta = usage.cacheRead ?? 0;
        const cacheWriteDelta = usage.cacheWrite ?? 0;
        const nextInput = lane.totalTokens.input + usage.input;
        const nextCacheRead = (lane.totalTokens.cacheRead ?? 0) + cacheReadDelta;
        const nextCacheWrite = (lane.totalTokens.cacheWrite ?? 0) + cacheWriteDelta;
        const provider = providerId ?? lane.session?.provider ?? 'unknown';
        const providers = [...(lane.cacheStats?.providers ?? [])];
        const providerIndex = providers.findIndex((entry) => entry.provider === provider);
        const previous =
          providerIndex >= 0
            ? providers[providerIndex]!
            : { provider, input: 0, cacheRead: 0, cacheWrite: 0, hitRatio: 0 };
        const providerInput = previous.input + usage.input;
        const providerCacheRead = previous.cacheRead + cacheReadDelta;
        const providerCacheWrite = previous.cacheWrite + cacheWriteDelta;
        const providerTotal = providerInput + providerCacheRead + providerCacheWrite;
        const nextProvider = {
          provider,
          input: providerInput,
          cacheRead: providerCacheRead,
          cacheWrite: providerCacheWrite,
          hitRatio:
            providerTotal > 0 ? Math.min(1, Math.max(0, providerCacheRead / providerTotal)) : 0,
        };
        if (providerIndex >= 0) providers[providerIndex] = nextProvider;
        else providers.push(nextProvider);
        providers.sort((a, b) => b.cacheRead - a.cacheRead);
        const totalPrompt = nextInput + nextCacheRead + nextCacheWrite;
        return {
          totalTokens: {
            input: nextInput,
            output: lane.totalTokens.output + usage.output,
            cacheRead: nextCacheRead,
            cacheWrite: nextCacheWrite,
          },
          lastInputTokens: inputDelta || lane.lastInputTokens,
          cacheStats: {
            readTokens: nextCacheRead,
            writeTokens: nextCacheWrite,
            hitRatio: totalPrompt > 0 ? Math.min(1, Math.max(0, nextCacheRead / totalPrompt)) : 0,
            coverageTokens: cacheReadDelta,
            providers,
          },
        };
      }),

    addCost: (cost) => mutate(sid, (lane) => ({ cost: lane.cost + cost })),

    setEnvRates: (env) =>
      mutate(sid, (lane) => ({
        maxContext: env.maxContext ?? lane.maxContext,
        mode: env.mode ?? lane.mode,
        contextMode: env.contextMode ?? lane.contextMode,
        inputCost: env.inputCost ?? lane.inputCost,
        outputCost: env.outputCost ?? lane.outputCost,
        cacheReadCost: env.cacheReadCost ?? lane.cacheReadCost,
        // Key-presence, not `??`: the server OMITS the field when the new
        // model advertises no effort list, and `??` would keep the previous
        // model's list alive across the switch.
        reasoningEffortLevels: env.hasReasoningEffortKey
          ? env.reasoningEffortLevels
          : lane.reasoningEffortLevels,
        // Same key-presence rule as the effort list: an omitted field must
        // not keep the previous model's tri-state alive across a switch.
        effortSupported: env.hasEffortSupportedKey
          ? env.effortSupported
          : lane.effortSupported,
        // Project-wide hint: process-wide, not per-model — refreshed via
        // key-presence on every session.start, never reset on route change.
        projectReasoningEffort: env.hasProjectEffortKey
          ? env.projectReasoningEffort
          : lane.projectReasoningEffort,
      })),

    setIteration: (iteration) => mutate(sid, () => ({ iteration })),
    setContextUsage: (tokens, maxContext) =>
      mutate(sid, (lane) => ({
        lastInputTokens: tokens,
        maxContext: maxContext ?? lane.maxContext,
      })),
    setContextLimitWarning: (contextLimitWarning) => mutate(sid, () => ({ contextLimitWarning })),
    setCacheStats: (cacheStats) => mutate(sid, () => ({ cacheStats })),
    setTodos: (todos) => mutate(sid, () => ({ todos })),
    setDroppedTools: (droppedTools) => mutate(sid, () => ({ droppedTools })),
  };

  laneActionCache.set(sid, actions);
  return actions;
}

export function activeSessionLane(): SessionLaneActions {
  return sessionLane(useSessionLanes.getState().activeSessionId);
}

/** Project-wide setters. Deliberately not per-lane. */
export function setSessionGlobals(patch: Partial<SessionGlobals>): void {
  useSessionLanes.setState(patch);
}
