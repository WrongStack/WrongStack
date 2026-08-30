import * as fs from 'node:fs/promises';
import type { CacheStats } from '@wrongstack/core/types';
import { type ContextBreakdown, getContextBreakdown } from '@wrongstack/core/utils';
import { useEffect, useMemo, useState } from 'react';
import type { AppProps } from '../app-props.js';
import type { FleetEntry, State } from '../app-state.js';
import type { StatuslineItem } from '../components/statusline-picker.js';
import { resolveContextFill } from '../context-fill.js';
import type { TokenRefreshData } from './use-token-counter-refresh.js';

interface StatusbarViewModelOptions {
  agent: AppProps['agent'];
  tokenCounter: AppProps['tokenCounter'];
  activeMaxContext: number | undefined;
  effectiveMaxContext: number | undefined;
  liveProvider: string;
  liveModel: string;
  liveTodos: readonly { status: string }[];
  sidebarVisible?: boolean | undefined;
  state: State;
  /**
   * Statusline hidden items. The plan/task chips are the only consumers of
   * the 3s `fs.stat` polls in this hook — when the corresponding chip is
   * user-hidden, skip the poll entirely until it is visible again.
   */
  hiddenItems?: readonly StatuslineItem[] | undefined;
  /**
   * Live token-counter refresh snapshot — supplies per-request
   * `currentRequestTokens` plus cumulative `cacheStats`. When omitted the
   * view model falls back to reading the counter directly so existing
   * callers stay correct (the older path was a render-time poll of
   * mutable counters and lagged async provider responses).
   *
   * Typed as the exact `TokenRefreshData` shape so callers passing the
   * hook's return value stay assignable under `exactOptionalPropertyTypes`.
   */
  tokenRefresh?: TokenRefreshData;
}

interface PlanCounts {
  open: number;
  inProgress: number;
  done: number;
}

interface TaskCounts {
  pending: number;
  inProgress: number;
  completed: number;
  blocked: number;
  failed: number;
}

function samePlanCounts(a: PlanCounts | null, b: PlanCounts | null): boolean {
  return (
    a === b ||
    (a !== null &&
      b !== null &&
      a.open === b.open &&
      a.inProgress === b.inProgress &&
      a.done === b.done)
  );
}

function sameTaskCounts(a: TaskCounts | null, b: TaskCounts | null): boolean {
  return (
    a === b ||
    (a !== null &&
      b !== null &&
      a.pending === b.pending &&
      a.inProgress === b.inProgress &&
      a.completed === b.completed &&
      a.blocked === b.blocked &&
      a.failed === b.failed)
  );
}

/** Builds status-bar projections without coupling them to the root App render. */
export function useStatusbarViewModel({
  agent,
  tokenCounter,
  activeMaxContext,
  effectiveMaxContext,
  liveProvider,
  liveModel,
  liveTodos,
  sidebarVisible,
  state,
  hiddenItems = [],
  tokenRefresh,
}: StatusbarViewModelOptions): {
  contextBreakdown: ContextBreakdown | undefined;
  currentContextTokens: number;
  contextWindow: { used: number; max: number } | undefined;
  cacheStats: CacheStats;
  /**
   * "Cache coverage" — how far the cached prefix reaches through the live
   * request, expressed in tokens. Computed from the per-request
   * `cacheRead` snapshot (the cached prefix of the current prompt) and
   * the measured `used` total. Capped at `used` so the figure never
   * overshoots the actual request size. Zero when no cache read was
   * reported on the latest request — the indicator stays hidden instead
   * of suggesting a meaningless 0.
   */
  cacheCoverageTokens: number;
  todos: { pending: number; inProgress: number; completed: number };
  fleetCounts: { running: number; idle: number; pending: number; completed: number } | undefined;
  visibleSubagentCount: number;
  hasVisibleFleetPanel: boolean;
  entriesWithLeader: Record<string, FleetEntry>;
  planCounts: PlanCounts | null;
  taskCounts: TaskCounts | null;
  droppedTools: number;
} {
  /**
   * A `/resume` is in flight: the journal is being read, or its transcript is
   * still streaming in.
   *
   * Every session-scoped reading below is blanked for that window. The reducer
   * already clears `state.leader.ctxTokens` at `resumeLoadStart` for exactly
   * this reason, but that only removes the FIRST source in the fill ladder —
   * the per-request snapshot and the local estimate both keep answering from
   * the leaving session (`tokenCounter` is not reset until the host's
   * `token_accounting` stage, and `agent.ctx.messages` still holds the old
   * transcript until the writer swap). So the sidebar's MODEL CORE meter and
   * PROMPT CACHE card went on reporting a conversation that was no longer on
   * screen, under the incoming session's loading block.
   *
   * Display-only, and self-healing: when the resume settles, the counter and
   * the context both describe the resumed session; when it fails or lands
   * read-only, the agent is back in the session it never left and its real
   * numbers return.
   */
  // Truthiness, not `!== null`: `State` declares this as `ResumeLoadState |
  // null`, but partial state stubs leave it absent, and an `undefined` must
  // read as "no resume in flight" rather than blanking every reading below.
  const resuming = Boolean(state.resumeLoad);
  const maxContext = activeMaxContext ?? agent.ctx.provider.capabilities.maxContext;
  // `currentRequestTokens()` is the per-request snapshot — the right number
  // for the status bar. `tokenCounter.total()` is cumulative across the
  // entire session and the `TokenCounter` type contract explicitly warns
  // it cannot be compared meaningfully against a per-request maxContext
  // ceiling (see packages/core/src/types/token-counter.ts:22-29). We never
  // substitute `total()` into the bar: doing so yields a 100% reading after
  // any model switch that targets a smaller context window, because the
  // cumulative from the previous model can dwarf the new maxContext.
  const perRequest = tokenCounter?.currentRequestTokens();
  const perRequestTokens =
    (perRequest?.input ?? 0) + (perRequest?.cacheRead ?? 0) + (perRequest?.cacheWrite ?? 0);
  // The agent loop's own `ctx.pct` measurement, mirrored into state by the
  // `leaderCtxPct` reducer. This is the number `/context` displays, so feeding
  // it to `resolveContextFill` as the first-choice source is what keeps the
  // chip and the panel from reporting two different fills. It also makes the
  // chip *live*: it is refreshed by a reducer dispatch on every iteration,
  // whereas `currentRequestTokens()` is a mutable snapshot read during render
  // that only moves when some unrelated re-render happens to observe it.
  const loopReportedTokens = state.leader.ctxTokens;
  // Two-pass so the expensive local estimate is only computed when the cheap
  // sources have nothing usable. `needsLocalEstimate` from the first pass is
  // the authoritative "loop and provider both failed" signal — it replaces the
  // old `perRequestTokens <= 0` test, which asked for a breakdown even when the
  // loop had already reported a real number.
  const cheapFill = resolveContextFill({ loopReportedTokens, perRequestTokens, maxContext });
  // The breakdown is consumed by two consumers:
  //  1. The status bar's fallback when neither the loop nor the provider has a
  //     usable number (post-model switch, before the first request lands).
  //  2. The interactive ContextPanel's Composition tab, which needs the
  //     per-category breakdown while the panel is open.
  // These conditions are independent: the panel or right sidebar can be open
  // with a fresh `currentRequestTokens` snapshot (and still want the visual
  // composition), while both can be closed and the bar still needs its local
  // fallback. Compute the breakdown whenever any consumer needs it.
  const needLocalEstimate = cheapFill.needsLocalEstimate;
  const panelWantsBreakdown = state.contextPanelOpen;
  const sidebarWantsBreakdown = sidebarVisible;
  // Skipped outright during a resume: the walk would measure the OLD
  // conversation (`agent.ctx.messages` is not swapped until the host reaches
  // the writer swap), and the result is discarded below anyway. Not paying for
  // it also keeps the spinner moving while a large journal parses.
  const needBreakdown =
    !resuming && (needLocalEstimate || panelWantsBreakdown || sidebarWantsBreakdown);

  // Invalidation fingerprint for the breakdown. `getContextBreakdown` walks
  // `ctx.systemPrompt`, `ctx.tools` and `ctx.messages`, so the snapshot goes
  // stale the moment any of those change — but `agent.ctx` is one stable object
  // for the whole session and `contextChipVersion` only bumps on /clear and
  // /rewind. Keyed on those alone, the Composition tab froze at whatever it
  // measured when the panel was first opened and never moved again. Use the
  // same (messages, tools, revision) triple the agent loop uses to gate its own
  // `ctx.pct` emit, so the panel and the loop agree on when the number changed.
  const conversationRevision =
    (agent.ctx.state as { revision?: number } | undefined)?.revision ?? 0;
  const messageCount = agent.ctx.messages?.length ?? 0;
  const toolDefCount = agent.ctx.tools?.length ?? 0;

  const contextBreakdown = useMemo<ContextBreakdown | undefined>(() => {
    if (!needBreakdown) return undefined;
    try {
      return getContextBreakdown(agent.ctx);
    } catch {
      return undefined;
    }
  }, [
    agent.ctx,
    needBreakdown,
    state.contextChipVersion,
    conversationRevision,
    messageCount,
    toolDefCount,
  ]);

  // Bar reading: loop-reported tokens, then the per-request provider snapshot,
  // then the local estimate, then 0 (bar hides via the `maxContext > 0` guard
  // on contextWindow). The cumulative session total is never an input — see
  // context-fill.ts for why clamping it pegs the bar at a false 100%.
  const currentContextTokens = resuming
    ? 0
    : needLocalEstimate
      ? resolveContextFill({
          loopReportedTokens,
          perRequestTokens,
          localEstimate: contextBreakdown?.total,
          maxContext,
        }).used
      : cheapFill.used;
  const contextWindow = useMemo(() => {
    void state.contextChipVersion;
    // `undefined`, not `{used: 0}`: the MODEL CORE card reads a missing window
    // as "awaiting telemetry" and the bar hides, which is the honest reading
    // while a resume decides which conversation is loaded. A zeroed window
    // would instead draw a confident empty meter.
    if (resuming) return undefined;
    return maxContext > 0 ? { used: currentContextTokens, max: maxContext } : undefined;
  }, [currentContextTokens, maxContext, resuming, state.contextChipVersion]);

  const todos = useMemo(() => {
    const counts = { pending: 0, inProgress: 0, completed: 0 };
    for (const todo of liveTodos) {
      if (todo.status === 'pending') counts.pending++;
      else if (todo.status === 'in_progress') counts.inProgress++;
      else if (todo.status === 'completed') counts.completed++;
    }
    return counts;
  }, [liveTodos]);

  const fleetCounts = useMemo(() => {
    const entries = Object.values(state.fleet);
    if (entries.length === 0) return undefined;
    // Derive every bucket from FleetEntry.status — this used to hardcode
    // idle/pending/completed to 0, which left the status bar's idle and
    // completed render branches permanently dead. FleetEntry has no
    // 'pending' state (agents enter the fleet already running), so that
    // bucket is honestly 0 rather than misassigned.
    const counts = { running: 0, idle: 0, pending: 0, completed: 0 };
    for (const entry of entries) {
      if (entry.status === 'running') counts.running++;
      else if (entry.status === 'idle') counts.idle++;
      else counts.completed++; // success | failed | timeout | stopped — terminal
    }
    return counts.running > 0 ? counts : undefined;
  }, [state.fleet]);
  const visibleSubagentCount = fleetCounts?.running ?? 0;
  const hasVisibleFleetPanel = useMemo(
    () => Object.values(state.fleet).some((entry) => entry.status === 'running'),
    [state.fleet],
  );

  const entriesWithLeader = useMemo<Record<string, FleetEntry>>(() => {
    const leaderEntry: FleetEntry = {
      id: 'leader',
      name: 'LEADER',
      provider: liveProvider,
      model: liveModel,
      status:
        state.status === 'running' || state.status === 'streaming' || state.leader.iterating
          ? 'running'
          : 'idle',
      streamingText: '',
      iterations: state.leader.iterations,
      toolCalls: state.leader.toolCalls,
      recentTools: state.leader.recentTools,
      recentMessages: [],
      cost: tokenCounter?.estimateCost().total ?? 0,
      startedAt: state.leader.startedAt,
      lastEventAt: state.leader.lastEventAt,
      currentTool: state.leader.currentTool,
      ctxPct: state.leader.ctxPct,
      ctxTokens: state.leader.ctxTokens,
      ctxMaxTokens: state.leader.ctxMaxTokens ?? effectiveMaxContext,
    };
    return { leader: leaderEntry, ...state.fleet };
  }, [
    state.fleet,
    state.leader,
    state.status,
    liveProvider,
    liveModel,
    effectiveMaxContext,
    tokenCounter,
  ]);

  // Visibility gate: `plan`/`tasks` are the only chips that consume the
  // 3s fs.stat polls below. When the user hides a chip via /statusline,
  // skip its poll entirely (no stats, no reads, no JSON.parse) until the
  // chip is visible again. The booleans — not the array — are the effect
  // deps so an unrelated hidden-item toggle doesn't restart the interval.
  const planHidden = hiddenItems.includes('plan');
  const taskHidden = hiddenItems.includes('tasks');

  const planPath = (agent.ctx.meta as Record<string, unknown>)['plan.path'];
  const [planCounts, setPlanCounts] = useState<PlanCounts | null>(null);
  useEffect(() => {
    if (planHidden) return;
    if (typeof planPath !== 'string' || !planPath) {
      setPlanCounts(null);
      return;
    }
    let cancelled = false;
    let lastFingerprint = '';
    const poll = async () => {
      try {
        const stat = await fs.stat(planPath);
        const fingerprint = `${stat.mtimeMs}:${stat.size}`;
        if (fingerprint === lastFingerprint) return;
        const data = await fs.readFile(planPath, 'utf8');
        const parsed = JSON.parse(data) as { items?: Array<{ status?: string | undefined }> };
        if (cancelled) return;
        lastFingerprint = fingerprint;
        if (!Array.isArray(parsed.items)) {
          setPlanCounts((previous) => (previous === null ? previous : null));
          return;
        }
        let open = 0;
        let inProgress = 0;
        let done = 0;
        for (const item of parsed.items) {
          if (item?.status === 'done') done++;
          else if (item?.status === 'in_progress') inProgress++;
          else open++;
        }
        const next = open + inProgress + done > 0 ? { open, inProgress, done } : null;
        setPlanCounts((previous) => (samePlanCounts(previous, next) ? previous : next));
      } catch {
        if (!cancelled) {
          lastFingerprint = '';
          setPlanCounts((previous) => (previous === null ? previous : null));
        }
      }
    };
    void poll();
    const id = setInterval(poll, 3000);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [planPath, planHidden]);

  const taskPath = (agent.ctx.meta as Record<string, unknown>)['task.path'];
  const [taskCounts, setTaskCounts] = useState<TaskCounts | null>(null);
  useEffect(() => {
    if (taskHidden) return;
    if (typeof taskPath !== 'string' || !taskPath) {
      setTaskCounts(null);
      return;
    }
    let cancelled = false;
    let lastFingerprint = '';
    const poll = async () => {
      try {
        const stat = await fs.stat(taskPath);
        const fingerprint = `${stat.mtimeMs}:${stat.size}`;
        if (fingerprint === lastFingerprint) return;
        const data = await fs.readFile(taskPath, 'utf8');
        const parsed = JSON.parse(data) as { tasks?: Array<{ status?: string | undefined }> };
        if (cancelled) return;
        lastFingerprint = fingerprint;
        if (!Array.isArray(parsed.tasks)) {
          setTaskCounts((previous) => (previous === null ? previous : null));
          return;
        }
        const counts: TaskCounts = {
          pending: 0,
          inProgress: 0,
          completed: 0,
          blocked: 0,
          failed: 0,
        };
        for (const task of parsed.tasks) {
          if (task?.status === 'completed') counts.completed++;
          else if (task?.status === 'in_progress') counts.inProgress++;
          else if (task?.status === 'blocked') counts.blocked++;
          else if (task?.status === 'failed') counts.failed++;
          else counts.pending++;
        }
        const total = Object.values(counts).reduce((sum, count) => sum + count, 0);
        const next = total > 0 ? counts : null;
        setTaskCounts((previous) => (sameTaskCounts(previous, next) ? previous : next));
      } catch {
        if (!cancelled) {
          lastFingerprint = '';
          setTaskCounts((previous) => (previous === null ? previous : null));
        }
      }
    };
    void poll();
    const id = setInterval(poll, 3000);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [taskPath, taskHidden]);

  // Dropped-tool count: how many tools the provider's maxTools limit will
  // remove from the next request. 0 when the provider has no limit or the
  // registered tool count is within the limit. Surfaced in the StatusBar as
  // a chip so the user knows tools were omitted.
  const providerMaxTools = (agent.ctx.provider as { maxToolsCount?: number }).maxToolsCount ?? 0;
  const droppedTools =
    providerMaxTools > 0 ? Math.max(0, (agent.ctx.tools?.length ?? 0) - providerMaxTools) : 0;

  // Cache stats — prefer the live refresh snapshot (which subscribes to
  // `token.accounted`) so the sidebar reflects async provider responses
  // without waiting for an unrelated re-render. Fall back to a direct
  // counter read so legacy callers that don't pass `tokenRefresh` still
  // see something other than zeros.
  //
  // Zeroed during a resume: the counter still holds the LEAVING session's
  // lifetime cache totals until the host's `token_accounting` stage resets it
  // and re-accounts the resumed journal's usage, so the card would otherwise
  // advertise another conversation's hit ratio underneath the loading block.
  const cacheStats: CacheStats = resuming
    ? { readTokens: 0, writeTokens: 0, hitRatio: 0, savedUsd: 0 }
    : (tokenRefresh?.cacheStats ??
      tokenCounter?.cacheStats?.() ?? { readTokens: 0, writeTokens: 0, hitRatio: 0, savedUsd: 0 });

  // Cache coverage: the cached prefix of the most recent prompt, capped at
  // the live request's `used` total so it never exceeds what is actually
  // being sent. Falls back to the per-request `cacheRead` when no refresh
  // snapshot is available. Surfaced as a marker on the context window
  // detail so users can see "cache covers the first N tokens" rather
  // than guessing from a percentage.
  const requestCacheRead = resuming
    ? 0
    : (tokenRefresh?.currentRequest?.cacheRead ?? perRequest?.cacheRead ?? 0);
  const cacheCoverageTokens = Math.max(0, Math.min(currentContextTokens, requestCacheRead));

  return {
    contextBreakdown,
    currentContextTokens,
    contextWindow,
    cacheStats,
    cacheCoverageTokens,
    todos,
    fleetCounts,
    visibleSubagentCount,
    hasVisibleFleetPanel,
    entriesWithLeader,
    planCounts,
    taskCounts,
    droppedTools,
  };
}
