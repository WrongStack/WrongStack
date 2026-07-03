/**
 * Pure helper for {@link MailboxView}: groups raw HQ events + snapshot
 * counters into per-project flat message lists.
 *
 * Extracted out of the React component so it can be unit-tested without
 * jsdom or a live `useHqStore`. The component just calls
 * {@link groupMailboxEvents} inside `useMemo`.
 *
 * Counter model:
 *   - When `snapshot.mailboxes[]` is present, its per-project counters
 *     are the authoritative source (computed server-side from the full
 *     mailbox, including messages we have not streamed yet). The detail
 *     feed below adds UI-only message rows but does NOT increment those
 *     counters — that would double-count any mailId we received both
 *     via snapshot AND via a later mailbox.event.
 *   - When `snapshot.mailboxes[]` is absent (e.g. mid-reconnect) but
 *     mailbox.event envelopes exist, we derive counters from the unique
 *     mailIds we've seen so the UI still shows live numbers.
 */
import type {
  HqEventEnvelope,
  HqMailboxEventPayload,
  HqMailboxMessageSummary,
  HqMailboxSnapshotPayload,
  HqMailboxSummary,
  HqSnapshot,
} from '@wrongstack/core';

export type MessageSource = 'event' | 'snapshot';

export interface FlatMessage {
  message: HqMailboxMessageSummary;
  /** Where this record came from (live event vs. snapshot replay). */
  source: MessageSource;
  /** Event id for dedupe key — events already carry a unique id. */
  key: string;
}

export interface ProjectGroup {
  projectId: string;
  mailboxId?: string;
  scope?: 'project' | 'global';
  messages: FlatMessage[];
  /** True when the counters came from the snapshot aggregate (server-side totals). */
  countersFromSnapshot: boolean;
  onlineAgentCount: number;
  highPriorityCount: number;
  unreadCount: number;
  incompleteCount: number;
}

export interface GroupingResult {
  projects: ProjectGroup[];
  hasAnyActivity: boolean;
}

function isMailboxSnapshot(payload: unknown): payload is HqMailboxSnapshotPayload {
  if (typeof payload !== 'object' || payload === null) return false;
  const v = payload as Record<string, unknown>;
  return (
    typeof v.mailboxId === 'string' &&
    (v.scope === 'project' || v.scope === 'global') &&
    Array.isArray(v.messages) &&
    Array.isArray(v.agents) &&
    typeof v.totals === 'object' &&
    v.totals !== null
  );
}

function isMailboxEvent(payload: unknown): payload is HqMailboxEventPayload {
  if (typeof payload !== 'object' || payload === null) return false;
  const v = payload as Record<string, unknown>;
  return (
    typeof v.mailboxId === 'string' &&
    typeof v.action === 'string' &&
    (v.message === undefined || typeof v.message === 'object')
  );
}

function ensureGroup(seen: Map<string, ProjectGroup>, projectId: string): ProjectGroup {
  let g = seen.get(projectId);
  if (g === undefined) {
    g = {
      projectId,
      messages: [],
      countersFromSnapshot: false,
      onlineAgentCount: 0,
      highPriorityCount: 0,
      unreadCount: 0,
      incompleteCount: 0,
    };
    seen.set(projectId, g);
  }
  return g;
}

function deriveCountersFromMessages(messages: readonly FlatMessage[]): {
  highPriorityCount: number;
  unreadCount: number;
  incompleteCount: number;
} {
  let highPriorityCount = 0;
  let unreadCount = 0;
  let incompleteCount = 0;
  for (const m of messages) {
    const msg = m.message;
    if (msg.priority === 'high') highPriorityCount += 1;
    if (!msg.completed) {
      incompleteCount += 1;
      if ((msg.readCount ?? 0) === 0) unreadCount += 1;
    }
  }
  return { highPriorityCount, unreadCount, incompleteCount };
}

function dedupeByMailId(messages: FlatMessage[]): FlatMessage[] {
  const deduped = new Map<string, FlatMessage>();
  for (const m of messages) {
    const prev = deduped.get(m.message.mailId);
    // Prefer the event copy when both snapshot + event exist for the same
    // mailId — events carry a fresh timestamp + completion flag.
    if (prev === undefined || m.source === 'event') {
      deduped.set(m.message.mailId, m);
    }
  }
  return Array.from(deduped.values()).sort((a, b) =>
    b.message.timestamp.localeCompare(a.message.timestamp),
  );
}

/**
 * Group HQ events and the top-level snapshot counters into per-project
 * flat-message lists, sorted newest-first. Dedupes by `mailId`.
 *
 * @param snapshot   Latest HQ snapshot (or `null` while disconnected).
 * @param events     Live event stream; only `mailbox.event` and
 *                   `mailbox.snapshot` envelopes are consumed.
 */
export function groupMailboxEvents(
  snapshot: Pick<HqSnapshot, 'mailboxes'> | null,
  events: readonly HqEventEnvelope[],
): GroupingResult {
  const seen = new Map<string, ProjectGroup>();

  // 1. Seed groups from the snapshot aggregate so projects that have not
  //    produced a recent mailbox.event still appear with their counters.
  if (snapshot !== null) {
    for (const m of snapshot.mailboxes as readonly HqMailboxSummary[]) {
      const g = ensureGroup(seen, m.projectId);
      g.mailboxId = m.mailboxId;
      g.scope = m.scope;
      g.onlineAgentCount = m.onlineAgentCount;
      g.highPriorityCount = m.highPriorityCount;
      g.unreadCount = m.unreadCount;
      g.incompleteCount = m.incompleteCount;
      g.countersFromSnapshot = true;
    }
  }

  // 2. Walk every mailbox.snapshot envelope to pull its message list.
  for (const evt of events) {
    if (evt.type !== 'mailbox.snapshot' || !isMailboxSnapshot(evt.payload)) continue;
    const snap = evt.payload;
    const g = ensureGroup(seen, evt.projectId);
    g.mailboxId = snap.mailboxId;
    g.scope = snap.scope;
    for (const message of snap.messages) {
      g.messages.push({
        message,
        source: 'snapshot',
        key: `s:${evt.id}:${message.messageId}`,
      });
    }
  }

  // 3. Walk mailbox.event envelopes — these carry the live action verb
  //    (sent/read/completed/updated). Dedupe by mailId during ingestion
  //    so we never insert a duplicate row.
  const mailIndex = new Map<string, ProjectGroup>();
  for (const evt of events) {
    if (evt.type !== 'mailbox.event' || !isMailboxEvent(evt.payload)) continue;
    const p = evt.payload;
    const g = ensureGroup(seen, evt.projectId);
    g.mailboxId = p.mailboxId;
    g.scope = g.scope ?? 'project';
    if (p.message !== undefined && !mailIndex.has(p.message.mailId)) {
      mailIndex.set(p.message.mailId, g);
      g.messages.push({
        message: p.message,
        source: 'event',
        key: `e:${p.message.mailId}:${evt.seq}`,
      });
    }
    if (p.agent?.online) {
      g.onlineAgentCount += 1;
    }
  }

  // 4. Collapse duplicates by mailId + sort newest-first within each group.
  for (const g of seen.values()) {
    g.messages = dedupeByMailId(g.messages);
    // When the snapshot didn't seed us (or only seeded counters), derive
    // high/unread/incomplete from the visible message rows so the UI
    // remains meaningful even mid-reconnect. When we DO have snapshot
    // counters, leave them alone — they're the authoritative totals and
    // would otherwise be inflated by the per-message counts above.
    if (!g.countersFromSnapshot) {
      const derived = deriveCountersFromMessages(g.messages);
      g.highPriorityCount = derived.highPriorityCount;
      g.unreadCount = derived.unreadCount;
      g.incompleteCount = derived.incompleteCount;
    }
  }

  // 5. Sort the project list by the newest message in each group.
  const list = Array.from(seen.values()).sort((a, b) => {
    const aLast = a.messages[0]?.message.timestamp ?? '';
    const bLast = b.messages[0]?.message.timestamp ?? '';
    return bLast.localeCompare(aLast);
  });

  return {
    projects: list,
    hasAnyActivity: list.some((g) => g.messages.length > 0),
  };
}
