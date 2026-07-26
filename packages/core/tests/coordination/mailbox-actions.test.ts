import { describe, expect, it } from 'vitest';
import { actionToAckInput } from '../../src/coordination/mailbox-actions.js';

describe('actionToAckInput', () => {
  it('converts mark-read action', () => {
    const result = actionToAckInput('mark-read', {
      action: 'mark-read',
      mailId: 'msg-1',
      readerId: 'agent-1',
    });
    expect(result).toEqual({
      messageId: 'msg-1',
      readerId: 'agent-1',
      read: true,
    });
  });

  it('converts acknowledge action', () => {
    const result = actionToAckInput('acknowledge', {
      action: 'acknowledge',
      mailId: 'msg-2',
      readerId: 'agent-2',
    });
    expect(result).toEqual({
      messageId: 'msg-2',
      readerId: 'agent-2',
      read: true,
      completed: true,
    });
  });

  it('converts reopen action', () => {
    const result = actionToAckInput('reopen', {
      action: 'reopen',
      mailId: 'msg-3',
      readerId: 'agent-3',
    });
    expect(result).toEqual({
      messageId: 'msg-3',
      readerId: 'agent-3',
      read: false,
      completed: false,
    });
  });

  it('passes optional note through action input', () => {
    const result = actionToAckInput('acknowledge', {
      action: 'acknowledge',
      mailId: 'msg-4',
      readerId: 'agent-4',
      note: 'Triaged — will follow up.',
    });
    expect(result).toEqual({
      messageId: 'msg-4',
      readerId: 'agent-4',
      read: true,
      completed: true,
    });
  });

  it('accepts requestId in input (for idempotency)', () => {
    const result = actionToAckInput('mark-read', {
      action: 'mark-read',
      mailId: 'msg-5',
      readerId: 'agent-5',
      requestId: 'req-123',
    });
    expect(result).toEqual({
      messageId: 'msg-5',
      readerId: 'agent-5',
      read: true,
    });
  });
});
