import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import type { MailboxMessageProjection } from '../src/mailbox-types.js';
import { SqliteMailbox } from '../src/sqlite-mailbox.js';

it('persists prototype-named actors as ordinary receipt keys across reopen and repeated acknowledgement', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'mailbox-receipt-keys-'));
  let box = new SqliteMailbox(dir);
  try {
    const message = await box.send({
      from: 'sender',
      to: '*',
      type: 'note',
      subject: 'fixture',
      body: 'fixture',
    });
    const actors = ['worker-a', '__proto__', 'constructor', 'toString', 'hasOwnProperty'];
    for (const actor of actors) {
      await box.ack({ messageId: message.id, readerId: actor, completed: true });
      await box.ack({ messageId: message.id, readerId: actor, completed: true });
    }
    await box.close();
    box = new SqliteMailbox(dir);
    const [projection] = (await box.query({
      ids: [message.id],
      includeReceiptState: true,
    })) as MailboxMessageProjection[];
    for (const actor of actors) {
      expect(Object.hasOwn(projection!.recipientState, actor)).toBe(true);
      expect(projection!.recipientState[actor]).toMatchObject({
        actorId: actor,
        completedBy: actor,
      });
      expect(Object.hasOwn(projection!.readBy, actor)).toBe(true);
    }
    await box.ack({ messageId: message.id, readerId: '__proto__', read: false, completed: false });
    expect(
      await box.query({ ids: [message.id], unreadBy: '__proto__', incompleteOnly: true }),
    ).toHaveLength(1);
    expect(
      await box.query({ ids: [message.id], unreadBy: 'constructor', incompleteOnly: true }),
    ).toHaveLength(0);
  } finally {
    await box.close();
    await rm(dir, { recursive: true, force: true });
  }
});
