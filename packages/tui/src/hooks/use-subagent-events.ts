import type { EventBus } from '@wrongstack/core/kernel';
import type { FleetChatVerbosity } from '@wrongstack/core/types';
import { expectDefined } from '@wrongstack/core/utils';
import { useCallback, useEffect, useRef } from 'react';
import type { Action } from '../app-reducer.js';
import { formatSubagentCompletionText } from './subagent-history-format.js';
import { useFleetGenerationGate } from './use-fleet-generation-gate.js';

const STREAM_COLORS = ['cyan', 'magenta', 'yellow', 'green', 'blue'];

interface CompactionHistoryEvent {
  sessionId?: string | undefined;
  level: 'warn' | 'soft' | 'hard';
  report: {
    before: number;
    after: number;
    fullRequestTokensBefore?: number | undefined;
    fullRequestTokensAfter?: number | undefined;
  };
}

export function providerContextLimitHistoryEntry(event: {
  providerId: string;
  modelId: string;
  maxContext: number;
  previousMaxContext?: number | undefined;
  source?: 'configured' | 'provider' | 'provider_overflow' | undefined;
  decreased?: boolean | undefined;
}): { kind: 'warn'; text: string } | null {
  if (
    event.source !== 'provider' ||
    event.decreased !== true ||
    typeof event.previousMaxContext !== 'number' ||
    event.previousMaxContext <= event.maxContext
  ) {
    return null;
  }
  return {
    kind: 'warn',
    text:
      `⚠ provider context limit changed: ${event.previousMaxContext.toLocaleString('en-US')} → ` +
      `${event.maxContext.toLocaleString('en-US')} tokens (${event.providerId}/${event.modelId}). ` +
      'Preflight recovery now uses the lower limit.',
  };
}

export function compactionHistoryEntry(
  event: CompactionHistoryEvent,
  currentSessionId?: string | undefined,
): { kind: 'info' | 'warn'; text: string } | null {
  if (event.sessionId && currentSessionId && event.sessionId !== currentSessionId) return null;
  const before = event.report.fullRequestTokensBefore ?? event.report.before;
  const after = event.report.fullRequestTokensAfter ?? event.report.after;
  const saved = before - after;
  if (saved === 0) return null;
  if (saved < 0) {
    return {
      kind: 'warn',
      text: `⚠️ compact: context grew by ${-saved} tokens [${event.level}]`,
    };
  }
  const minimumUsefulSaving = Math.max(1_000, Math.ceil(before * 0.005));
  if (saved < minimumUsefulSaving) return null;
  return {
    kind: 'info',
    text: `⚡ compact: ${before} → ${after} tokens (−${saved}) [${event.level}]`,
  };
}

function labelFor(
  labelsRef: React.MutableRefObject<Map<string, { label: string; color: string }>>,
  id: string,
  name?: string | undefined,
): { label: string; color: string } {
  const m = labelsRef.current;
  const existing = m.get(id);
  if (existing) return existing;
  const n = m.size + 1;
  const v = {
    label: name && name !== id ? name : `AGENT#${n}`,
    color: expectDefined(STREAM_COLORS[(n - 1) % STREAM_COLORS.length]),
  };
  m.set(id, v);
  return v;
}

/**
 * Subagent lifecycle events → TUI dispatch bridge.
 * Wired to EventBus so both director and non-director /spawn runs surface in chat.
 *
 * Chat entries are gated by `getChatMode` (fleet-chat verbosity):
 * - 'full'    — every lifecycle line (legacy behavior).
 * - 'off'     — only non-success completions (✗/⏱/⊘); failures never go
 *               silent. All fleet-table dispatches run in every mode.
 */
export function useSubagentEvents(
  events: EventBus,
  dispatch: React.Dispatch<Action>,
  setActiveMaxContext: (v: number | undefined) => void,
  getSessionId?: (() => string | undefined) | undefined,
  getChatMode?: (() => FleetChatVerbosity) | undefined,
  sessionGenerationRef?: { current: number } | undefined,
): void {
  const labelsRef = useRef<Map<string, { label: string; color: string }>>(new Map());
  const ctxDispatchRef = useRef<
    Map<string, { at: number; load: number; tokens?: number; max?: number }>
  >(new Map());
  const leaderCtxDispatchRef = useRef<
    { at: number; load: number; tokens?: number; max?: number } | undefined
  >(undefined);
  // Pending trailing-edge flushes for the 250ms ctx-fill rate limit below.
  // Without these the throttle was leading-edge only: a `ctx.pct` arriving
  // inside the window was dropped and never re-delivered, so when the last
  // emit of a turn landed within 250ms of the previous one (common — a
  // tool-only iteration can finish in tens of milliseconds) the statusline
  // chip and the /context panel kept showing the older, lower reading until
  // the next turn happened to emit outside a window.
  const leaderCtxFlushRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  // Latest-values buffer for the leader `ctx.pct` trailing-flush. The timer
  // callback runs after potentially newer events, so we read the most recent
  // payload here instead of capturing the outer `e` in closure.
  const latestLeaderCtxPctRef = useRef<
    { load: number; tokens: number; maxContext: number } | undefined
  >(undefined);
  const ctxFlushRef = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map());
  const gate = useFleetGenerationGate(sessionGenerationRef);
  const lbl = useCallback(
    (id: string, name?: string) => labelFor(labelsRef, id, name),
    [], // labelsRef is a stable ref
  );

  useEffect(() => {
    // Track every subagent id this effect lifetime touches so teardown can
    // clear the component-level refs (labelsRef, ctxDispatchRef) for them.
    // Without this, an effect re-run (dep change) leaks entries from
    // subagents that were spawned but never removed in the old lifetime.
    const seen = new Set<string>();
    // Permissive predicate: events without a sessionId OR with no
    // current session always apply. Distinct from
    // `sidebar-content.tsx`'s exported `isCurrentSession`, which is
    // strict on the rowId argument (returns false when rowId is
    // undefined; falls back to fallbackIsCurrent only when rowId is
    // defined). See commit 295bd53fa.
    const isCurrentSession = (sessionId?: string | undefined): boolean => {
      const current = getSessionId?.();
      return !sessionId || !current || sessionId === current;
    };
    // Read at event time so a live `/agents chat` flip applies immediately
    // without re-subscribing. Absent getter = legacy full behavior.
    const mode = (): FleetChatVerbosity => getChatMode?.() ?? 'full';
    const offSpawned = events.on('subagent.spawned', (e) => {
      if (!isCurrentSession(e.sessionId)) return;
      // Record the session generation at spawn time so post-/clear events
      // from this agent can be detected and discarded.
      if (sessionGenerationRef) gate.track(e.subagentId);
      seen.add(e.subagentId);
      const l = lbl(e.subagentId, e.name);
      dispatch({
        type: 'fleetSpawn',
        id: e.subagentId,
        name: e.name,
        provider: e.provider,
        model: e.model,
        transcriptPath: e.transcriptPath,
      });
      if (mode() !== 'off') {
        const where = e.provider && e.model ? `${e.provider}/${e.model}` : 'spawned';
        const desc = e.description ? ` — ${e.description.slice(0, 80)}` : '';
        dispatch({
          type: 'addEntry',
          entry: {
            kind: 'subagent',
            agentLabel: l.label,
            agentColor: l.color,
            icon: '▶',
            text: `${where}${desc}`,
          },
        });
      }
    });

    // Background learning distillation. Nobody triggered it, so without a line
    // here the roster silently gets better and the user never learns that its
    // skills changed under them.
    const offLearningOptimized = events.on('agent.learning.optimized', (e) => {
      if (!isCurrentSession(e.sessionId)) return;
      if (mode() === 'off') return;
      if (e.status !== 'optimized' && e.status !== 'no-llm') return;
      const l = lbl(e.role);
      const skills = e.skills.length > 0 ? ` — skills: ${e.skills.join(', ')}` : '';
      dispatch({
        type: 'addEntry',
        entry: {
          kind: 'subagent',
          agentLabel: l.label,
          agentColor: l.color,
          icon: '✦',
          text: `learning distilled into project skills${skills}`,
        },
      });
    });

    const offStarted = events.on('subagent.task_started', (e) => {
      if (!isCurrentSession(e.sessionId)) return;
      if (!gate.isLive(e.subagentId)) return;
      seen.add(e.subagentId);
      const l = lbl(e.subagentId);
      dispatch({ type: 'fleetStart', id: e.subagentId, taskId: e.taskId });
      if (mode() === 'full') {
        const desc = e.description ? ` — ${e.description.slice(0, 80)}` : '';
        dispatch({
          type: 'addEntry',
          entry: {
            kind: 'subagent',
            agentLabel: l.label,
            agentColor: l.color,
            icon: '●',
            text: `task started${desc}`,
          },
        });
      }
    });

    const offCompleted = events.on('subagent.task_completed', (e) => {
      if (!isCurrentSession(e.sessionId)) return;
      if (!gate.isLive(e.subagentId)) return;
      seen.add(e.subagentId);
      const l = lbl(e.subagentId);
      const errKind = e.error?.kind;
      dispatch({
        type: 'fleetDone',
        id: e.subagentId,
        status: e.status,
        iterations: e.iterations,
        toolCalls: e.toolCalls,
        failureReason: errKind,
      });
      const icon =
        e.status === 'success'
          ? '✓'
          : e.status === 'timeout' || errKind === 'budget_timeout'
            ? '⏱'
            : e.status === 'stopped' || errKind === 'aborted_by_parent'
              ? '⊘'
              : '✗';
      // In 'off' mode only non-success completions surface — failures must
      // never be silent even when fleet chat is fully muted.
      if (mode() !== 'off' || e.status !== 'success') {
        dispatch({
          type: 'addEntry',
          entry: {
            kind: 'subagent',
            agentLabel: l.label,
            agentColor: l.color,
            icon,
            text: formatSubagentCompletionText({
              status: e.status,
              iterations: e.iterations,
              toolCalls: e.toolCalls,
              durationMs: e.durationMs,
              error: e.error,
            }),
          },
        });
      }
    });

    const offRemoved = events.on('subagent.removed', (e) => {
      if (!isCurrentSession(e.sessionId)) return;
      seen.delete(e.subagentId);
      labelsRef.current.delete(e.subagentId);
      ctxDispatchRef.current.delete(e.subagentId);
      const pendingFlush = ctxFlushRef.current.get(e.subagentId);
      if (pendingFlush) {
        clearTimeout(pendingFlush);
        ctxFlushRef.current.delete(e.subagentId);
      }
      gate.forget(e.subagentId);
      dispatch({ type: 'fleetRemove', id: e.subagentId });
    });

    const offBudgetWarning = events.on('subagent.budget_warning', (e) => {
      if (!isCurrentSession(e.sessionId)) return;
      if (!gate.isLive(e.subagentId)) return;
      seen.add(e.subagentId);
      const l = lbl(e.subagentId);
      dispatch({
        type: 'fleetBudgetWarning',
        id: e.subagentId,
        kind: e.kind,
        used: e.used,
        limit: e.limit,
      });
      const m = mode();
      const show = m === 'full';
      if (show) {
        // full mode only — keep short; the fleet panel already tracks the warning.
        const verb =
          e.kind === 'timeout' || e.kind === 'idle_timeout'
            ? 'near timeout'
            : `near ${e.kind.replace(/_/g, ' ')} limit`;
        dispatch({
          type: 'addEntry',
          entry: {
            kind: 'subagent',
            agentLabel: l.label,
            agentColor: l.color,
            icon: '⚡',
            text: verb,
          },
        });
      }
    });

    const offBudgetExtended = events.on('subagent.budget_extended', (e) => {
      if (!isCurrentSession(e.sessionId)) return;
      if (!gate.isLive(e.subagentId)) return;
      seen.add(e.subagentId);
      const l = lbl(e.subagentId);
      dispatch({
        type: 'fleetBudgetExtended',
        id: e.subagentId,
        totalExtensions: e.totalExtensions,
      });
      if (mode() === 'full') {
        const kindLabel = String(e.kind).replace(/_/g, ' ');
        dispatch({
          type: 'addEntry',
          entry: {
            kind: 'subagent',
            agentLabel: l.label,
            agentColor: l.color,
            icon: '⚡',
            text: `extended ${kindLabel} (×${e.totalExtensions})`,
          },
        });
      }
    });

    const offIterationSummary = events.on('subagent.iteration_summary', (e) => {
      if (!isCurrentSession(e.sessionId)) return;
      if (!gate.isLive(e.subagentId)) return;
      seen.add(e.subagentId);
      if (mode() !== 'full') return;
      const l = lbl(e.subagentId);
      const costStr = e.costUsd > 0 ? ` · ${e.costUsd.toFixed(4)}` : '';
      const toolStr = e.currentTool ? ` · doing ${e.currentTool}` : '';
      const partial = e.partialText
        ? ` · "${e.partialText.slice(0, 60)}${e.partialText.length > 60 ? '…' : ''}"`
        : '';
      dispatch({
        type: 'addEntry',
        entry: {
          kind: 'subagent',
          agentLabel: l.label,
          agentColor: l.color,
          icon: '💬',
          text: `L${e.iteration} · ${e.toolCalls} tools${costStr}${toolStr}${partial}`,
        },
      });
    });

    const offCtxPct = events.on('subagent.ctx_pct', (e) => {
      if (!isCurrentSession(e.sessionId)) return;
      if (!gate.isLive(e.subagentId)) return;
      seen.add(e.subagentId);
      const emit = (): void => {
        ctxDispatchRef.current.set(e.subagentId, {
          at: Date.now(),
          load: e.load,
          tokens: e.tokens,
          max: e.maxContext,
        });
        dispatch({
          type: 'fleetCtxPct',
          id: e.subagentId,
          load: e.load,
          tokens: e.tokens,
          maxContext: e.maxContext,
        });
      };
      const previous = ctxDispatchRef.current.get(e.subagentId);
      const elapsed = previous ? Date.now() - previous.at : Number.POSITIVE_INFINITY;
      if (elapsed < 250) {
        // Rate-limited: re-arm a trailing flush so the newest reading still
        // lands. Replacing the pending timer keeps only the latest value.
        const pending = ctxFlushRef.current.get(e.subagentId);
        if (pending) clearTimeout(pending);
        const timer = setTimeout(() => {
          ctxFlushRef.current.delete(e.subagentId);
          if (!gate.isLive(e.subagentId)) return;
          emit();
        }, 250 - elapsed);
        timer.unref?.();
        ctxFlushRef.current.set(e.subagentId, timer);
        return;
      }
      const pending = ctxFlushRef.current.get(e.subagentId);
      if (pending) {
        clearTimeout(pending);
        ctxFlushRef.current.delete(e.subagentId);
      }
      emit();
    });

    // NOTE: AgentMonitorService also emits `agent.timeline.message` (one event
    // per text delta) and `agent.status_changed`. We deliberately do NOT render
    // those to the main chat here: doing so fragmented a single streamed
    // subagent message into one chat bubble per delta ("1-2 words per line")
    // AND duplicated what is already shown — coarse lifecycle/iteration lines
    // come from the `subagent.*` host-bus events above, and the coalesced,
    // fleet-chat-mode-gated subagent text + tool entries come from
    // useDirectorFleetBridge. Those AgentMonitorService events still flow to
    // the HQ dashboard and per-subagent JSONL transcripts via their own
    // upstream consumers.

    const offConcurrencyChanged = events.on('concurrency.changed', (e: unknown) => {
      const { n, sessionId } = e as { n: number; sessionId?: string | undefined };
      if (!isCurrentSession(sessionId)) return;
      if (typeof n === 'number' && n > 0) {
        dispatch({ type: 'fleetConcurrency', n });
      }
    });

    const offLeaderCtxPct = events.on('ctx.pct', (e) => {
      if (!isCurrentSession(e.sessionId)) return;
      // Latest-values buffer for the trailing flush. Without this, the
      // timer captures `e` from the first rate-limited event and an older
      // reading wins when a newer event arrives before the timer fires.
      // Mirrors the `subagent.ctx_pct` branch's per-id buffer pattern.
      latestLeaderCtxPctRef.current = e;
      const emit = (): void => {
        const latest = latestLeaderCtxPctRef.current ?? e;
        leaderCtxDispatchRef.current = {
          at: Date.now(),
          load: latest.load,
          tokens: latest.tokens,
          max: latest.maxContext,
        };
        setActiveMaxContext(latest.maxContext);
        dispatch({
          type: 'leaderCtxPct',
          load: latest.load,
          tokens: latest.tokens,
          maxContext: latest.maxContext,
        });
      };
      const previous = leaderCtxDispatchRef.current;
      const elapsed = previous ? Date.now() - previous.at : Number.POSITIVE_INFINITY;
      if (elapsed < 250) {
        // Rate-limited: re-arm a trailing flush so the last emit of a turn is
        // never the one that gets dropped. Replacing the pending timer keeps
        // only the newest reading.
        if (leaderCtxFlushRef.current) clearTimeout(leaderCtxFlushRef.current);
        const timer = setTimeout(() => {
          leaderCtxFlushRef.current = undefined;
          emit();
        }, 250 - elapsed);
        timer.unref?.();
        leaderCtxFlushRef.current = timer;
        return;
      }
      if (leaderCtxFlushRef.current) {
        clearTimeout(leaderCtxFlushRef.current);
        leaderCtxFlushRef.current = undefined;
      }
      emit();
    });

    const offLeaderMaxContext = events.on('ctx.max_context', (e) => {
      if (!isCurrentSession(e.sessionId)) return;
      if (e.maxContext > 0) setActiveMaxContext(e.maxContext);
      const warning = providerContextLimitHistoryEntry(e);
      if (warning) dispatch({ type: 'addEntry', entry: warning });
    });

    const offCompactionFired = events.on('compaction.fired', (e) => {
      const entry = compactionHistoryEntry(e, getSessionId?.());
      if (entry) dispatch({ type: 'addEntry', entry });
    });

    const offTool = events.on('subagent.tool_executed', (e) => {
      if (!isCurrentSession(e.sessionId)) return;
      if (!gate.isLive(e.subagentId)) return;
      dispatch({
        type: 'fleetTool',
        id: e.subagentId,
        name: e.name,
        ok: e.ok,
        durationMs: e.durationMs,
        outputBytes: e.outputBytes,
      });
      dispatch({ type: 'fleetToolEnd', id: e.subagentId });
    });

    return () => {
      offSpawned();
      offLearningOptimized();
      offStarted();
      offCompleted();
      offRemoved();
      offBudgetWarning();
      offBudgetExtended();
      offIterationSummary();
      offCtxPct();
      offConcurrencyChanged();
      offLeaderCtxPct();
      offLeaderMaxContext();
      offCompactionFired();
      offTool();
      // Cancel pending trailing ctx-fill flushes — their `dispatch` closures
      // belong to this effect lifetime and would fire after the listeners are
      // gone (and, on a session switch, against the new session's reducer).
      if (leaderCtxFlushRef.current) {
        clearTimeout(leaderCtxFlushRef.current);
        leaderCtxFlushRef.current = undefined;
      }
      for (const timer of ctxFlushRef.current.values()) clearTimeout(timer);
      ctxFlushRef.current.clear();
      // Clear component-level ref entries for subagents tracked in this effect.
      // labelsRef and ctxDispatchRef are useRefs that outlive this effect;
      // without this, an effect re-run (dep change) leaks entries from
      // subagents that were spawned but never removed in the old lifetime.
      // Removed subagents already had their entries deleted in the
      // subagent.removed handler, so `seen` only holds un-removed ids.
      for (const id of seen) {
        labelsRef.current.delete(id);
        ctxDispatchRef.current.delete(id);
      }
    };
  }, [events, dispatch, setActiveMaxContext, getSessionId, getChatMode, lbl, gate]);
}
