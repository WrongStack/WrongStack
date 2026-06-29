import { expectDefined } from '@wrongstack/core';
import type { EventBus } from '@wrongstack/core';
import { useCallback, useEffect, useRef } from 'react';
import type { Action } from '../app-reducer.js';
const STREAM_COLORS = ['cyan', 'magenta', 'yellow', 'green', 'blue'];

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
 */
export function useSubagentEvents(
  events: EventBus,
  dispatch: React.Dispatch<Action>,
  setActiveMaxContext: (v: number | undefined) => void,
): void {
  const labelsRef = useRef<Map<string, { label: string; color: string }>>(new Map());
  const lbl = useCallback(
    (id: string, name?: string) => labelFor(labelsRef, id, name),
    [], // labelsRef is a stable ref
  );

  useEffect(() => {
    const offSpawned = events.on('subagent.spawned', (e) => {
      const l = lbl(e.subagentId, e.name);
      dispatch({ type: 'fleetSpawn', id: e.subagentId, name: e.name, provider: e.provider, model: e.model, transcriptPath: e.transcriptPath });
      const where = e.provider && e.model ? `${e.provider}/${e.model}` : 'spawned';
      const desc = e.description ? ` — ${e.description.slice(0, 80)}` : '';
      dispatch({ type: 'addEntry', entry: { kind: 'subagent', agentLabel: l.label, agentColor: l.color, icon: '▶', text: `${where}${desc}` } });
    });

    const offStarted = events.on('subagent.task_started', (e) => {
      const l = lbl(e.subagentId);
      dispatch({ type: 'fleetStart', id: e.subagentId, taskId: e.taskId });
      const desc = e.description ? ` — ${e.description.slice(0, 80)}` : '';
      dispatch({ type: 'addEntry', entry: { kind: 'subagent', agentLabel: l.label, agentColor: l.color, icon: '●', text: `task started${desc}` } });
    });

    const offCompleted = events.on('subagent.task_completed', (e) => {
      const l = lbl(e.subagentId);
      const errKind = e.error?.kind;
      dispatch({ type: 'fleetDone', id: e.subagentId, status: e.status, iterations: e.iterations, toolCalls: e.toolCalls, failureReason: errKind });
      const icon = e.status === 'success' ? '✓' : e.status === 'timeout' ? '⏱' : e.status === 'stopped' ? '⊘' : '✗';
      const errMsg = e.error?.message;
      const errMsgTail = errMsg ? ` — ${errMsg.replace(/\s+/g, ' ').slice(0, 100)}${errMsg.length > 100 ? '…' : ''}` : '';
      const errChip = errKind ? ` [${errKind}]` : '';
      const secs = (e.durationMs / 1000).toFixed(e.durationMs < 10_000 ? 1 : 0);
      dispatch({ type: 'addEntry', entry: { kind: 'subagent', agentLabel: l.label, agentColor: l.color, icon, text: `${e.status} (${e.iterations} iter · ${e.toolCalls} tools · ${secs}s)${errChip}${errMsgTail}` } });
    });

    const offBudgetWarning = events.on('subagent.budget_warning', (e) => {
      const l = lbl(e.subagentId);
      dispatch({ type: 'fleetBudgetWarning', id: e.subagentId, kind: e.kind, used: e.used, limit: e.limit });
      const timeoutSuffix = e.kind === 'timeout' ? ' (subagent continues running)' : ' — extending';
      dispatch({ type: 'addEntry', entry: { kind: 'subagent', agentLabel: l.label, agentColor: l.color, icon: '⚡', text: `hitting ${e.kind} limit (${e.used}/${e.limit})${timeoutSuffix}` } });
    });

    const offBudgetExtended = events.on('subagent.budget_extended', (e) => {
      const l = lbl(e.subagentId);
      dispatch({ type: 'fleetBudgetExtended', id: e.subagentId, totalExtensions: e.totalExtensions });
      dispatch({ type: 'addEntry', entry: { kind: 'subagent', agentLabel: l.label, agentColor: l.color, icon: '⚡', text: `extended ${e.kind} → ${e.newLimit} (×${e.totalExtensions})` } });
    });

    const offIterationSummary = events.on('subagent.iteration_summary', (e) => {
      const l = lbl(e.subagentId);
      const costStr = e.costUsd > 0 ? ` · ${e.costUsd.toFixed(4)}` : '';
      const toolStr = e.currentTool ? ` · doing ${e.currentTool}` : '';
      const partial = e.partialText ? ` · "${e.partialText.slice(0, 60)}${e.partialText.length > 60 ? '…' : ''}"` : '';
      dispatch({ type: 'addEntry', entry: { kind: 'subagent', agentLabel: l.label, agentColor: l.color, icon: '💬', text: `L${e.iteration} · ${e.toolCalls} tools${costStr}${toolStr}${partial}` } });
    });

    const offCtxPct = events.on('subagent.ctx_pct', (e) => {
      dispatch({ type: 'fleetCtxPct', id: e.subagentId, load: e.load, tokens: e.tokens, maxContext: e.maxContext });
    });

    // NOTE: AgentMonitorService also emits `agent.timeline.message` (one event
    // per text delta) and `agent.status_changed`. We deliberately do NOT render
    // those to the main chat here: doing so fragmented a single streamed
    // subagent message into one chat bubble per delta ("1-2 words per line")
    // AND duplicated what is already shown — coarse lifecycle/iteration lines
    // come from the `subagent.*` host-bus events above, and the coalesced,
    // streamFleet-gated subagent text + tool entries come from
    // useDirectorFleetBridge. Those AgentMonitorService events still flow to
    // the HQ dashboard and per-subagent JSONL transcripts via their own
    // upstream consumers.

    const offConcurrencyChanged = events.on('concurrency.changed', (e: unknown) => {
      const { n } = e as { n: number };
      if (typeof n === 'number' && n > 0) {
        dispatch({ type: 'fleetConcurrency', n });
      }
    });

    const offLeaderCtxPct = events.on('ctx.pct', (e) => {
      setActiveMaxContext(e.maxContext);
      dispatch({ type: 'leaderCtxPct', load: e.load, tokens: e.tokens, maxContext: e.maxContext });
    });

    const offLeaderMaxContext = events.on('ctx.max_context', (e) => {
      if (e.maxContext > 0) setActiveMaxContext(e.maxContext);
    });

    const offCompactionFired = events.on('compaction.fired', (e) => {
      const saved = e.report.before - e.report.after;
      let label: string;
      if (saved > 0) {
        label = `⚡ compact: ${e.report.before} → ${e.report.after} tokens (−${saved}) [${e.level}]`;
      } else if (saved < 0) {
        label = `⚠️ compact: context GREW by ${-saved} tokens [${e.level}]`;
      } else {
        label = '⚡ compact: no reduction needed';
      }
      dispatch({ type: 'addEntry', entry: { kind: 'warn', text: label } });
    });

    const offTool = events.on('subagent.tool_executed', (e) => {
      dispatch({ type: 'fleetTool', id: e.subagentId, name: e.name, ok: e.ok, durationMs: e.durationMs, outputBytes: e.outputBytes });
      dispatch({ type: 'fleetToolEnd', id: e.subagentId });
    });

    return () => {
      offSpawned(); offStarted(); offCompleted();
      offBudgetWarning(); offBudgetExtended();
      offIterationSummary(); offCtxPct(); offConcurrencyChanged();
      offLeaderCtxPct(); offLeaderMaxContext(); offCompactionFired();
      offTool();
    };
  }, [events, dispatch, setActiveMaxContext, lbl]);
}
