import type {
  HqClientRecord,
  HqSessionAgentSummary,
  HqSessionSnapshotPayload,
  HqSnapshot,
} from '@wrongstack/core/hq';

export interface ConsoleControlTarget {
  session: HqSessionSnapshotPayload;
  client: HqClientRecord | null;
  agent: HqSessionAgentSummary | null;
  recipient: string;
  controllable: boolean;
  mailboxServeActive: boolean;
}

/** Resolve a transcript selection to the exact connected publisher. New HQ
 * servers enrich live sessions with clientId; the metadata fallback keeps the
 * console useful while an older client/server pair is rolling forward. */
export function resolveConsoleControlTarget(
  snapshot: HqSnapshot | null,
  sessionId: string | null,
  agentId: string | null,
): ConsoleControlTarget | null {
  if (snapshot === null || sessionId === null) return null;
  const session = (snapshot.liveSessions ?? []).find(
    (candidate) => candidate.sessionId === sessionId,
  );
  if (session === undefined) return null;

  const summaryClientId = snapshot.sessions.find(
    (candidate) => candidate.sessionId === sessionId,
  )?.clientId;
  const exactClientId = session.clientId ?? summaryClientId;
  const exactClient = snapshot.clients.find(
    (candidate) => candidate.connected && candidate.clientId === exactClientId,
  );
  const candidates = snapshot.clients.filter(
    (candidate) =>
      candidate.connected &&
      candidate.machineId === session.machineId &&
      candidate.projectId === session.projectId &&
      (session.pid === undefined || candidate.pid === session.pid),
  );
  // Some surfaces publish telemetry and receive control over sibling HQ
  // sockets. Prefer the exact session publisher when it can receive control;
  // otherwise promote the control-capable sibling from the same process.
  const client =
    (exactClient?.capabilities.includes('control.receive') === true ? exactClient : undefined) ??
    candidates.find(
      (candidate) =>
        candidate.kind === session.clientKind && candidate.capabilities.includes('control.receive'),
    ) ??
    candidates.find((candidate) => candidate.capabilities.includes('control.receive')) ??
    exactClient ??
    candidates[0];

  const agent =
    agentId === null
      ? null
      : (session.agents.find((candidate) => candidate.id === agentId) ?? null);
  const recipient = agentId === null || agentId === 'leader' ? 'leader' : agentId;
  const mailboxServeActive = snapshot.clients.some(
    (candidate) =>
      candidate.connected &&
      candidate.projectId === session.projectId &&
      candidate.capabilities.includes('mailbox.serve'),
  );

  return {
    session,
    client: client ?? null,
    agent,
    recipient,
    controllable: client?.capabilities.includes('control.receive') === true,
    mailboxServeActive,
  };
}
