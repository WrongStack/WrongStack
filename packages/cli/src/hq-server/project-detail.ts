/**
 * `/api/projects/:id` — one project's clients and mailboxes, built from the
 * connected-client table. Split out of `snapshot.ts` (the fleet snapshot).
 *
 * @module hq-server/project-detail
 */
import type {
  HqClientCapability,
  HqClientRecord,
  HqMailboxSnapshotPayload,
  HqProjectRecord,
} from '@wrongstack/hq';
import type { WebSocket } from '../ws-runtime.js';
import type { ConnectedClient, ProjectDetail } from './types.js';

export function buildProjectDetail(
  clients: Map<WebSocket, ConnectedClient>,
  projectId: string,
): ProjectDetail | null {
  const projectClients: ConnectedClient[] = [];
  for (const c of clients.values()) {
    if (c.projectId === projectId) projectClients.push(c);
  }
  if (projectClients.length === 0) return null;

  const now = new Date().toISOString();
  const clientRecords: HqClientRecord[] = projectClients.map((c) => ({
    clientId: c.clientId,
    kind: c.kind as HqClientRecord['kind'],
    machineId: '',
    ...(c.hostname ? { hostname: c.hostname } : {}),
    ...(c.pid ? { pid: c.pid } : {}),
    ...(c.version ? { version: c.version } : {}),
    connected: true,
    connectedAt: c.connectedAt,
    lastSeenAt: c.lastSeenAt,
    projectId: c.projectId,
    capabilities: c.capabilities as readonly HqClientCapability[],
  }));

  const mailboxPayloads: HqMailboxSnapshotPayload[] = [];
  let latestActivity = now;
  for (const c of projectClients) {
    for (const snap of c.mailboxes.values()) {
      mailboxPayloads.push(snap);
      if (snap.totals.messages > 0) latestActivity = now;
    }
  }

  const primaryProject = projectClients[0]!.project;
  const machineIds = Array.from(new Set(projectClients.map((client) => client.project.machineId)));
  const project: HqProjectRecord = {
    projectId,
    projectName: primaryProject.projectName || projectId,
    projectRootDisplay: primaryProject.projectRoot,
    machineIds,
    ...(primaryProject.gitBranch ? { gitBranch: primaryProject.gitBranch } : {}),
    activeClients: projectClients.length,
    activeSessions: 0,
    activeSubagents: 0,
    totalCostUsd: 0,
    lastActivityAt: latestActivity,
    status: 'active',
  };

  return {
    generatedAt: now,
    project,
    clients: clientRecords,
    mailboxes: mailboxPayloads,
  };
}
