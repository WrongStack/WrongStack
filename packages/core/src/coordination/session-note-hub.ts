/**
 * SessionNoteHub — in-process, same-session delivery for agent notes.
 *
 * Mailbox is the durable, cross-session letter. This hub is the live talk
 * channel: register an inbox per running agent, post a note, the recipient
 * folds it at its next iteration. Fail-closed on session id. No disk, no
 * capability.mail, no wait.
 *
 * @module session-note-hub
 */

import type { EventBus } from '../kernel/events.js';
import type { SessionNote, SessionNoteKind } from '../core/session-notes.js';
import { mailboxIdentityBase } from './mailbox-types.js';

export interface SessionNotePost {
  sessionId: string;
  from: string;
  /** `leader`, a live agent id, `@session`, or `*` (session-local broadcast). */
  to: string;
  kind: SessionNoteKind;
  body: string;
  subject?: string | undefined;
  /** Observability bus (typically the leader/session bus). */
  events?: EventBus | undefined;
}

export interface SessionNoteInbox {
  sessionId: string | (() => string | undefined);
  agentId: string;
  aliases?: readonly string[] | undefined;
  deliver: (note: SessionNote) => void;
  /** First bus registered for a session is used to emit `session.note`. */
  events?: EventBus | undefined;
}

export interface SessionNotePostResult {
  delivered: number;
}

function resolveInboxSessionId(inbox: SessionNoteInbox): string | undefined {
  return typeof inbox.sessionId === 'function' ? inbox.sessionId() : inbox.sessionId;
}

function identityKeys(inbox: SessionNoteInbox): Set<string> {
  const keys = new Set<string>();
  const add = (raw: string) => {
    // `post` fans out over every inbox; one registration with a missing id
    // must not throw the whole delivery loop before the others are reached.
    if (typeof raw !== 'string') return;
    const value = raw.trim().toLowerCase();
    if (!value) return;
    keys.add(value);
    keys.add(mailboxIdentityBase(value).toLowerCase());
  };
  add(inbox.agentId);
  for (const alias of inbox.aliases ?? []) add(alias);
  return keys;
}

export class SessionNoteHub {
  private readonly inboxes = new Set<SessionNoteInbox>();
  private readonly buses = new Map<string, EventBus>();
  /**
   * Live contributing inboxes per session id. When a session's count drops to
   * zero its `buses` entry is removed — otherwise this process-wide singleton
   * would retain a torn-down agent's EventBus (and everything its listeners
   * close over) for every session id it has ever seen.
   */
  private readonly busRefCounts = new Map<string, number>();

  register(inbox: SessionNoteInbox): () => void {
    this.inboxes.add(inbox);
    const rawSid = resolveInboxSessionId(inbox);
    const sid = rawSid ? rawSid.trim().replace(/\\/g, '/') : undefined;
    const contributes = Boolean(sid && inbox.events);
    if (sid && inbox.events) {
      this.busRefCounts.set(sid, (this.busRefCounts.get(sid) ?? 0) + 1);
      if (!this.buses.has(sid)) this.buses.set(sid, inbox.events);
    }
    let disposed = false;
    return () => {
      if (disposed) return;
      disposed = true;
      this.inboxes.delete(inbox);
      if (contributes && sid) {
        const remaining = (this.busRefCounts.get(sid) ?? 1) - 1;
        if (remaining <= 0) {
          this.busRefCounts.delete(sid);
          this.buses.delete(sid);
        } else {
          this.busRefCounts.set(sid, remaining);
        }
      }
    };
  }

  post(input: SessionNotePost): SessionNotePostResult {
    const sessionId = input.sessionId.trim().replace(/\\/g, '/');
    const body = input.body.trim();
    if (!sessionId || !body) return { delivered: 0 };

    const to = input.to.trim().toLowerCase();
    const from = input.from.trim() || 'unknown';
    const broadcast = to === '@session' || to === '*' || to === 'all';
    const note: SessionNote = {
      from,
      kind: input.kind,
      body,
      ...(input.subject?.trim() ? { subject: input.subject.trim() } : {}),
    };

    let delivered = 0;
    const fromKey = from.toLowerCase();
    for (const inbox of this.inboxes) {
      const inboxSid = resolveInboxSessionId(inbox)?.trim().replace(/\\/g, '/');
      if (inboxSid !== sessionId) continue;
      const keys = identityKeys(inbox);
      if (keys.has(fromKey)) continue;
      if (!broadcast && !keys.has(to)) continue;
      try {
        inbox.deliver(note);
        delivered += 1;
      } catch {
        // A broken inbox must not drop the rest of the fan-out.
      }
    }

    try {
      const bus = input.events ?? this.buses.get(sessionId);
      bus?.emit('session.note', {
        sessionId,
        from,
        to: input.to.trim(),
        kind: input.kind,
        body: note.body,
        subject: note.subject,
        ts: Date.now(),
      });
    } catch {
      // Observability must never fail the post.
    }

    return { delivered };
  }
}

/** Process-wide hub. Agent loops register; tools and hosts post. */
export const sessionNoteHub = new SessionNoteHub();

export function postSessionNote(input: SessionNotePost): SessionNotePostResult {
  return sessionNoteHub.post(input);
}
