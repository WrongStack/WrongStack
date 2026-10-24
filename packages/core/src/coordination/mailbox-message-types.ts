/**
 * Shared mailbox message DTOs, now defined in `types/mailbox.ts`; re-exported
 * here for the mailbox helpers and the mailbox-types facade.
 */

export type {
  ActorMailboxMessage,
  MailboxAudience,
  MailboxLegacyReportSessionAffinity,
  MailboxMessage,
  MailboxReceiptRecordV2,
  MailboxScopedSessionAffinity,
  MailboxSessionAffinity,
  MailboxTaskContext,
  ReadReceipts,
} from '@wrongstack/contracts/types/mailbox';
