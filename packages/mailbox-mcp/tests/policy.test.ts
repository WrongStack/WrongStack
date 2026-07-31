import { describe, expect, it } from 'vitest';
import {
  MAILBOX_ADMIN_ACTIONS,
  MAILBOX_MANAGE_ACTIONS,
  MAILBOX_READ_ACTIONS,
  selectMailboxMcpTools,
} from '../src/policy.js';

describe('Mailbox MCP policy', () => {
  it('classifies every action exactly once', () => {
    const actions = [...MAILBOX_READ_ACTIONS, ...MAILBOX_MANAGE_ACTIONS, ...MAILBOX_ADMIN_ACTIONS];
    expect(new Set(actions).size).toBe(actions.length);
  });

  it('is read and watch only by default', () => {
    expect(selectMailboxMcpTools().map((tool) => tool.name)).toEqual([
      'mailbox_read',
      'mailbox_watch',
    ]);
  });

  it('adds management without administration for writable mode', () => {
    expect(selectMailboxMcpTools({ writable: true }).map((tool) => tool.name)).toEqual([
      'mailbox_read',
      'mailbox_watch',
      'mailbox_manage',
    ]);
  });

  it('makes admin a superset of writable mode', () => {
    expect(selectMailboxMcpTools({ admin: true }).map((tool) => tool.name)).toEqual([
      'mailbox_read',
      'mailbox_watch',
      'mailbox_manage',
      'mailbox_admin',
    ]);
  });
});
