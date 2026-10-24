/**
 * The last mailbox snapshot per mailbox, re-announced on every socket open.
 *
 * HQ stores mailbox state on the SOCKET's client record, and mailbox snapshots
 * are only published on a mailbox mutation — so after a reconnect the server's
 * copy was empty and the project's mailbox counters read zero until somebody
 * happened to send a message.
 *
 * @module hq/publisher-mailbox-memory
 */
import type { HqMailboxSnapshotPayload } from './protocol.js';

/** A process has a handful of mailboxes; this only bounds a misbehaving caller. */
const MAX_REMEMBERED_MAILBOXES = 16;

export class MailboxSnapshotMemory {
  private readonly latest = new Map<
    string,
    { payload: HqMailboxSnapshotPayload; sessionId?: string | undefined }
  >();

  remember(payload: HqMailboxSnapshotPayload, sessionId: string | undefined): void {
    this.latest.delete(payload.mailboxId);
    this.latest.set(payload.mailboxId, { payload, sessionId });
    if (this.latest.size > MAX_REMEMBERED_MAILBOXES) {
      const oldest = this.latest.keys().next().value;
      if (oldest !== undefined) this.latest.delete(oldest);
    }
  }

  /** Re-publish every remembered snapshot. Best-effort, like every re-seed. */
  replay(
    publish: (payload: HqMailboxSnapshotPayload, sessionId: string | undefined) => void,
  ): void {
    for (const { payload, sessionId } of this.latest.values()) {
      try {
        publish(payload, sessionId);
      } catch {
        /* one failed re-seed must not stop the rest, nor the connection */
      }
    }
  }
}
