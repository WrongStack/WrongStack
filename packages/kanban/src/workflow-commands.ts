import { randomUUID } from 'node:crypto';

import { getKanbanServerConnection } from './server/client.js';
import type { KanbanServerEvent, KanbanWorkflowCommand } from './server/protocol.js';

export interface EnqueueKanbanWorkflowCommandInput {
  id?: string | undefined;
  createdAt?: string | undefined;
  type: string;
  payload?: unknown;
}

/** Stable project-local workflow key shared by every process. */
export function kanbanWorkflowId(engine: string, runId: string): string {
  return `${safePart(engine)}:${safePart(runId)}`;
}

/** Persist one at-most-once command through the elected project owner. */
export async function enqueueKanbanWorkflowCommand(
  projectRoot: string,
  workflowId: string,
  input: EnqueueKanbanWorkflowCommandInput,
): Promise<KanbanWorkflowCommand> {
  const connection = await requireConnection(projectRoot);
  const command: KanbanWorkflowCommand = {
    id: input.id ?? randomUUID(),
    workflowId,
    createdAt: input.createdAt ?? new Date().toISOString(),
    type: input.type,
    ...(input.payload === undefined ? {} : { payload: input.payload }),
  };
  await connection.request('workflowEnqueueCommand', { workflowId, command });
  return command;
}

/** Atomically claim and remove the oldest commands for one workflow. */
export async function drainKanbanWorkflowCommands(
  projectRoot: string,
  workflowId: string,
  limit?: number,
): Promise<KanbanWorkflowCommand[]> {
  const connection = await requireConnection(projectRoot);
  return connection.request('workflowDrainCommands', {
    workflowId,
    ...(limit === undefined ? {} : { limit }),
  });
}

/**
 * Subscribe to low-latency queue notifications. Commands remain durable until
 * drained, so callers should also drain once after subscribing and may retain a
 * slow reconciliation timer to cover daemon restarts.
 */
export async function subscribeKanbanWorkflowCommands(
  projectRoot: string,
  workflowId: string,
  listener: () => void,
): Promise<() => void> {
  const connection = await requireConnection(projectRoot);
  return connection.subscribe((event) => {
    if (isWorkflowNotification(event, workflowId)) listener();
  });
}

function isWorkflowNotification(event: KanbanServerEvent, workflowId: string): boolean {
  if (event.event !== 'workflow.command' || !event.data || typeof event.data !== 'object') {
    return false;
  }
  return (event.data as { boardId?: unknown }).boardId === workflowId;
}

async function requireConnection(projectRoot: string) {
  const connection = await getKanbanServerConnection(projectRoot);
  if (!connection) {
    throw new Error('Kanban project server is disabled; workflow commands require IPC');
  }
  return connection;
}

function safePart(value: string): string {
  const normalized = value.replace(/[^A-Za-z0-9._-]/g, '_');
  if (!normalized) throw new Error('Workflow identifiers cannot be empty');
  return normalized;
}
