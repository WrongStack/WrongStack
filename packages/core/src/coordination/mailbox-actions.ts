/**
 * Mailbox message action helpers.
 *
 * Declares the {@link MailboxMessageAction} union (the verb that a user
 * or agent issues against a single message) and the per-action input
 * shapes. The implementations live on the `Mailbox` interface:
 *   - `mark-read` / `acknowledge` / `reopen` → {@link Mailbox.ack}
 *     / {@link Mailbox.ackMany}
 *   - `soft-delete` → {@link Mailbox.softDelete}
 *   - `restore`     → {@link Mailbox.restore}
 *
 * Keeping the verb+input types in their own file means the WebUI client
 * and the server route handlers can import them independently of the
 * `Mailbox` implementation, and a future "message actions" CLI
 * subcommand only has to add one verb to a single place.
 */
import type { MailboxAckInput, MailboxMessage } from './mailbox-types.js';

/**
 * High-level verbs the WebUI/server route handlers expose. The
 * mapping to underlying `MailboxAckInput` is straightforward:
 *   - `mark-read`  → `ack({ read: true })`
 *   - `acknowledge`→ `ack({ read: true, completed: true })`
 *   - `reopen`     → `ack({ read: false, completed: false })`
 *   - `soft-delete`→ not an `ack` — a separate `Mailbox.softDelete()`
 *     that flips `deletedAt` to "now" (recoverable) and is filtered
 *     out of the default `query()`.
 *   - `restore`    → the inverse of `soft-delete`. Undoes a
 *     `softDelete` by clearing `deletedAt`.
 */
export type MailboxMessageAction =
  | 'mark-read'
  | 'acknowledge'
  | 'reopen'
  | 'soft-delete'
  | 'restore';

/** Per-action request body sent from the WebUI → server route. */
export interface MailboxActionInput {
  action: MailboxMessageAction;
  mailId: string;
  /** Acting agent / user. Required by the server to stamp
   *  `readBy` / `completedBy`. */
  readerId: string;
  /** Optional human note (e.g. "triaged — will follow up"). */
  note?: string | undefined;
  /** Optional idempotency key so retried requests don't double-apply
   *  the action. Phase 4 wires this through to the CLI. */
  requestId?: string | undefined;
}

/** Per-action response. Echoes the action + the resulting message
 *  state so the UI can reconcile optimistic updates. */
export interface MailboxActionResult {
  action: MailboxMessageAction;
  mailId: string;
  /** Updated message snapshot. `null` if the message was already in
   *  the target state (e.g. `mark-read` on a message the user has
   *  already read) — the WebUI can ignore the result in that case. */
  message: MailboxMessage | null;
  /** True if the action actually mutated state; false if it was a
   *  no-op. Lets the WebUI decide whether to update its local copy. */
  changed: boolean;
}

/**
 * Convert a high-level action into the underlying
 * {@link MailboxAckInput} the existing `Mailbox.ack` already
 * supports. `soft-delete` and `restore` do NOT go through `ack` —
 * the caller must dispatch them to `Mailbox.softDelete` /
 * `Mailbox.restore` instead. This helper returns `null` for
 * those two so the type signature forces the caller to handle them
 * separately.
 */
export function actionToAckInput(
  action: Exclude<MailboxMessageAction, 'soft-delete' | 'restore'>,
  input: MailboxActionInput,
): MailboxAckInput {
  switch (action) {
    case 'mark-read':
      return { messageId: input.mailId, readerId: input.readerId, read: true };
    case 'acknowledge':
      return { messageId: input.mailId, readerId: input.readerId, read: true, completed: true };
    case 'reopen':
      return { messageId: input.mailId, readerId: input.readerId, read: false, completed: false };
  }
}
