/**
 * An unrelated actor's read-only ack must not erase the message-level
 * completion outcome recorded by the addressee.
 */
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { MailboxMessageProjection } from '../src/mailbox-types.js';
import { SqliteMailbox } from '../src/sqlite-mailbox.js';

let dir: string;
let mb: SqliteMailbox;

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'mailbox-ack-outcome-'));
  mb = new SqliteMailbox(dir);
});

afterEach(async () => {
  await mb.close().catch(() => undefined);
  await fs.rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
});

async function addressedMessage() {
  return mb.send({
    from: 'leader@sess',
    to: 'worker@sess',
    type: 'ask',
    subject: 's',
    body: 'b',
  } as never);
}

// The query read path materializes receipt projections, even though the
// public Mailbox interface types the result as MailboxMessage[].
const readBack = async (id: string) =>
  (await mb.query({ ids: [id], includeReceiptState: true }))[0] as
    | MailboxMessageProjection
    | undefined;

describe('message-level outcome on ack', () => {
  it('records the addressee completion outcome', async () => {
    const sent = await addressedMessage();
    await mb.ack({
      messageId: sent.id,
      readerId: 'worker@sess',
      read: true,
      completed: true,
      outcome: 'fixed',
    } as never);
    const msg = await readBack(sent.id);
    expect(msg?.completed).toBe(true);
    expect(msg?.outcome).toBe('fixed');
    expect(msg?.recipientState?.['worker@sess']?.outcome).toBe('fixed');
  });

  it('preserves the outcome when another actor only reads', async () => {
    const sent = await addressedMessage();
    await mb.ack({
      messageId: sent.id,
      readerId: 'worker@sess',
      read: true,
      completed: true,
      outcome: 'fixed',
    } as never);

    await mb.ack({ messageId: sent.id, readerId: 'observer@sess', read: true } as never);

    const msg = await readBack(sent.id);
    expect(msg?.outcome).toBe('fixed');
    expect(msg?.recipientState?.['worker@sess']?.outcome).toBe('fixed');
    expect(msg?.recipientState?.['observer@sess']?.readAt).toBeTypeOf('string');
  });

  it('lets the completer update or reopen its outcome', async () => {
    const sent = await addressedMessage();
    await mb.ack({
      messageId: sent.id,
      readerId: 'worker@sess',
      read: true,
      completed: true,
      outcome: 'first',
    } as never);
    await mb.ack({
      messageId: sent.id,
      readerId: 'worker@sess',
      outcome: 'second',
    } as never);
    expect((await readBack(sent.id))?.outcome).toBe('second');

    await mb.ack({
      messageId: sent.id,
      readerId: 'worker@sess',
      read: false,
      completed: false,
    } as never);
    expect((await readBack(sent.id))?.completed).toBe(false);
  });
});
