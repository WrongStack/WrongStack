/**
 * Retention sweeps over the mailbox message table: the age-based `purgeStale`
 * and the richer `autoCompact` (expiry + read-by-all + stale).
 *
 * Split out of `sqlite-mailbox.ts`. Both walk the materialized message
 * projections rather than SQL predicates, because retention state is derived
 * from per-recipient receipts plus live agent status — see
 * `resolveMailboxRetentionState`.
 *
 * @module coordination/sqlite-mailbox-compaction
 */
import {
  AUTO_COMPACT_DEFAULT_TTL_MS,
  AUTO_COMPACT_READ_MAX_AGE_MS,
  AUTO_COMPACT_TYPE_TTL_MS,
} from './mailbox-constants.js';
import { resolveMailboxRetentionState } from './mailbox-retention-state.js';
import type {
  AutoCompactOptions,
  AutoCompactResult,
  MailboxAgentStatus,
  MailboxMessageProjection,
  PurgeOptions,
  PurgeResult,
} from './mailbox-types.js';
import { isMailboxMessageVisibleTo } from './mailbox-types.js';

/** The store operations a sweep needs. */
export interface CompactionContext {
  getAgentStatuses: () => Promise<MailboxAgentStatus[]>;
  readMessages: () => MailboxMessageProjection[];
  deleteMessages: (ids: readonly string[]) => void;
}

export async function purgeStale(
  ctx: CompactionContext,
  options?: PurgeOptions,
): Promise<PurgeResult> {
  const completedMaxAgeMs = options?.completedMaxAgeMs ?? 86_400_000;
  const incompleteMaxAgeMs = options?.incompleteMaxAgeMs ?? 604_800_000;
  const statuses = await ctx.getAgentStatuses();
  const now = Date.now();
  let completedPurged = 0;
  let incompletePurged = 0;
  const ids: string[] = [];
  const messages = ctx.readMessages();
  for (const message of messages) {
    const retention = resolveMailboxRetentionState(message, statuses);
    const messageTime = new Date(message.timestamp).getTime();
    const completionTime = new Date(retention.completedAt ?? 0).getTime();
    if (retention.completed && completionTime < now - completedMaxAgeMs) {
      completedPurged++;
      ids.push(message.id);
    } else if (!retention.completed && messageTime < now - incompleteMaxAgeMs) {
      incompletePurged++;
      ids.push(message.id);
    }
  }
  ctx.deleteMessages(ids);
  return {
    completedPurged,
    incompletePurged,
    totalPurged: ids.length,
    remaining: messages.length - ids.length,
  };
}

export async function autoCompact(
  ctx: CompactionContext,
  options?: AutoCompactOptions,
): Promise<AutoCompactResult> {
  const readMaxAgeMs = options?.readMaxAgeMs ?? AUTO_COMPACT_READ_MAX_AGE_MS;
  const defaultTtlMs = options?.defaultTtlMs ?? AUTO_COMPACT_DEFAULT_TTL_MS;
  const typeTtlMs = options?.typeTtlMs ?? AUTO_COMPACT_TYPE_TTL_MS;
  const completedMaxAgeMs = options?.completedMaxAgeMs ?? 86_400_000;
  const incompleteMaxAgeMs = options?.incompleteMaxAgeMs ?? 604_800_000;
  const statuses = await ctx.getAgentStatuses();
  const online = statuses.filter((status) => status.online);
  const now = Date.now();
  let readByAllRemoved = 0;
  let expiredRemoved = 0;
  let stalePurged = 0;
  const ids: string[] = [];
  const messages = ctx.readMessages();

  for (const message of messages) {
    const messageTime = new Date(message.timestamp).getTime();
    const expiry =
      message.expiresAt !== undefined
        ? new Date(message.expiresAt).getTime()
        : messageTime + (typeTtlMs[message.type] ?? defaultTtlMs);
    if (expiry < now) {
      expiredRemoved++;
      ids.push(message.id);
      continue;
    }

    const retention = resolveMailboxRetentionState(message, statuses);
    const eligible = online.filter((status) =>
      isMailboxMessageVisibleTo(message, status.agentId, status.role),
    );
    if (!retention.completed && eligible.length > 0) {
      const readByAll = eligible.every((status) => status.agentId in message.readBy);
      const latestRead = Math.max(
        ...eligible.map((status) => new Date(message.readBy[status.agentId] ?? 0).getTime()),
      );
      if (readByAll && latestRead < now - readMaxAgeMs) {
        readByAllRemoved++;
        ids.push(message.id);
        continue;
      }
    }

    const completionTime = new Date(retention.completedAt ?? 0).getTime();
    if (
      (retention.completed && completionTime < now - completedMaxAgeMs) ||
      (!retention.completed && messageTime < now - incompleteMaxAgeMs)
    ) {
      stalePurged++;
      ids.push(message.id);
    }
  }

  ctx.deleteMessages(ids);
  return {
    readByAllRemoved,
    expiredRemoved,
    stalePurged,
    totalRemoved: ids.length,
    remaining: messages.length - ids.length,
  };
}
