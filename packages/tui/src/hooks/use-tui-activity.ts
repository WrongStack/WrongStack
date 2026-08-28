import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import type { Agent, InputBuilder } from '@wrongstack/core/agent';
import { loadGoal } from '@wrongstack/core/storage';
import type { AttachmentStore } from '@wrongstack/core/types';
import { resolveWstackPaths } from '@wrongstack/core/utils';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { Action, State } from '../app-reducer.js';
import { type HeapSample, startSharedHeapWatchdog, takeHeapSample } from '../heap-watchdog.js';
import { useAnimation } from '../ink.js';
import { isRandomTuiThinkingWord, pickRandomTuiThinkingWord } from '../thinking-word.js';
import { recordTuiAppRender, snapshotTuiMemoryCounters } from '../tui-memory-counters.js';

/**
 * Stat-fingerprint sentinel meaning "the goal file did not exist on the last
 * check". Distinct from `undefined` (never checked) so the chip-clearing
 * dispatch runs exactly once instead of every tick.
 */
const GOAL_FILE_MISSING = 'missing';

// ── Shallow retention sentinels (RAM audit) ────────────────────────────────
// Each helper reads a known Map/Array length without traversing the graph,
// so the watchdog tick stays O(1) regardless of session size. Used by
// collectStats so heap.jsonl shows exactly which layer holds the bytes
// after `/clear` or `--resume` boots.

/** Number of attachments stored in the canonical AttachmentStore. */
function attachmentsSize(store: AttachmentStore): number {
  // DefaultAttachmentStore exposes `items: Map<string, Attachment>` and
  // `refs: AttachmentRef[]`. The Map.size read is O(1); we prefer it
  // because `items` is the cumulative-keep map. Refs can grow during a
  // burst but always settles with items.
  const items = (store as unknown as { items?: { size?: number } }).items;
  return items?.size ?? 0;
}

/** Number of attachment refs retained by the mounted InputBuilder. */
function builderRefsLength(builder: InputBuilder | null): number {
  if (!builder) return 0;
  const refs = (builder as unknown as { refs?: { length?: number } }).refs;
  return refs?.length ?? 0;
}

/**
 * In-flight coordinator task count for the live Director — used to detect
 * that `/clear` did not actually drain subagent work. Zero when the
 * Director is the fleet-manager path (coordinator lives on `Director`,
 * not on the standalone MultiAgentCoordinator).
 */
function directorInFlight(ctx: Agent['ctx']): number {
  const directorCtx = ctx as unknown as { director?: { coordinator?: { inFlight?: number } } };
  return directorCtx.director?.coordinator?.inFlight ?? 0;
}

// Cached once at module init: `os.cpus()` allocates a fresh array on every
// call (Node.js libuv malloc), and the TUI shell computes CPU usage on every
// 10s tick (`useMemo` keyed on `nowTick`). The number of cores does not
// change for the lifetime of the process, so hoist it out of the per-tick
// path entirely — turning per-tick allocation + property access into a
// constant-fold.
const CPU_CORES = os.cpus().length || 1;

// Physical RAM total, cached once — stable for the process lifetime. The
// sidebar SYSTEM card ratios RSS against this to show the process's honest
// share of physical memory (the HeapSample.load field only measures V8 heap
// pressure, which understates RSS).
const TOTAL_MEM = os.totalmem() || 1;

/** Cap for the sidebar trend sparklines. 24 samples at the 10s shell tick
 *  ≈ 4 minutes of history — enough to read a trend, small enough that three
 *  capped arrays cost nothing per tick. */
const MAX_METRIC_HISTORY = 24;

/** Append one sample to a capped history buffer, dropping the oldest. */
function pushMetricHistory<T>(buffer: T[], value: T): void {
  buffer.push(value);
  if (buffer.length > MAX_METRIC_HISTORY) buffer.shift();
}

interface UseTuiActivityOptions {
  status: State['status'];
  fleet: State['fleet'];
  enhanceBusy: boolean;
  thinkingWord: string;
  projectRoot: string;
  stateRef: React.RefObject<State>;
  agentContext: Agent['ctx'];
  dispatch: React.Dispatch<Action>;
  /** Attachment store for RAM-retention sentinels in heap diagnostics. */
  attachments: AttachmentStore;
  /** Input builder ref for RAM-retention sentinels in heap diagnostics. */
  builderRef: React.RefObject<InputBuilder | null>;
}

/**
 * Own the clocks and lightweight activity animation state used by the TUI
 * shell. Keeping these related timers together prevents the app component
 * from accumulating another cluster of lifecycle bookkeeping.
 */
export function useTuiActivity({
  status,
  fleet,
  enhanceBusy,
  thinkingWord,
  projectRoot,
  stateRef,
  agentContext,
  dispatch,
  attachments,
  builderRef,
}: UseTuiActivityOptions) {
  recordTuiAppRender();
  const [rolledThinkingWord, setRolledThinkingWord] = useState(() => pickRandomTuiThinkingWord());
  const thinkingWorking = status === 'running' || status === 'streaming';
  const prevThinkingWorkingRef = useRef(false);
  useEffect(() => {
    if (thinkingWorking && !prevThinkingWorkingRef.current) {
      setRolledThinkingWord((previous) => pickRandomTuiThinkingWord(previous));
    }
    prevThinkingWorkingRef.current = thinkingWorking;
  }, [thinkingWorking]);

  const displayThinkingWord = isRandomTuiThinkingWord(thinkingWord)
    ? rolledThinkingWord
    : thinkingWord;
  const fleetRunningCount = useMemo(
    () => Object.values(fleet).filter((entry) => entry.status === 'running').length,
    [fleet],
  );

  // Global clock tick. Deliberately slow (10s). Detail panels own their
  // faster clocks; this tick feeds monitor overlays and todo snapshots.
  const startedAtRef = useRef(Date.now());

  const [nowTick, setNowTick] = useState(Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNowTick(Date.now()), 10_000);
    return () => clearInterval(timer);
  }, []);

  // Track foreground agent working time across running/streaming spells.
  const [workingTimeBase, setWorkingTimeBase] = useState(0);
  const workingStartRef = useRef<number | null>(null);
  const prevStatusRef = useRef(status);
  useEffect(() => {
    if (prevStatusRef.current === status) return;

    const wasWorking = prevStatusRef.current === 'running' || prevStatusRef.current === 'streaming';
    const isWorking = status === 'running' || status === 'streaming';
    if (wasWorking && !isWorking) {
      const delta = Date.now() - (workingStartRef.current ?? Date.now());
      workingStartRef.current = null;
      setWorkingTimeBase((base) => base + delta);
    } else if (!wasWorking && isWorking) {
      workingStartRef.current = Date.now();
    }
    prevStatusRef.current = status;
  }, [status]);

  // Track the time during which at least one background fleet entry is active.
  const [fleetWorkingBase, setFleetWorkingBase] = useState(0);
  const fleetWorkingStartRef = useRef<number | null>(null);
  const prevFleetRunningRef = useRef(0);
  useEffect(() => {
    const running = fleetRunningCount;
    if (prevFleetRunningRef.current === running) return;

    const wasRunning = prevFleetRunningRef.current > 0;
    const isRunning = running > 0;
    if (wasRunning && !isRunning) {
      const delta = Date.now() - (fleetWorkingStartRef.current ?? Date.now());
      fleetWorkingStartRef.current = null;
      setFleetWorkingBase((base) => base + delta);
    } else if (!wasRunning && isRunning) {
      fleetWorkingStartRef.current = Date.now();
    }
    prevFleetRunningRef.current = running;
  }, [fleetRunningCount]);

  // Foreground and fleet elapsed clocks used to own independent 1s intervals,
  // causing two root renders per second whenever both were active. The enhance
  // animation (the loading-dot cycle shown by `setEnhanceBusy`) used to own a
  // SECOND independent 1s interval — so an active enhance with no leader/fleet
  // work still triggered a re-render every second. One shared Ink animation
  // tick is sufficient to derive both values; include `enhanceBusy` so the
  // dots animation keeps ticking when enhance is the only thing active.
  const timingActive = thinkingWorking || fleetRunningCount > 0;
  const enhanceActive = enhanceBusy;
  const { frame: timingFrame } = useAnimation({
    interval: 1_000,
    isActive: timingActive || enhanceActive,
  });
  const timingNow = Date.now();
  const workingTimeMs =
    workingStartRef.current === null
      ? workingTimeBase
      : workingTimeBase + (timingNow - workingStartRef.current);
  const fleetWorkingTimeMs =
    fleetWorkingStartRef.current === null
      ? fleetWorkingBase
      : fleetWorkingBase + (timingNow - fleetWorkingStartRef.current);

  // Sidebar SYSTEM-card trend buffers (one capped array per metric, fed by
  // the memos below). Declared before the memos: React runs a useMemo
  // factory during the same render pass, so these must exist before the
  // processMemory memo that pushes into them.
  const rssHistoryRef = useRef<number[]>([]);
  const heapHistoryRef = useRef<number[]>([]);

  // Attribute long-session heap growth before V8 reaches its hard limit.
  // Reuse the existing 10s shell clock so diagnostics do not add another
  // timer or idle render loop just to refresh the status-line chip.
  const processMemory = useMemo<HeapSample>(() => {
    const sample = takeHeapSample();
    // Feed the sidebar SYSTEM card's trend sparklines. Ratios are 0..1:
    // RSS against physical RAM (TOTAL_MEM), heap against its V8 limit
    // (sample.load). Ref mutation during render follows the cpuPrevRef
    // pattern below — this memo runs exactly once per nowTick change.
    pushMetricHistory(rssHistoryRef.current, Math.min(1, sample.rss / TOTAL_MEM));
    pushMetricHistory(heapHistoryRef.current, Math.min(1, sample.load));
    return sample;
  }, [nowTick]);
  // CPU usage percentage (0-100) for this Node.js process. Uses process.cpuUsage()
  // delta between ticks, normalized by elapsed wall-clock time and core count.
  // Works on all platforms (including Windows where os.loadavg() returns 0).
  // Reuse nowTick (10s clock) for refresh cadence.
  const cpuPrevRef = useRef<{ cpu: NodeJS.CpuUsage; time: bigint } | null>(null);
  const cpuHistoryRef = useRef<number[]>([]);
  const cpuPercent = useMemo<number | undefined>(() => {
    const now = process.hrtime.bigint();
    const cpuNow = process.cpuUsage();
    const prev = cpuPrevRef.current;
    cpuPrevRef.current = { cpu: cpuNow, time: now };
    if (!prev) return undefined; // First tick — no baseline yet
    const cpuDeltaUsec = cpuNow.user - prev.cpu.user + (cpuNow.system - prev.cpu.system);
    const wallMs = Number(now - prev.time) / 1e6;
    if (wallMs <= 0) return undefined;
    // cpuDeltaUsec is in microseconds; wall time in ms. Ratio gives core-utilization.
    // CPU_CORES is cached at module init — see top of file. Using the cached
    // constant avoids an os.cpus() call + array allocation per 10s tick.
    const pct = Math.min(100, Math.round((cpuDeltaUsec / 1000 / wallMs / CPU_CORES) * 100));
    // Feed the sidebar SYSTEM card's CPU trend sparkline (0..1 ratio).
    pushMetricHistory(cpuHistoryRef.current, pct / 100);
    return pct;
  }, [nowTick]);
  useEffect(() => {
    const stopHeapWatchdog = startSharedHeapWatchdog({
      collectStats: () => {
        const currentState = stateRef.current;
        const messages = agentContext.state.messages;
        return {
          surface: 'tui',
          sessionId: agentContext.session.id,
          // Keep this slice to shallow cardinalities: serializing the full
          // retained graphs created a second allocation spike precisely when
          // the heap was already high.
          historyEntries: currentState.entries.length,
          messages: messages.length,
          runningTools: currentState.runningTools.size,
          stdoutQueued: process.stdout.writableLength ?? 0,
          fleetSize: Object.keys(currentState.fleet ?? {}).length,
          queued: currentState.queue?.length ?? 0,
          inputHistory: currentState.inputHistory?.length ?? 0,
          toolStreamChars: currentState.toolStream?.text.length ?? 0,
          ...snapshotTuiMemoryCounters(),
          // RAM retention sentinels — distinguish which layer holds old graphs
          // after /clear so we know where to add cleanup wiring.
          // attachments: DefaultAttachmentStore.items.size (cumulative
          //   pastes/files/images for the lifetime of this process).
          // builderRefs: InputBuilder.refs.length (refs retained by the
          //   mounted builder until reset() is called).
          // directorInFlight: coordinator in-flight task count, used to
          //   detect that `/clear` did not actually drain subagent work.
          attachments: attachmentsSize(attachments),
          builderRefs: builderRefsLength(builderRef.current),
          directorInFlight: directorInFlight(agentContext),
        };
      },
      onWarn: (level, message) => {
        dispatch({
          type: 'addEntry',
          entry: { kind: level === 'critical' ? 'error' : 'warn', text: message },
        });
      },
    });
    return () => {
      void stopHeapWatchdog();
    };
  }, [agentContext, dispatch, stateRef, attachments, builderRef]);

  const goalSummaryFingerprintRef = useRef<string | undefined>(undefined);
  const goalSummaryGenerationRef = useRef(0);
  /**
   * mtime+size of the goal file as of the last read. The 10s `nowTick` drives
   * this refresh for the whole session, and the summary fingerprint below only
   * gates the *dispatch* — without this stat the goal file was parsed off disk
   * six times a minute forever, whether or not it had changed. Callers that
   * write the goal (submit-controller, autonomy drivers) still get through:
   * their write moves mtime.
   */
  const goalStatFingerprintRef = useRef<string | undefined>(undefined);
  const refreshGoalSummary = useCallback(() => {
    const generation = ++goalSummaryGenerationRef.current;
    if (!projectRoot) return;
    const goalPath = resolveWstackPaths({ projectRoot }).projectGoal;
    fs.stat(goalPath)
      .then(
        (stat) => {
          const statFingerprint = `${stat.mtimeMs}:${stat.size}`;
          if (statFingerprint === goalStatFingerprintRef.current) return undefined;
          goalStatFingerprintRef.current = statFingerprint;
          return loadGoal(goalPath);
        },
        () => {
          // No goal file (or unreadable). Clear the chip once, then stay quiet
          // until one appears — a goal-less project must not pay a read per
          // tick. `null` falls into the clear branch below.
          if (goalStatFingerprintRef.current === GOAL_FILE_MISSING) return undefined;
          goalStatFingerprintRef.current = GOAL_FILE_MISSING;
          return null;
        },
      )
      .then((goal) => {
        if (goal === undefined) return; // Unchanged on disk — nothing to do.
        if (generation !== goalSummaryGenerationRef.current) return;
        if (!goal) {
          if (goalSummaryFingerprintRef.current === 'null') return;
          goalSummaryFingerprintRef.current = 'null';
          dispatch({ type: 'goalSummary', summary: null });
          return;
        }
        const lastEntry = goal.journal?.[goal.journal.length - 1];
        const summary = {
          goal: goal.goal,
          refinedGoal: goal.refinedGoal,
          goalState: goal.goalState ?? 'active',
          iterations: goal.iterations,
          progress: goal.progress,
          progressNote: goal.progressNote,
          progressTrend: goal.progressTrend,
          deliverables: goal.deliverables,
          lastTask: lastEntry?.task,
          lastStatus: lastEntry?.status,
        };
        const fingerprint = JSON.stringify(summary);
        if (goalSummaryFingerprintRef.current === fingerprint) return;
        goalSummaryFingerprintRef.current = fingerprint;
        dispatch({
          type: 'goalSummary',
          summary,
        });
      })
      .catch(() => {
        // Unreadable or partially written goal files leave the prior summary intact.
      });
  }, [dispatch, projectRoot]);

  useEffect(() => {
    refreshGoalSummary();
  }, [nowTick, refreshGoalSummary]);

  // Enhance dots share the timingFrame animation tick declared above. When
  // enhance is the only active consumer, isActive still keeps the tick alive
  // (timingActive || enhanceActive), so timingFrame keeps advancing and the
  // dots animate. When nothing is active, both pause together — a single
  // animation interval instead of two independent ones.
  const enhanceDots = enhanceBusy ? timingFrame % 36 : 0;

  return {
    displayThinkingWord,
    startedAt: startedAtRef.current,
    nowTick,
    setNowTick,
    workingTimeMs,
    fleetWorkingTimeMs,
    processMemory,
    cpuPercent,
    cpuHistory: cpuHistoryRef.current,
    rssHistory: rssHistoryRef.current,
    heapHistory: heapHistoryRef.current,
    totalMem: TOTAL_MEM,
    enhanceDots,
    refreshGoalSummary,
  };
}
