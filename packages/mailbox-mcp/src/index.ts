export {
  createMailboxMcpServer,
  createMailboxMcpToolHost,
  type MailboxMcpToolHostOptions,
} from './adapter.js';
export {
  MAILBOX_ADMIN_ACTIONS,
  MAILBOX_MANAGE_ACTIONS,
  MAILBOX_READ_ACTIONS,
  type MailboxAdminAction,
  type MailboxManageAction,
  type MailboxMcpAction,
  type MailboxMcpPolicyOptions,
  type MailboxMcpToolName,
  type MailboxReadAction,
  selectMailboxMcpTools,
} from './policy.js';
export { SERVER_INFO } from './version.js';
