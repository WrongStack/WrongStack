import * as fsp from 'node:fs/promises';
import { atomicWrite, withFileLock } from '../utils/atomic-write.js';
import {
  assertMailboxNotFenced,
  MAILBOX_VERSION_SENTINEL,
} from './mailbox-version-fence.js';
import { serializeMailboxMessage } from './mailbox-message-codec.js';
import { LINE_SEPARATOR } from './mailbox-constants.js';
import { resolveMailboxRetentionState } from './mailbox-retention-state.js';
import type {
  MailboxAgentStatus,
  MailboxMessage,
  PurgeOptions,
  PurgeResult,
} from './mailbox-types.js';
import { isMailboxReceiptRecordV2 } from './mailbox-types.js';

interface MessageFileStat {
  mtimeMs: number;
  size: number;
}

interface PurgeStaleDeps {
  messagePath: string;
  getAgentStatuses(): Promise<MailboxAgentStatus[]>;
  readMessagesFresh(): Promise<MailboxMessage[]>;
  statMessageFile(): Promise<MessageFileStat>;
  setMessageCache(messages: MailboxMessage[], stat: MessageFileStat): void;
}

export async function runGlobalMailboxPurgeStale(
  opts: PurgeOptions | undefined,
  deps: PurgeStaleDeps,
): Promise<PurgeResult> {
  const completedMaxAgeMs = opts?.completedMaxAgeMs ?? 86_400_000; // 1 day
  const incompleteMaxAgeMs = opts?.incompleteMaxAgeMs ?? 604_800_000; // 7 days

  let completedPurged = 0;
  let incompletePurged = 0;
  let remaining = 0;
  const agentStatuses = await resolveAgentStatuses(deps.getAgentStatuses);

  await withFileLock(deps.messagePath, async () => {
    // GM-P0.4A: Refuse mutation when a newer-version process has written
    // v2 receipt records to this mailbox.
    await assertMailboxNotFenced(deps.messagePath);

    const all = await deps.readMessagesFresh();
    const now = Date.now();
    const cutoffCompleted = now - completedMaxAgeMs;
    const cutoffIncomplete = now - incompleteMaxAgeMs;
    const kept: MailboxMessage[] = [];

    for (const msg of all) {
      const msgTime = new Date(msg.timestamp).getTime();
      const retention = resolveMailboxRetentionState(msg, agentStatuses);
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

      const v2ReceiptLines: string[] = [];
      let hasV2Content = false;
      try {
        const raw = await fsp.readFile(deps.messagePath, 'utf8');
        for (const line of raw.split(LINE_SEPARATOR)) {
          const trimmed = line.trim();
          if (trimmed.length === 0) continue;
          try {
            const parsed = JSON.parse(trimmed);
            if (isMailboxReceiptRecordV2(parsed) && keptIds.has(parsed.messageId)) {
              v2ReceiptLines.push(trimmed);
            }
          } catch {
            // skip malformed
          }
        }
        hasV2Content = raw.includes('__mailboxReceipt');
      } catch {
        // file vanished; rewrite what we have
      }

      const content =
        kept.map(serializeMailboxMessage).join('') +
        v2ReceiptLines.map((line) => `${line}${LINE_SEPARATOR}`).join('') +
        (hasV2Content || v2ReceiptLines.length > 0
          ? `${MAILBOX_VERSION_SENTINEL}${LINE_SEPARATOR}`
          : '');
      await atomicWrite(deps.messagePath, content);
    }
    deps.setMessageCache(kept, await deps.statMessageFile());
  });

  return {
    completedPurged,
    incompletePurged,
    totalPurged: completedPurged + incompletePurged,
    remaining,
  };
}

async function resolveAgentStatuses(
  getAgentStatuses: () => Promise<MailboxAgentStatus[]>,
): Promise<MailboxAgentStatus[] | undefined> {
  try {
    return await getAgentStatuses();
  } catch {
    // Conservatively retain fan-out messages when recipient discovery fails.
    return undefined;
  }
}
