import type { HqEventEnvelope } from '@wrongstack/hq';
import { describe, expect, it } from 'vitest';
import { groupMailboxEvents } from '../src/domain/mailbox-grouping.js';

const message = {
  mailId: 'mail',
  messageId: 'msg',
  timestamp: '2026-10-04T00:00:00Z',
  from: 'a',
  to: 'b',
  type: 'note',
  priority: 'normal',
  subject: 'control',
  completed: false,
  readCount: 0,
};
const event = (body: Record<string, unknown>): HqEventEnvelope =>
  ({
    id: 'e',
    seq: 1,
    projectId: 'p',
    type: 'mailbox.event',
    payload: { mailboxId: 'mb', action: 'message.sent', ...body },
  }) as unknown as HqEventEnvelope;
describe('HQ nested Mailbox payloads', () => {
  it.each([
    { message: null },
    { message: [] },
    { message: {} },
    { agent: null },
    { agent: [] },
    { agent: { agentId: 1 } },
  ])('drops malformed nested records %j', (body) => {
    expect(groupMailboxEvents(null, [event(body)]).projects).toEqual([]);
  });
  it('keeps valid event rows and valid snapshot rows next to malformed ones', () => {
    expect(groupMailboxEvents(null, [event({ message })]).projects[0]?.messages).toHaveLength(1);
    const snapshot = {
      id: 'snap',
      seq: 0,
      projectId: 'p',
      type: 'mailbox.snapshot',
      payload: {
        mailboxId: 'mb',
        scope: 'project',
        messages: [null, [], {}, message],
        agents: [],
        totals: {},
      },
    } as unknown as HqEventEnvelope;
    expect(groupMailboxEvents(null, [snapshot]).projects[0]?.messages).toHaveLength(1);
    expect(
      groupMailboxEvents(null, [event({ agent: { agentId: 'a', online: true } })]).projects[0]
        ?.onlineAgentCount,
    ).toBe(1);
  });
});
