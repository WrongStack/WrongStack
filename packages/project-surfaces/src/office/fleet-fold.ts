import {
  appendTranscriptEntry,
  blankAgent,
  bumpSparkline,
  clampContextPct,
  type FleetTimelineEvent,
  pushTimeline,
  SPARKLINE_BINS,
  type SubagentEvent,
} from './fleet-transcript';
import type { AgentTranscriptEntry, SubagentView } from './types';

/** Roster cap — far above any real fleet; evicts terminal agents first. */
export const MAX_FLEET_AGENTS = 200;

let timelineSeq = 0;
function makeTimelineId(): string {
  return `tl_${Date.now()}_${++timelineSeq}`;
}

/** The part of a fleet roster that `subagent.event` frames change. */
export interface FleetFold {
  agents: Map<string, SubagentView>;
  leaderId: string | undefined;
  fleetTokensIn: number;
  fleetTokensOut: number;
  eventTimeline: FleetTimelineEvent[];
  agentTimeline: AgentTranscriptEntry[];
  agentTranscripts: Map<string, AgentTranscriptEntry[]>;
}

export interface FleetFoldOptions {
  /** The event's time; a replayed journal passes the frame's own time. Defaults to now. */
  now?: number | undefined;
  /** Cleans a subagent's final text before it is kept, for example of next-step blocks. */
  cleanFinalText?: ((text: string) => string) | undefined;
}

export const EMPTY_FLEET_FOLD: FleetFold = {
  agents: new Map(),
  leaderId: undefined,
  fleetTokensIn: 0,
  fleetTokensOut: 0,
  eventTimeline: [],
  agentTimeline: [],
  agentTranscripts: new Map(),
};

/**
 * Folds one `subagent.event` into the roster and returns the fields it changed: the agent's
 * telemetry, its transcript lines, the leader and the fleet token totals.
 */
export function applyFleetEvent(
  state: FleetFold,
  e: SubagentEvent,
  options: FleetFoldOptions = {},
): Partial<FleetFold> {
  const now = options.now ?? Date.now();
  const clean = options.cleanFinalText ?? ((text: string) => text);
  const agents = new Map(state.agents);
  const agentTranscripts = new Map(state.agentTranscripts);
  let timeline = state.eventTimeline;
  let leaderId = state.leaderId;
  let fleetTokensIn = state.fleetTokensIn;
  let fleetTokensOut = state.fleetTokensOut;

  // session_stopped carries a sessionId instead of subagentId —
  // remove ALL agents belonging to that session.
  if (e.kind === 'session_stopped' && e.sessionId) {
    const removedIds = new Set<string>();
    let droppedTokensIn = 0;
    let droppedTokensOut = 0;
    for (const [id, agent] of agents) {
      if (agent.sessionId === e.sessionId) {
        agents.delete(id);
        agentTranscripts.delete(id);
        removedIds.add(id);
        droppedTokensIn += agent.tokensIn ?? 0;
        droppedTokensOut += agent.tokensOut ?? 0;
      }
    }
    return {
      agents,
      agentTranscripts,
      agentTimeline: state.agentTimeline.filter((entry) => !removedIds.has(entry.subagentId)),
      eventTimeline: state.eventTimeline.filter((entry) => !removedIds.has(entry.agentId)),
      leaderId: state.leaderId && removedIds.has(state.leaderId) ? undefined : state.leaderId,
      fleetTokensIn: Math.max(0, state.fleetTokensIn - droppedTokensIn),
      fleetTokensOut: Math.max(0, state.fleetTokensOut - droppedTokensOut),
    };
  }

  if (e.kind === 'removed' && e.subagentId) {
    // Subtract the departing agent's contribution from the fleet token
    // totals — they are running deltas fed by per-agent snapshots, so a
    // removed agent's tokens otherwise stayed counted forever (only
    // session_stopped ever reset them, unconditionally to zero).
    const departing = agents.get(e.subagentId);
    agents.delete(e.subagentId);
    agentTranscripts.delete(e.subagentId);
    return {
      agents,
      agentTranscripts,
      agentTimeline: state.agentTimeline.filter((entry) => entry.subagentId !== e.subagentId),
      eventTimeline: state.eventTimeline.filter((entry) => entry.agentId !== e.subagentId),
      leaderId: state.leaderId === e.subagentId ? undefined : state.leaderId,
      fleetTokensIn: Math.max(0, state.fleetTokensIn - (departing?.tokensIn ?? 0)),
      fleetTokensOut: Math.max(0, state.fleetTokensOut - (departing?.tokensOut ?? 0)),
    };
  }

  // leader_updated: mark the new leader and demote the old one.
  if (e.kind === 'leader_updated' && e.subagentId) {
    const leader = agents.get(e.subagentId) ?? blankAgent(e.subagentId, e.name, e.sessionId, now);
    const leaderSession = e.sessionId || leader.sessionId;
    // Demote only the outgoing leader of the SAME session. Demoting
    // whoever held the process-wide pointer took the crown off another
    // tab's leader every time a second tab promoted one, and that tab then
    // listed its own leader among its subagents.
    for (const [id, agent] of agents) {
      if (id === e.subagentId || !agent.isLeader) continue;
      if (leaderSession && agent.sessionId && agent.sessionId !== leaderSession) continue;
      agents.set(id, { ...agent, isLeader: false });
    }
    const name = e.name?.trim() || leader.name;
    leaderId = e.subagentId;
    agents.set(e.subagentId, {
      ...leader,
      isLeader: true,
      name,
    });
    // The server re-sends leader_updated on every subscribeSessions (it
    // must: a reconnecting page needs the roster). The ROSTER upsert above
    // is idempotent by subagentId, but the timeline is a log — a pure
    // re-announce (same agent, already crowned, same name) would push a
    // duplicate row into the 20-slot timeline on every reconnect and tab
    // open, evicting real events. Log only state CHANGES.
    if (!leader.isLeader || name !== leader.name) {
      timeline = pushTimeline(timeline, {
        id: makeTimelineId(),
        kind: 'leader_updated',
        agentId: e.subagentId,
        agentName: name,
        timestamp: now,
        message: `${name} became leader`,
      });
    }
    return { agents, leaderId, eventTimeline: timeline };
  }

  // Every other event kind addresses a single agent — without an id
  // there is nothing to upsert (malformed/partial payload).
  if (!e.subagentId) return state;

  const prev = agents.get(e.subagentId) ?? blankAgent(e.subagentId, e.name, e.sessionId, now);
  const next: SubagentView = { ...prev };
  const isLeader = e.subagentId === 'leader' || prev.isLeader;
  let transcriptChanged = false;

  switch (e.kind) {
    case 'spawned':
      next.name = e.name?.trim() || next.name;
      next.provider = e.provider ?? next.provider;
      next.model = e.model ?? next.model;
      next.description = e.description ?? next.description;
      next.taskId = e.taskId ?? next.taskId;
      next.sessionId = e.sessionId ?? next.sessionId;
      next.status = 'running';
      next.sparklineBins = Array(SPARKLINE_BINS).fill(0);
      timeline = pushTimeline(timeline, {
        id: makeTimelineId(),
        kind: 'spawned',
        agentId: e.subagentId,
        agentName: next.name,
        timestamp: now,
        message: `${next.name} spawned`,
      });
      if (!isLeader && e.description) {
        const existing = agentTranscripts.get(e.subagentId) ?? [];
        if (existing.length === 0) {
          agentTranscripts.set(
            e.subagentId,
            appendTranscriptEntry(existing, {
              id: `agent_tl_${now}_spawn`,
              subagentId: e.subagentId,
              sessionId: e.sessionId,
              agentName: next.name,
              content: `🎯 Spawned: ${e.description}`,
              kind: 'system',
              iteration: 0,
              ts: new Date(now).toISOString(),
            }),
          );
          transcriptChanged = true;
        }
      }
      break;
    case 'task_started':
      next.description = e.description ?? next.description;
      next.taskId = e.taskId ?? next.taskId;
      next.status = 'running';
      timeline = pushTimeline(timeline, {
        id: makeTimelineId(),
        kind: 'task_started',
        agentId: e.subagentId,
        agentName: next.name,
        timestamp: now,
        message: `${next.name} started: ${e.description ?? 'new task'}`,
      });
      if (!isLeader && (e.description || e.taskId)) {
        const taskText = e.description || e.taskId;
        const existing = agentTranscripts.get(e.subagentId) ?? [];
        const lastEntry = existing[existing.length - 1];
        if (!lastEntry?.content.includes(taskText as string)) {
          agentTranscripts.set(
            e.subagentId,
            appendTranscriptEntry(existing, {
              id: `agent_tl_${now}_task`,
              subagentId: e.subagentId,
              sessionId: e.sessionId,
              agentName: next.name,
              content: `🎯 Task: ${taskText}`,
              kind: 'status',
              iteration: 0,
              ts: new Date(now).toISOString(),
            }),
          );
          transcriptChanged = true;
        }
      }
      break;
    case 'tool_executed': {
      const ok = typeof e.ok === 'boolean' ? e.ok : true;
      const dur = typeof e.durationMs === 'number' ? e.durationMs : 0;
      next.lastTool = e.toolName ?? next.lastTool;
      next.toolCalls = next.toolCalls + 1;
      // Prepend to tool log, cap at 50
      next.toolLog = [
        { name: e.toolName ?? 'unknown', ok, durationMs: dur, at: now },
        ...next.toolLog,
      ].slice(0, 50);
      // Bump sparkline
      next.sparklineBins = bumpSparkline(next.sparklineBins);
      timeline = pushTimeline(timeline, {
        id: makeTimelineId(),
        kind: 'tool_executed',
        agentId: e.subagentId,
        agentName: next.name,
        timestamp: now,
        message: `${next.name} ${ok ? '✓' : '✗'} ${e.toolName ?? 'tool'}`,
        value: dur,
      });
      if (!isLeader) {
        const toolContent = dur > 0 ? `Completed in ${dur}ms` : ok ? 'Success' : 'Failed';
        const existing = agentTranscripts.get(e.subagentId) ?? [];
        agentTranscripts.set(
          e.subagentId,
          appendTranscriptEntry(existing, {
            id: `agent_tl_${now}_tool_${Math.random().toString(36).slice(2, 6)}`,
            subagentId: e.subagentId,
            sessionId: e.sessionId,
            agentName: next.name,
            content: toolContent,
            kind: 'tool_result',
            toolName: e.toolName,
            toolOk: ok,
            iteration: next.iteration,
            ts: new Date(now).toISOString(),
          }),
        );
        transcriptChanged = true;
      }
      break;
    }
    case 'iteration_summary':
      next.iteration = e.iteration ?? next.iteration;
      if (typeof e.toolCalls === 'number') next.toolCalls = e.toolCalls;
      if (typeof e.costUsd === 'number') next.costUsd = e.costUsd;
      next.currentTool = e.currentTool ?? next.currentTool;
      if (typeof e.partialText === 'string' && e.partialText) {
        next.partialText = e.partialText;
      }
      // Bump sparkline on iteration
      next.sparklineBins = bumpSparkline(next.sparklineBins);
      timeline = pushTimeline(timeline, {
        id: makeTimelineId(),
        kind: 'iteration_summary',
        agentId: e.subagentId,
        agentName: next.name,
        timestamp: now,
        message: `${next.name} iter ${e.iteration ?? next.iteration} · ${e.currentTool ? `${e.currentTool}` : ''}`,
        value: e.costUsd,
      });
      if (!isLeader && typeof e.partialText === 'string' && e.partialText) {
        const existing = agentTranscripts.get(e.subagentId) ?? [];
        agentTranscripts.set(
          e.subagentId,
          appendTranscriptEntry(existing, {
            id: `agent_tl_${now}_iter_${e.iteration ?? 0}`,
            subagentId: e.subagentId,
            sessionId: e.sessionId,
            agentName: next.name,
            content: e.partialText,
            kind: 'text',
            iteration: e.iteration ?? next.iteration,
            costUsd: e.costUsd,
            ts: new Date(now).toISOString(),
          }),
        );
        transcriptChanged = true;
      }
      break;
    case 'budget_warning': {
      const kind = e.budgetKind ?? 'budget';
      const used = typeof e.used === 'number' ? e.used : 0;
      const limit = typeof e.limit === 'number' ? e.limit : 0;
      next.budgetWarning = { kind, used, limit };
      timeline = pushTimeline(timeline, {
        id: makeTimelineId(),
        kind: 'budget_warning',
        agentId: e.subagentId,
        agentName: next.name,
        timestamp: now,
        message: `${next.name} hit ${kind} budget ${used}/${limit}`,
        value: used,
      });
      break;
    }
    case 'budget_extended':
      next.extensions = e.totalExtensions ?? next.extensions + 1;
      // Clear any stale budget warning — the extension resolved it
      next.budgetWarning = undefined;
      timeline = pushTimeline(timeline, {
        id: makeTimelineId(),
        kind: 'budget_extended',
        agentId: e.subagentId,
        agentName: next.name,
        timestamp: now,
        message: `${next.name} extended budget ⚡×${next.extensions}`,
      });
      break;
    case 'ctx_pct':
      next.ctxPct = clampContextPct(Math.round(Math.max(0, e.load ?? 0) * 100));
      next.ctxTokens = e.tokens ?? next.ctxTokens;
      next.maxContext = e.maxContext ?? next.maxContext;

      // Derive a budget_warning when the agent crosses 80% context fill.
      // This matches the TUI's warn threshold behaviour. budget_extended
      // clears the warning, so it only fires once until the next extension.
      if (next.ctxPct >= 80 && !next.budgetWarning) {
        next.budgetWarning =
          next.ctxPct >= 100
            ? { kind: 'hard', used: next.ctxPct, limit: 100 }
            : { kind: 'soft', used: next.ctxPct, limit: 100 };
      }

      if (typeof e.costUsd === 'number') next.costUsd = e.costUsd;
      if (typeof e.tokensIn === 'number') {
        next.tokensIn = e.tokensIn;
        fleetTokensIn = fleetTokensIn - (prev.tokensIn ?? 0) + e.tokensIn;
      }
      if (typeof e.tokensOut === 'number') {
        next.tokensOut = e.tokensOut;
        fleetTokensOut = fleetTokensOut - (prev.tokensOut ?? 0) + e.tokensOut;
      }
      timeline = pushTimeline(timeline, {
        id: makeTimelineId(),
        kind: 'ctx_pct',
        agentId: e.subagentId,
        agentName: next.name,
        timestamp: now,
        message: `${next.name} ctx ${next.ctxPct}%`,
        value: next.ctxPct,
      });
      break;
    case 'task_completed': {
      const finalStatus = e.status === 'success' ? 'completed' : (e.status ?? 'completed');
      next.status = finalStatus;
      if (typeof e.iterations === 'number') next.iteration = e.iterations;
      if (typeof e.toolCalls === 'number') next.toolCalls = e.toolCalls;
      if (e.error) next.error = e.error;
      else delete next.error;
      next.currentTool = undefined;
      next.completedAt = now;
      next.failureReason = e.failureReason ?? next.failureReason;
      if (typeof e.finalText === 'string' && e.finalText) {
        // Strip <nextsteps> blocks from subagent output — suggestions belong
        // to the main assistant, not subagent results.
        next.finalText = clean(e.finalText);
      }
      const statusLabel =
        e.status === 'success'
          ? '✓ completed'
          : e.status === 'failed'
            ? `✗ failed${e.failureReason ? ` (${e.failureReason})` : ''}`
            : e.status === 'timeout'
              ? `⏱ timeout${e.failureReason ? ` (${e.failureReason})` : ''}`
              : 'stopped';
      timeline = pushTimeline(timeline, {
        id: makeTimelineId(),
        kind: 'task_completed',
        agentId: e.subagentId,
        agentName: next.name,
        timestamp: now,
        message: `${next.name} ${statusLabel}`,
        value: next.costUsd,
      });
      if (!isLeader) {
        const existing = agentTranscripts.get(e.subagentId) ?? [];
        if (typeof e.finalText === 'string' && e.finalText) {
          const cleaned = clean(e.finalText);
          const alreadyHas = existing.some(
            (item) => item.kind === 'text' && item.content.includes(cleaned),
          );
          if (!alreadyHas) {
            agentTranscripts.set(
              e.subagentId,
              appendTranscriptEntry(existing, {
                id: `agent_tl_${now}_done_text`,
                subagentId: e.subagentId,
                sessionId: e.sessionId,
                agentName: next.name,
                content: cleaned,
                kind: 'text',
                iteration: e.iterations ?? next.iteration,
                ts: new Date(now).toISOString(),
              }),
            );
            transcriptChanged = true;
          }
        }
        if (e.status === 'failed' || e.status === 'timeout') {
          const errMsg =
            e.error?.message ??
            (e.failureReason ? `Failed: ${e.failureReason}` : `Agent ${e.status}`);
          agentTranscripts.set(
            e.subagentId,
            appendTranscriptEntry(agentTranscripts.get(e.subagentId) ?? [], {
              id: `agent_tl_${now}_err`,
              subagentId: e.subagentId,
              sessionId: e.sessionId,
              agentName: next.name,
              content: errMsg,
              kind: 'error',
              iteration: e.iterations ?? next.iteration,
              ts: new Date(now).toISOString(),
            }),
          );
          transcriptChanged = true;
        } else if (!e.finalText) {
          agentTranscripts.set(
            e.subagentId,
            appendTranscriptEntry(agentTranscripts.get(e.subagentId) ?? [], {
              id: `agent_tl_${now}_done_status`,
              subagentId: e.subagentId,
              sessionId: e.sessionId,
              agentName: next.name,
              content: 'Task completed successfully',
              kind: 'status',
              iteration: e.iterations ?? next.iteration,
              ts: new Date(now).toISOString(),
            }),
          );
          transcriptChanged = true;
        }
      }
      break;
    }
  }
  agents.set(e.subagentId, next);
  // Bound the roster at ingest (the coordinator-monitor-store pattern:
  // every Map capped, eviction prefers terminal records). `agents` was
  // the one uncapped Map here — AgentsPanel's "agents are bounded, show
  // all without pagination" comment relied on a bound that didn't
  // exist, and a long session with hundreds of spawns kept every
  // record resident. Evict oldest-inserted non-running agents first;
  // running agents are never evicted (they'd lose live telemetry), and
  // their token totals follow them out (same running-delta contract as
  // `removed`).
  let evicted = false;
  if (agents.size > MAX_FLEET_AGENTS) {
    for (const [id, agent] of agents) {
      if (agents.size <= MAX_FLEET_AGENTS) break;
      if (agent.status === 'running' || id === e.subagentId) continue;
      agents.delete(id);
      agentTranscripts.delete(id);
      evicted = true;
      fleetTokensIn = Math.max(0, fleetTokensIn - (agent.tokensIn ?? 0));
      fleetTokensOut = Math.max(0, fleetTokensOut - (agent.tokensOut ?? 0));
      if (leaderId === id) leaderId = undefined;
    }
  }
  return {
    agents,
    agentTranscripts: transcriptChanged || evicted ? agentTranscripts : state.agentTranscripts,
    leaderId,
    fleetTokensIn,
    fleetTokensOut,
    eventTimeline: timeline,
  };
}
