import type { MailboxMessage } from '@wrongstack/contracts/types/mailbox';
import { describe, expect, it } from 'vitest';
import { createMailboxSnapshotPayload } from '../src/mailbox-mapper.js';

describe('createMailboxSnapshotPayload negative limit guard (F1989)', () => {
  it('clamps negative limit to 0 instead of slicing from the end', () => {
    const msgs = [
      {
        id: '1',
        from: 'a',
        to: 'b',
        type: 'note',
        subject: 's1',
        body: 'b1',
        priority: 'normal',
        timestamp: '2026-01-01T00:00:01Z',
        completed: false,
        readBy: {},
      },
      {
        id: '2',
        from: 'a',
        to: 'b',
        type: 'note',
        subject: 's2',
        body: 'b2',
        priority: 'normal',
        timestamp: '2026-01-01T00:00:02Z',
        completed: false,
        readBy: {},
      },
    ] as unknown as MailboxMessage[];
    expect(createMailboxSnapshotPayload(msgs, [], { mailboxId: 'm', limit: -1 }).messages).toEqual(
      [],
    );
    expect(
      createMailboxSnapshotPayload(msgs, [], { mailboxId: 'm', limit: 1 }).messages,
    ).toHaveLength(1);
  });
});
