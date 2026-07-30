import * as fs from 'node:fs/promises';
import { type ContextBreakdown, getContextBreakdown } from '@wrongstack/core/utils';
import { useEffect, useMemo, useState } from 'react';
import type { AppProps } from '../app-props.js';
import type { FleetEntry, State } from '../app-state.js';
import { resolveContextFill } from '../context-fill.js';

interface StatusbarViewModelOptions {
  agent: AppProps['agent'];
  tokenCounter: AppProps['tokenCounter'];
  activeMaxContext: number | undefined;
  effectiveMaxContext: number | undefined;
  liveProvider: string;
  liveModel: string;
  liveTodos: readonly { status: string }[];
  state: State;
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
  state,
}: StatusbarViewModelOptions): {
  contextBreakdown: ContextBreakdown | undefined;
  currentContextTokens: number;
  contextWindow: { used: number; max: number } | undefined;
  todos: { pending: number; inProgress: number; completed: number };
  fleetCounts: { running: number; idle: number; pending: number; completed: number } | undefined;
  visibleSubagentCount: number;
  hasVisibleFleetPanel: boolean;
  entriesWithLeader: Record<string, FleetEntry>;
  planCounts: PlanCounts | null;
  taskCounts: TaskCounts | null;
} {
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
  // Both conditions are independent: the panel can be open with a fresh
  // `currentRequestTokens` snapshot (and still want the breakdown), and the
  // panel can be closed while we still want the bar fallback. Compute the
  // breakdown whenever either signal is set.
  const needLocalEstimate = cheapFill.needsLocalEstimate;
  const panelWantsBreakdown = state.contextPanelOpen;
  const needBreakdown = needLocalEstimate || panelWantsBreakdown;

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
  const currentContextTokens = needLocalEstimate
    ? resolveContextFill({
        loopReportedTokens,
        perRequestTokens,
        localEstimate: contextBreakdown?.total,
        maxContext,
      }).used
    : cheapFill.used;
  const contextWindow = useMemo(() => {
    void state.contextChipVersion;
    return maxContext > 0 ? { used: currentContextTokens, max: maxContext } : undefined;
  }, [currentContextTokens, maxContext, state.contextChipVersion]);

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
    const running = entries.filter((entry) => entry.status === 'running').length;
    return running > 0 ? { running, idle: 0, pending: 0, completed: 0 } : undefined;
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

  const planPath = (agent.ctx.meta as Record<string, unknown>)['plan.path'];
  const [planCounts, setPlanCounts] = useState<PlanCounts | null>(null);
  useEffect(() => {
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
  }, [planPath]);

  const taskPath = (agent.ctx.meta as Record<string, unknown>)['task.path'];
  const [taskCounts, setTaskCounts] = useState<TaskCounts | null>(null);
  useEffect(() => {
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
  }, [taskPath]);

  return {
    contextBreakdown,
    currentContextTokens,
    contextWindow,
    todos,
    fleetCounts,
    visibleSubagentCount,
    hasVisibleFleetPanel,
    entriesWithLeader,
    planCounts,
    taskCounts,
  };
}
