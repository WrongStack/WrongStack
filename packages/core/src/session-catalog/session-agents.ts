/**
 * Derive the agent roster of one session from its journal.
 *
 * The journal is the source of truth and this is a pure projection over it —
 * deliberately, because the alternative (agents writing their own rows as they
 * spawn) creates a second authority that drifts the first time a process dies
 * between the append and the row. A projection cannot drift: re-run it and it
 * agrees with the file by construction.
 *
 * Three records feed a row, and they do NOT arrive in a fixed order.
 * `agent_session_linked` is appended by the subagent factory, which runs
 * INSIDE `coordinator.spawn()`, while `agent_spawned` is appended by the fleet
 * layer only after that call returns — so the link normally lands first. Every
 * merge here is therefore an upsert keyed on `agentId`, never a lookup that
 * assumes the row already exists.
 */
import type { Usage } from '../types/provider.js';
import type { SessionEvent } from '../types/session.js';

export type SessionAgentStatus = 'running' | 'completed' | 'failed';

export interface SessionAgentRecord {
  agentId: string;
  /** Role the agent was spawned as, from `agent_spawned`. */
  role?: string | undefined;
  provider?: string | undefined;
  model?: string | undefined;
  /** The agent's own journal id, when it has one of its own. */
  agentSessionId?: string | undefined;
  /** Absolute path of the agent's own JSONL, when it has one. */
  transcriptPath?: string | undefined;
  /** Set when another agent — not the leader — spawned this one. */
  parentAgentId?: string | undefined;
  spawnedAt?: string | undefined;
  endedAt?: string | undefined;
  status: SessionAgentStatus;
  error?: string | undefined;
  /**
   * Events in THIS journal stamped with this agent's id.
   *
   * Non-zero only for agents running on the parent-interleaved writer, whose
   * events land in the leader's file. An agent with its own transcript writes
   * nothing here, so a `0` means "look in `transcriptPath`", not "did nothing".
   */
  interleavedEventCount: number;
  usage?: Usage | undefined;
}

/**
 * Project a session's events into one record per agent, ordered by first
 * appearance so the roster reads in spawn order.
 *
 * Tolerates truncated journals: an agent that never got a terminal record
 * stays `running`, which is exactly what a crashed-mid-fleet session should
 * report. Callers that need "running or just never finished" must compare
 * against the session's own liveness, which this function has no view of.
 */
export function deriveSessionAgents(events: Iterable<SessionEvent>): SessionAgentRecord[] {
  const rows = new Map<string, SessionAgentRecord>();

  const upsert = (agentId: string): SessionAgentRecord => {
    let row = rows.get(agentId);
    if (!row) {
      row = { agentId, status: 'running', interleavedEventCount: 0 };
      rows.set(agentId, row);
    }
    return row;
  };

  for (const event of events) {
    // Attribution first: it applies to EVERY event type, including the agent
    // lifecycle records below, and an agent can appear here before any
    // lifecycle record if the journal was truncated at the head.
    if (event.agentId !== undefined && event.agentId !== '') {
      // The lifecycle records name their subject in `agentId` too, so counting
      // them as interleaved output would credit an agent for its own spawn
      // notice. Only non-lifecycle events are the agent's actual work.
      const isLifecycle =
        event.type === 'agent_spawned' ||
        event.type === 'agent_session_linked' ||
        event.type === 'agent_stopped' ||
        event.type === 'agent_error';
      const row = upsert(event.agentId);
      if (!isLifecycle) row.interleavedEventCount += 1;
    }

    switch (event.type) {
      case 'agent_spawned': {
        const row = upsert(event.agentId);
        row.role = event.role;
        // Keep the EARLIEST spawn stamp. A resumed fleet can re-announce an
        // agent; the first announcement is when it actually started.
        row.spawnedAt ??= event.ts;
        break;
      }
      case 'agent_session_linked': {
        const row = upsert(event.agentId);
        row.agentSessionId = event.agentSessionId;
        if (event.transcriptPath !== undefined) row.transcriptPath = event.transcriptPath;
        if (event.provider !== undefined) row.provider = event.provider;
        if (event.model !== undefined) row.model = event.model;
        if (event.parentAgentId !== undefined) row.parentAgentId = event.parentAgentId;
        row.spawnedAt ??= event.ts;
        break;
      }
      case 'agent_stopped': {
        const row = upsert(event.agentId);
        row.endedAt = event.ts;
        // An error already recorded is the more specific outcome: a failing
        // agent is stopped too, and `agent_stopped` carries no error text.
        if (row.status !== 'failed') {
          row.status =
            event.reason === 'failed' || event.reason === 'aborted' ? 'failed' : 'completed';
        }
        if (event.usage !== undefined) row.usage = event.usage;
        break;
      }
      case 'agent_error': {
        const row = upsert(event.agentId);
        row.status = 'failed';
        row.error = event.error;
        row.endedAt ??= event.ts;
        break;
      }
      default:
        break;
    }
  }

  return [...rows.values()];
}
