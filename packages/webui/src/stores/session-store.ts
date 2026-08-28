/**
 * session-store.ts — Foreground view over the session lane registry.
 *
 * The per-tab accounting lives in `session-lanes.ts`. This module projects
 * `lanes[activeSessionId]` (plus the project-wide globals) behind the
 * historical `useSessionStore` API, so every panel that renders the tab in
 * front keeps working unchanged.
 *
 * WS handlers must NOT write through this facade — they route by
 * `payload.sessionId` via `sessionFor(msg)` / `sessionLane(sessionId)`.
 * Writing here from a handler credits a background run's tokens, cost or
 * iteration to whichever tab happens to be on screen.
 */

import type { Usage } from '@wrongstack/core/types';
import { useStore } from 'zustand';
import {
  adoptDefaultLane as adoptDefaultChatLane,
  DEFAULT_LANE_ID,
  setActiveLane as setActiveChatLane,
} from './chat-lanes';
import { useConfigStore } from './config-store.js';
import { useFileStore } from './file-store.js';
import { useGitChangesStore } from './git-changes-store.js';
import { useLocalPrefs } from './local-prefs.js';
import {
  activeSessionLane,
  activeSessionLaneId,
  type CacheStats,
  type ContextLimitWarning,
  createSessionLaneData,
  EMPTY_SESSION_LANE,
  SESSION_DEFAULT_LANE_ID,
  type SessionGlobals,
  type SessionLaneData,
  sessionLane,
  setActiveSessionLane,
  setSessionGlobals,
  type TodoItem,
  useSessionLanes,
} from './session-lanes.js';
import type { SessionInfo } from './types.js';
import { useUIStore } from './ui-store.js';

export type {
  CacheStats,
  ContextLimitWarning,
  SessionLaneData,
  TodoItem,
} from './session-lanes.js';
export {
  activeSessionLane,
  activeSessionLaneId,
  adoptDefaultSessionLane,
  disposeSessionLane,
  ensureSessionLane,
  hasSessionLane,
  readSessionLane,
  type SessionLaneActions,
  sessionLane,
  sessionLaneIds,
  setActiveSessionLane,
  setSessionGlobals,
  useSessionLanes,
} from './session-lanes.js';

export interface SessionState extends SessionGlobals, SessionLaneData {
  setSession: (session: SessionInfo | null) => void;
  updateUsage: (usage: Usage, providerId?: string) => void;
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
  setContextLimitWarning: (warning: ContextLimitWarning | null) => void;
  setCacheStats: (cache: CacheStats | null) => void;
  setModes: (modes: SessionGlobals['modes']) => void;
  setContextModes: (modes: SessionGlobals['contextModes']) => void;
  setTodos: (todos: TodoItem[]) => void;
  setUpdateInfo: (info: {
    appVersion: string;
    latestVersion: string;
    updateAvailable: boolean;
  }) => void;
  setDroppedTools: (count: number) => void;
  switchSession: (newSessionId: string) => void;
}

// ---------------------------------------------------------------------------
// Active-lane projection
// ---------------------------------------------------------------------------

type LanesState = ReturnType<typeof useSessionLanes.getState>;

const viewCache = new WeakMap<LanesState, SessionState>();

const GLOBAL_KEYS = new Set<string>([
  'projectName',
  'projectRoot',
  'cwd',
  'modes',
  'contextModes',
  'appVersion',
  'latestVersion',
  'updateAvailable',
]);

function projectActiveLane(state: LanesState): SessionState {
  const cached = viewCache.get(state);
  if (cached) return cached;

  const sid = state.activeSessionId;
  const lane = state.lanes[sid] ?? EMPTY_SESSION_LANE;
  const actions = sessionLane(sid);

  const view: SessionState = {
    // lane
    session: lane.session,
    totalTokens: lane.totalTokens,
    lastInputTokens: lane.lastInputTokens,
    cost: lane.cost,
    startTime: lane.startTime,
    maxContext: lane.maxContext,
    contextLimitWarning: lane.contextLimitWarning,
    cacheStats: lane.cacheStats,
    inputCost: lane.inputCost,
    outputCost: lane.outputCost,
    cacheReadCost: lane.cacheReadCost,
    reasoningEffortLevels: lane.reasoningEffortLevels,
    mode: lane.mode,
    contextMode: lane.contextMode,
    iteration: lane.iteration,
    todos: lane.todos,
    droppedTools: lane.droppedTools,
    lastVisitedAt: lane.lastVisitedAt,
    // globals
    projectName: state.projectName,
    projectRoot: state.projectRoot,
    cwd: state.cwd,
    modes: state.modes,
    contextModes: state.contextModes,
    appVersion: state.appVersion,
    latestVersion: state.latestVersion,
    updateAvailable: state.updateAvailable,
    // actions
    setSession: setSessionOnForeground,
    updateUsage: actions.updateUsage,
    addCost: actions.addCost,
    startSession: startSessionOnForeground,
    endSession: actions.endSession,
    setEnv: setEnvOnActiveLane,
    setIteration: actions.setIteration,
    setContextUsage: actions.setContextUsage,
    setContextLimitWarning: actions.setContextLimitWarning,
    setCacheStats: actions.setCacheStats,
    setModes: setModes,
    setContextModes: setContextModes,
    setTodos: actions.setTodos,
    setUpdateInfo: setUpdateInfo,
    setDroppedTools: actions.setDroppedTools,
    switchSession: switchSession,
  };

  viewCache.set(state, view);
  return view;
}

/**
 * Setting the session through the FACADE means "this is the tab in front" —
 * that is what the single-store API meant, and app code plus tests rely on it.
 * Handlers that fill a background lane call `sessionLane(id).setSession`
 * instead, which never moves the pointer.
 */
function bindForeground(sessionId: string | null | undefined): void {
  // Preferences move with the pointer. `autonomy`, `yolo`, the context
  // strategy, the reasoning knobs and the prompt variant belong to ONE tab —
  // the pickers must describe the tab on screen, not the last one that
  // happened to change a setting. This runs before the early return below
  // because the very first bind after a reload can already match the lane
  // pointer while the prefs store still points at nothing.
  useLocalPrefs.getState().bindSession(sessionId ?? null);
  useUIStore.getState().bindSessionChrome(sessionId ?? null);
  useFileStore.getState().bindSessionFiles(sessionId ?? null);
  useGitChangesStore.getState().bindSessionGitChanges(sessionId ?? null);
  // No session in front: fall back to the pre-session lane rather than leaving
  // the pointer on a session that is no longer displayed. A stale pointer is
  // how "ended the session, kept writing into its transcript" happened.
  const target = sessionId || DEFAULT_LANE_ID;
  if (activeSessionLaneId() === target) return;
  // Anything the user typed before a session existed belongs to the first real
  // one — otherwise binding the session would silently blank the composer's
  // transcript.
  if (activeSessionLaneId() === DEFAULT_LANE_ID && target !== DEFAULT_LANE_ID) {
    adoptDefaultChatLane(target);
  }
  setActiveSessionLane(target);
  setActiveChatLane(target);
}

function setSessionOnForeground(session: SessionInfo | null): void {
  bindForeground(session?.id ?? null);
  activeSessionLane().setSession(session);
}

function startSessionOnForeground(session: SessionInfo): void {
  bindForeground(session.id);
  activeSessionLane().startSession(session);
}

/**
 * `setEnv` mixes lane fields (rates, ceiling, mode) with project globals
 * (root, cwd, name); split them so a model's cost table never becomes another
 * tab's, and the project path stays shared.
 */
function setEnvOnActiveLane(env: Parameters<SessionState['setEnv']>[0]): void {
  const globals: Partial<SessionGlobals> = {};
  if (env.projectRoot !== undefined) globals.projectRoot = env.projectRoot;
  if (env.projectName !== undefined) globals.projectName = env.projectName;
  if (env.cwd !== undefined) globals.cwd = env.cwd;
  if (Object.keys(globals).length > 0) setSessionGlobals(globals);
  activeSessionLane().setEnvRates({
    maxContext: env.maxContext,
    mode: env.mode,
    contextMode: env.contextMode,
    inputCost: env.inputCost,
    outputCost: env.outputCost,
    cacheReadCost: env.cacheReadCost,
    reasoningEffortLevels: env.reasoningEffortLevels,
    hasReasoningEffortKey: 'reasoningEffortLevels' in env,
  });
}

function setModes(modes: SessionGlobals['modes']): void {
  setSessionGlobals({ modes });
}

function setContextModes(contextModes: SessionGlobals['contextModes']): void {
  setSessionGlobals({ contextModes });
}

function setUpdateInfo(info: {
  appVersion: string;
  latestVersion: string;
  updateAvailable: boolean;
}): void {
  setSessionGlobals(info);
}

/**
 * Point the foreground at another session's lane.
 *
 * Nothing is parked and nothing is restored: every lane keeps its own totals,
 * cost, iteration and todo list at all times. The old implementation copied
 * state into and out of a snapshot map on every switch, and every field added
 * later had to be remembered in three places or it leaked.
 */
function switchSession(newSessionId: string): void {
  // The pickers read the flat pref fields. Those fields describe whichever
  // session `bindSession` last pointed at, so a tab switch that moved the
  // lane pointer but left the pref pointer behind showed tab 1's YOLO /
  // autonomy / context strategy on tab 2 until a prefs.get round-trip
  // happened to correct it — and a click in that window wrote tab 2's
  // choice into tab 1's override map.
  useLocalPrefs.getState().bindSession(newSessionId);
  setActiveSessionLane(newSessionId);
  const lane = useSessionLanes.getState().lanes[newSessionId];
  const provider = lane?.session?.provider;
  const model = lane?.session?.model;
  if (provider && model) useConfigStore.getState().setConfig({ provider, model });
  else if (provider) useConfigStore.getState().setConfig({ provider });
}

// ---------------------------------------------------------------------------
// The facade
// ---------------------------------------------------------------------------

function getState(): SessionState {
  return projectActiveLane(useSessionLanes.getState());
}

function setState(
  partial: Partial<SessionState> | ((state: SessionState) => Partial<SessionState>),
): void {
  const patch = typeof partial === 'function' ? partial(getState()) : partial;
  if (!patch) return;
  // A `setState({ session })` re-points the foreground, matching what the
  // single-store API did before lanes existed.
  if ('session' in patch) {
    const nextSession = (patch as { session?: SessionInfo | null }).session;
    bindForeground(nextSession?.id ?? null);
  }
  const globals: Record<string, unknown> = {};
  const laneFields: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(patch)) {
    if (typeof value === 'function') continue;
    if (GLOBAL_KEYS.has(key)) globals[key] = value;
    else laneFields[key] = value;
  }
  if (Object.keys(globals).length > 0) setSessionGlobals(globals as Partial<SessionGlobals>);
  if (Object.keys(laneFields).length > 0) {
    activeSessionLane().patch(laneFields as Partial<SessionLaneData>);
  }
}

function subscribe(listener: (state: SessionState, prev: SessionState) => void): () => void {
  return useSessionLanes.subscribe((state, prev) =>
    listener(projectActiveLane(state), projectActiveLane(prev)),
  );
}

interface SessionStoreFacade {
  <T>(selector: (state: SessionState) => T): T;
  getState: typeof getState;
  getInitialState: typeof getState;
  setState: typeof setState;
  subscribe: typeof subscribe;
  /** The lane registry's own persist API (rehydrate/flush/clearStorage). */
  persist: (typeof useSessionLanes)['persist'];
}

export const useSessionStore: SessionStoreFacade = Object.assign(
  function useSessionStoreHook<T>(selector: (state: SessionState) => T): T {
    return useStore(useSessionLanes, (state) => selector(projectActiveLane(state)));
  },
  { getState, getInitialState: getState, setState, subscribe, persist: useSessionLanes.persist },
);

// ---------------------------------------------------------------------------
// Compatibility shims
// ---------------------------------------------------------------------------

interface SessionSnapshot {
  session: SessionInfo | null;
  provider?: string | undefined;
  model?: string | undefined;
  mode: string;
  contextMode: string;
  totalTokens: Usage;
  lastInputTokens: number;
  cost: number;
  startTime: number | null;
  maxContext: number;
  reasoningEffortLevels?: string[] | undefined;
  cacheStats: CacheStats | null;
  iteration: { index: number; max: number } | null;
  todos: TodoItem[];
}

/**
 * Read-through view of the lane registry in the shape the old parked-snapshot
 * map exposed. Kept so the few call sites that want "what does tab X look
 * like right now" keep reading — but it is no longer a separate copy of the
 * truth that has to be kept in sync, which is what let a tab come back showing
 * a neighbour's model or zeroed counters.
 */
export const memorySessionSnapshots = {
  has(sessionId: string): boolean {
    return sessionId in useSessionLanes.getState().lanes;
  },
  get(sessionId: string): SessionSnapshot | undefined {
    const lane = useSessionLanes.getState().lanes[sessionId];
    if (!lane) return undefined;
    return {
      session: lane.session,
      provider: lane.session?.provider,
      model: lane.session?.model,
      mode: lane.mode,
      contextMode: lane.contextMode,
      totalTokens: lane.totalTokens,
      lastInputTokens: lane.lastInputTokens,
      cost: lane.cost,
      startTime: lane.startTime,
      maxContext: lane.maxContext,
      reasoningEffortLevels: lane.reasoningEffortLevels,
      cacheStats: lane.cacheStats,
      iteration: lane.iteration,
      todos: lane.todos,
    };
  },
  set(sessionId: string, snapshot: Partial<SessionSnapshot>): void {
    const patch: Partial<SessionLaneData> = {};
    if (snapshot.session !== undefined) patch.session = snapshot.session;
    if (snapshot.mode !== undefined) patch.mode = snapshot.mode;
    if (snapshot.contextMode !== undefined) patch.contextMode = snapshot.contextMode;
    if (snapshot.totalTokens !== undefined) patch.totalTokens = snapshot.totalTokens;
    if (snapshot.lastInputTokens !== undefined) patch.lastInputTokens = snapshot.lastInputTokens;
    if (snapshot.cost !== undefined) patch.cost = snapshot.cost;
    if (snapshot.startTime !== undefined) patch.startTime = snapshot.startTime;
    if (snapshot.maxContext !== undefined) patch.maxContext = snapshot.maxContext;
    if (snapshot.reasoningEffortLevels !== undefined) {
      patch.reasoningEffortLevels = snapshot.reasoningEffortLevels;
    }
    if (snapshot.cacheStats !== undefined) patch.cacheStats = snapshot.cacheStats;
    if (snapshot.iteration !== undefined) patch.iteration = snapshot.iteration;
    if (snapshot.todos !== undefined) patch.todos = snapshot.todos;
    sessionLane(sessionId).patch(patch);
  },
  delete(sessionId: string): void {
    useSessionLanes.setState((s) => {
      const next = { ...s.lanes };
      delete next[sessionId];
      return { lanes: next };
    });
  },
  clear(): void {
    useSessionLanes.setState({ lanes: {}, activeSessionId: SESSION_DEFAULT_LANE_ID });
  },
};

/**
 * Credit usage to a session that is not in front.
 *
 * Now a plain lane write — background accrual is the DEFAULT, not a special
 * case bolted onto the side. Creates the lane if the run outran its tab.
 */
function accrueBackgroundUsage(
  sessionId: string,
  usage: {
    input: number;
    output: number;
    cacheRead?: number | undefined;
    cacheWrite?: number | undefined;
  },
  rates: { inputCost: number; outputCost: number; cacheReadCost: number },
): void {
  if (!sessionId) return;
  const lanes = useSessionLanes.getState().lanes;
  if (!lanes[sessionId]) return;
  const lane = sessionLane(sessionId);
  lane.updateUsage({
    input: usage.input ?? 0,
    output: usage.output ?? 0,
    cacheRead: usage.cacheRead ?? 0,
    cacheWrite: usage.cacheWrite ?? 0,
  });
  const cost =
    ((usage.input ?? 0) * rates.inputCost +
      (usage.cacheWrite ?? 0) * rates.inputCost +
      (usage.output ?? 0) * rates.outputCost +
      (usage.cacheRead ?? 0) * rates.cacheReadCost) /
    1_000_000;
  lane.addCost(cost);
}

export { createSessionLaneData };
