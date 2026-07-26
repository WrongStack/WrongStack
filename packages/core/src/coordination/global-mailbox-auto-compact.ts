import * as fsp from 'node:fs/promises';
import { atomicWrite, withFileLock } from '../utils/atomic-write.js';
import {
  AUTO_COMPACT_DEFAULT_TTL_MS,
  AUTO_COMPACT_READ_MAX_AGE_MS,
  LINE_SEPARATOR,
} from './mailbox-constants.js';
import {
  assertMailboxNotFenced,
  MAILBOX_VERSION_SENTINEL,
} from './mailbox-version-fence.js';
import { serializeMailboxMessage } from './mailbox-message-codec.js';
import { resolveMailboxRetentionState } from './mailbox-retention-state.js';
import type {
  AutoCompactOptions,
  AutoCompactResult,
  MailboxAgentStatus,
  MailboxMessage,
} from './mailbox-types.js';
import { isMailboxMessageVisibleTo, isMailboxReceiptRecordV2 } from './mailbox-types.js';

interface MessageFileStat {
  mtimeMs: number;
  size: number;
}

interface AutoCompactDeps {
  messagePath: string;
  getAgentStatuses(): Promise<MailboxAgentStatus[]>;
  readMessagesFresh(): Promise<MailboxMessage[]>;
  statMessageFile(): Promise<MessageFileStat>;
  setMessageCache(messages: MailboxMessage[], stat: MessageFileStat): void;
}

export async function runGlobalMailboxAutoCompact(
  opts: AutoCompactOptions | undefined,
  deps: AutoCompactDeps,
): Promise<AutoCompactResult> {
  const readMaxAgeMs = opts?.readMaxAgeMs ?? AUTO_COMPACT_READ_MAX_AGE_MS;
  const defaultTtlMs = opts?.defaultTtlMs ?? AUTO_COMPACT_DEFAULT_TTL_MS;
  const completedMaxAgeMs = opts?.completedMaxAgeMs ?? 86_400_000; // 1 day
  const incompleteMaxAgeMs = opts?.incompleteMaxAgeMs ?? 604_800_000; // 7 days

  let expiredPurged = 0;
  let readByAllPurged = 0;
  let completedPurged = 0;
  let incompletePurged = 0;
  let remaining = 0;

  const agentStatuses = await resolveAgentStatuses(deps.getAgentStatuses);
  const onlineAgents = resolveOnlineAgents(agentStatuses);

  await withFileLock(deps.messagePath, async () => {
    // GM-P0.4A: Refuse mutation when a newer-version process has written
    // v2 receipt records to this mailbox.
    await assertMailboxNotFenced(deps.messagePath);

    const all = await deps.readMessagesFresh();
    const now = Date.now();
    const cutoffReadAge = now - readMaxAgeMs;
    const cutoffCompleted = now - completedMaxAgeMs;
    const cutoffIncomplete = now - incompleteMaxAgeMs;
    const cutoffDefaultTtl = now - defaultTtlMs;
    const kept: MailboxMessage[] = [];

    for (const msg of all) {
      const msgTime = new Date(msg.timestamp).getTime();
      if (msg.expiresAt !== undefined) {
        if (new Date(msg.expiresAt).getTime() < now) {
          expiredPurged++;
          continue;
        }
      } else if (msgTime < cutoffDefaultTtl) {
        expiredPurged++;
        continue;
      }

      const retention = resolveMailboxRetentionState(msg, agentStatuses);
      if (onlineAgents !== null && !retention.completed) {
        const eligibleAgentIds = [...onlineAgents]
          .filter(([id, role]) => isMailboxMessageVisibleTo(msg, id, role))
          .map(([id]) => id);
        const readByAll =
          eligibleAgentIds.length > 0 && eligibleAgentIds.every((id) => id in msg.readBy);
        if (readByAll) {
          const readTimes = Object.values(msg.readBy).map((t) => new Date(t).getTime());
          const latestRead = Math.max(...readTimes);
          if (latestRead < cutoffReadAge) {
            readByAllPurged++;
            continue;
          }
        }
      }

      const completedTime = retention.completedAt
        ? new Date(retention.completedAt).getTime()
        : 0;
      if (retention.completed && completedTime < cutoffCompleted) {
        completedPurged++;
        continue;
      }
      if (!retention.completed && msgTime < cutoffIncomplete) {
        incompletePurged++;
        continue;
      }
      kept.push(msg);
    }

    remaining = kept.length;
    if (kept.length < all.length) {
      // Preserve v2 receipt records and version sentinel for kept messages.
      const keptIds = new Set<string>();
      for (const msg of kept) keptIds.add(msg.id);

      // Read raw file to extract v2 receipt lines belonging to kept messages.
      const v2ReceiptLines: string[] = [];
      let hasV2Content = false;
      try {
        const raw = await fsp.readFile(deps.messagePath, 'utf8');
        const lines = raw.split(LINE_SEPARATOR).filter((l) => l.trim().length > 0);
        for (const line of lines) {
          const trimmed = line.trim();
          if (trimmed.length === 0) continue;
          try {
            const parsed = JSON.parse(trimmed);
            if (isMailboxReceiptRecordV2(parsed) && keptIds.has(parsed.messageId)) {
              v2ReceiptLines.push(trimmed);
            }
          } catch {
            // skip malformed lines
          }
        }
        hasV2Content = raw.includes('__mailboxReceipt');
      } catch {
        // File vanished; rewrite what we have
      }

      // Serialize kept messages without projection extras, then append
      // preserved v2 receipts and the version sentinel when applicable.
      const content =
        kept.map(serializeMailboxMessage).join('') +
        v2ReceiptLines.map((line) => `${line}${LINE_SEPARATOR}`).join('') +
        (hasV2Content || v2ReceiptLines.length > 0
          ? `${MAILBOX_VERSION_SENTINEL}${LINE_SEPARATOR}`
          : '');
      await atomicWrite(deps.messagePath, content);

      // Re-read and adopt the cache with the post-write stat.
      const postStat = await deps.statMessageFile();
      deps.setMessageCache(kept, postStat);
    } else {
      // No messages removed; just advance the cache tracker.
      await deps.setMessageCache(kept, await deps.statMessageFile());
    }
  });

  const totalRemoved = expiredPurged + readByAllPurged + completedPurged + incompletePurged;
  return {
    expiredRemoved: expiredPurged,
    readByAllRemoved: readByAllPurged,
    stalePurged: completedPurged + incompletePurged,
    totalRemoved,
    remaining,
  };
}

async function resolveAgentStatuses(
  getAgentStatuses: () => Promise<MailboxAgentStatus[]>,
): Promise<MailboxAgentStatus[] | undefined> {
  try {
    return await getAgentStatuses();
  } catch {
    return undefined;
  }
}

function resolveOnlineAgents(
  agentStatuses: readonly MailboxAgentStatus[] | undefined,
): Map<string, string | undefined> | null {
  const online = agentStatuses?.filter((status) => status.online) ?? [];
  return online.length > 0
    ? new Map(online.map((status) => [status.agentId, status.role]))
    : null;
}
