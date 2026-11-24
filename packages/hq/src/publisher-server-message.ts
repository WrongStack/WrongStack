import { type HqServerSageSnapshotMessage, isHqSageSnapshotPayload } from './protocol/sage.js';
import { type HqServerVaultChangedMessage, isHqVaultChangedNotice } from './protocol/vault.js';
import type { HqServerCommandBatchMessage, HqServerKanbanSnapshotMessage } from './protocol.js';
import { extractSocketMessageData } from './publisher-socket.js';
import type { HqPublisherOptions } from './publisher-types.js';
import { deliverHqVaultNotice } from './vault/notice-bus.js';

type ParsedHqServerMessage =
  | HqServerCommandBatchMessage
  | HqServerKanbanSnapshotMessage
  | HqServerSageSnapshotMessage
  | HqServerVaultChangedMessage;

export function parseHqServerMessage(
  event: unknown,
  projectId: string,
): ParsedHqServerMessage | null {
  const data = extractSocketMessageData(event);
  if (data === null) return null;
  try {
    const parsed = JSON.parse(data) as
      | Partial<HqServerCommandBatchMessage>
      | Partial<HqServerSageSnapshotMessage>
      | Partial<HqServerKanbanSnapshotMessage>
      | Partial<HqServerVaultChangedMessage>;
    if (parsed.type === 'hq.command_batch' && Array.isArray(parsed.commands)) {
      return parsed as HqServerCommandBatchMessage;
    }
    if (
      parsed.type === 'hq.sage_snapshot' &&
      isHqSageSnapshotPayload(parsed.payload) &&
      parsed.payload.projectId === projectId
    ) {
      return parsed as HqServerSageSnapshotMessage;
    }
    if (parsed.type === 'hq.kanban_snapshot') {
      const payload = (parsed as Partial<HqServerKanbanSnapshotMessage>).payload;
      if (
        payload !== undefined &&
        typeof payload === 'object' &&
        typeof payload.projectId === 'string' &&
        payload.projectId === projectId &&
        Array.isArray(payload.boards) &&
        Array.isArray(payload.tombstones)
      ) {
        return parsed as HqServerKanbanSnapshotMessage;
      }
    }
    // Not project-scoped: the vault belongs to the HQ, not to a project.
    if (parsed.type === 'hq.vault_changed' && isHqVaultChangedNotice(parsed.payload)) {
      return { type: 'hq.vault_changed', payload: parsed.payload };
    }
    return null;
  } catch {
    return null;
  }
}

/** Hand a parsed server message (other than a command batch) to whoever consumes it. */
export async function deliverHqServerMessage(
  message: Exclude<ParsedHqServerMessage, HqServerCommandBatchMessage>,
  options: Pick<HqPublisherOptions, 'onKanbanSnapshot' | 'onSageSnapshot'>,
): Promise<void> {
  if (message.type === 'hq.kanban_snapshot') await options.onKanbanSnapshot?.(message.payload);
  else if (message.type === 'hq.sage_snapshot') await options.onSageSnapshot?.(message.payload);
  // The process's HQ key-vault client (if this machine is enrolled) decides
  // whether the notice is for it; a publisher never syncs anything itself.
  else deliverHqVaultNotice(message.payload);
}
