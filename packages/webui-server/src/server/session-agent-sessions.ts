/**
 * The subagent half of a session replay.
 *
 * A resumed tab used to come back with an empty fleet panel: every subagent
 * that had run for it was gone, and the only trace left in the transcript was
 * a pair of lifecycle lines. Two separate records hold the answer, and neither
 * is sufficient alone:
 *
 * - The session's OWN journal says which agents belong to it — `agent_spawned`
 *   and `agent_session_linked`, projected by `deriveSessionAgents`. This is the
 *   only session-scoped record there is.
 * - `AgentMonitorService` holds the transcripts, under a directory shared by
 *   every session of the project. Asked for everything, it hands each of four
 *   open tabs the union of all four tabs' workers.
 *
 * So the journal supplies the roster and the monitor fills in the bodies.
 */
import { deriveSessionAgents } from '@wrongstack/core/storage';
import type { SessionEvent } from '@wrongstack/core/types';

/** Reserved id the leader's own interleaved events are stamped with. */
const LEADER_AGENT_ID = 'leader';

/** One transcript line, as `AgentMonitorService` stores it. */
export interface AgentTranscriptLine {
  id: string;
  subagentId: string;
  agentName: string;
  ts: string;
  kind: string;
  content: string;
  iteration: number;
  toolName?: string | undefined;
  toolOk?: boolean | undefined;
  costUsd?: number | undefined;
}

/** Structural shape of `AgentMonitorService.loadSessionsFromDisk`'s rows. */
export interface AgentVirtualSessionLike {
  subagentId: string;
  agentName?: string | undefined;
  status?: string | undefined;
  task?: string | undefined;
  transcript?: AgentTranscriptLine[] | undefined;
}

/** What `session.start` carries for one subagent. */
export interface AgentSessionPayload {
  subagentId: string;
  agentName?: string | undefined;
  status?: string | undefined;
  task?: string | undefined;
  role?: string | undefined;
  provider?: string | undefined;
  model?: string | undefined;
  startedAt?: string | undefined;
  endedAt?: string | undefined;
  transcript?: AgentTranscriptLine[] | undefined;
}

export type LoadAgentSessions = (
  subagentIds: readonly string[],
) => Promise<AgentVirtualSessionLike[]>;

/**
 * Build the `agentSessions` field of a `session.start` payload.
 *
 * Returns an empty array — never a partial one — when the journal names no
 * agents, so a session that never delegated costs nothing.
 *
 * The journal's status wins over the monitor's. The monitor reports
 * `'restored'` for anything it read back from disk, which says only "this
 * process did not watch it run"; the journal knows whether the agent finished,
 * failed, or was still going when the file ended.
 */
export async function buildAgentSessionsPayload(
  events: readonly SessionEvent[] | undefined,
  load: LoadAgentSessions | undefined,
): Promise<AgentSessionPayload[]> {
  if (!events || events.length === 0 || !load) return [];
  // `deriveSessionAgents` upserts a row for EVERY stamped `agentId`, and some
  // producers stamp the leader's own work with the reserved id `leader`. That
  // is right for attribution and wrong for a fleet panel: the leader is the
  // session, not one of its workers, and listing it put a permanently
  // "running" worker card in every resumed tab.
  const roster = deriveSessionAgents(events).filter(
    (agent) => agent.agentId.trim().toLowerCase() !== LEADER_AGENT_ID,
  );
  if (roster.length === 0) return [];

  let bodies: AgentVirtualSessionLike[] = [];
  try {
    bodies = await load(roster.map((agent) => agent.agentId));
  } catch {
    // Transcript bodies are best-effort: a roster with no bodies still brings
    // the fleet panel back, which is strictly better than an empty one.
  }
  const byId = new Map(bodies.map((body) => [body.subagentId, body]));

  return roster.map((agent) => {
    const body = byId.get(agent.agentId);
    return {
      subagentId: agent.agentId,
      agentName: body?.agentName ?? agent.agentId,
      status: agent.status,
      role: agent.role,
      provider: agent.provider,
      model: agent.model,
      startedAt: agent.spawnedAt,
      endedAt: agent.endedAt,
      ...(body?.task !== undefined ? { task: body.task } : {}),
      ...(body?.transcript && body.transcript.length > 0
        ? { transcript: body.transcript }
        : {}),
    };
  });
}
