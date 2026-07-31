import { getKanbanServerConnection } from './server/client.js';
import type { KanbanWorkflowState } from './server/protocol.js';

export async function readKanbanWorkflowState(
  projectRoot: string,
  workflowId: string,
): Promise<KanbanWorkflowState | null> {
  const connection = await requireConnection(projectRoot);
  return connection.request('workflowReadState', { workflowId });
}

export async function writeKanbanWorkflowState(
  projectRoot: string,
  workflowId: string,
  value: unknown,
  expectedRevision?: number,
): Promise<KanbanWorkflowState> {
  const connection = await requireConnection(projectRoot);
  return connection.request('workflowWriteState', {
    workflowId,
    value,
    ...(expectedRevision === undefined ? {} : { expectedRevision }),
  });
}

export async function listKanbanWorkflowStates(
  projectRoot: string,
  prefix: string,
  limit?: number,
): Promise<KanbanWorkflowState[]> {
  const connection = await requireConnection(projectRoot);
  return connection.request('workflowListStates', {
    prefix,
    ...(limit === undefined ? {} : { limit }),
  });
}

export async function deleteKanbanWorkflowState(
  projectRoot: string,
  workflowId: string,
): Promise<boolean> {
  const connection = await requireConnection(projectRoot);
  return connection.request('workflowDeleteState', { workflowId });
}

async function requireConnection(projectRoot: string) {
  const connection = await getKanbanServerConnection(projectRoot);
  if (!connection) {
    throw new Error('Kanban project server is disabled; workflow state requires IPC');
  }
  return connection;
}
