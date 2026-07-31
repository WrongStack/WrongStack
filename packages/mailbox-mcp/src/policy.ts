export const MAILBOX_READ_ACTIONS = [
  'query',
  'unread',
  'agents',
  'online_agents',
  'clients',
  'status',
] as const;

export const MAILBOX_MANAGE_ACTIONS = [
  'send',
  'ack',
  'ack_many',
  'soft_delete',
  'restore',
  'register_self',
  'heartbeat_self',
  'deregister_self',
] as const;

export const MAILBOX_ADMIN_ACTIONS = [
  'clear_all',
  'purge_stale',
  'auto_compact',
  'purge_agents',
  'purge_clients',
  'credential_issue',
  'credential_verify',
  'credential_revoke',
  'credential_rotate',
  'credential_get',
  'credential_list',
  'credential_status_counts',
] as const;

export type MailboxReadAction = (typeof MAILBOX_READ_ACTIONS)[number];
export type MailboxManageAction = (typeof MAILBOX_MANAGE_ACTIONS)[number];
export type MailboxAdminAction = (typeof MAILBOX_ADMIN_ACTIONS)[number];
export type MailboxMcpAction = MailboxReadAction | MailboxManageAction | MailboxAdminAction;
export type MailboxMcpToolName =
  | 'mailbox_read'
  | 'mailbox_manage'
  | 'mailbox_admin'
  | 'mailbox_watch';

export interface MailboxMcpPolicyOptions {
  writable?: boolean;
  admin?: boolean;
}

export interface MailboxMcpToolPolicy {
  name: MailboxMcpToolName;
  actions?: readonly MailboxMcpAction[];
}

export function selectMailboxMcpTools(opts: MailboxMcpPolicyOptions = {}): MailboxMcpToolPolicy[] {
  const tools: MailboxMcpToolPolicy[] = [
    { name: 'mailbox_read', actions: MAILBOX_READ_ACTIONS },
    { name: 'mailbox_watch' },
  ];
  if (opts.writable === true || opts.admin === true) {
    tools.push({ name: 'mailbox_manage', actions: MAILBOX_MANAGE_ACTIONS });
  }
  if (opts.admin === true) tools.push({ name: 'mailbox_admin', actions: MAILBOX_ADMIN_ACTIONS });
  return tools;
}
