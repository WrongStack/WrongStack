import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { MAILBOX_MAX_QUERY_LIMIT } from '../src/mailbox-constants.js';
import {
  isMessageUnreadForActor,
  type MailboxActorReadScope,
  queryMessagesForActor,
  unreadCountForActor,
} from '../src/mailbox-http-actor-query.js';
import type { MailboxMessageProjection } from '../src/mailbox-types.js';
import { SqliteMailbox } from '../src/sqlite-mailbox.js';

const ACTOR: MailboxActorReadScope = {
  actorId: 'agent-b',
  recipientAliases: new Set(['agent-b']),
};

function projection(overrides: Partial<MailboxMessageProjection> = {}): MailboxMessageProjection {
  return {
    id: 'msg-1',
    from: 'agent-a',
    to: 'agent-b',
    type: 'note',
    subject: 'subject',
    body: 'body',
    priority: 'normal',
    timestamp: '2026-07-16T00:00:00.000Z',
    readBy: {},
    completed: false,
    recipientState: {},
    ...overrides,
  };
}

describe('unreadCountForActor', () => {
  let dir: string;
  let mailbox: SqliteMailbox;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'mailbox-actor-query-'));
    mailbox = new SqliteMailbox(dir);
  });

  afterEach(async () => {
    await mailbox.close();
    await rm(dir, { recursive: true, force: true });
  });

  it('counts EVERY unread message, not only the first page', async () => {
    // More unread mail than MAILBOX_MAX_QUERY_LIMIT: a capped or
    // forward-paged count saturates at the cap instead of the real total.
    const total = MAILBOX_MAX_QUERY_LIMIT + 5;
    for (let index = 0; index < total; index += 1) {
      await mailbox.send({
        from: 'agent-a',
        to: 'agent-b',
        type: 'note',
        subject: `bulk ${index}`,
        body: `body ${index}`,
        priority: 'normal',
      });
    }

    expect(await unreadCountForActor(mailbox, ACTOR)).toBe(total);
  });

  it('excludes messages this actor already read', async () => {
    const sent = [];
    for (let index = 0; index < 3; index += 1) {
      sent.push(
        await mailbox.send({
          from: 'agent-a',
          to: 'agent-b',
          type: 'note',
          subject: `bulk ${index}`,
          body: `body ${index}`,
          priority: 'normal',
        }),
      );
    }
    await mailbox.ackMany({
      acks: [{ messageId: sent[0]?.id ?? '', readerId: 'agent-b', read: true, completed: false }],
    });

    expect(await unreadCountForActor(mailbox, ACTOR)).toBe(2);
  });

  it('does not count messages addressed to another actor', async () => {
    await mailbox.send({
      from: 'agent-a',
      to: 'agent-c',
      type: 'note',
      subject: 'for someone else',
      body: 'body',
      priority: 'normal',
    });

    expect(await unreadCountForActor(mailbox, ACTOR)).toBe(0);
  });

  it('does not starve visible messages under limit when newer leader-only broadcasts exist', async () => {
    const visible = await mailbox.send({
      from: 'leader',
      to: 'agent-b',
      type: 'note',
      subject: 'visible to agent-b',
      body: 'body',
      priority: 'normal',
    });
    await new Promise((r) => setTimeout(r, 5));
    await mailbox.send({
      from: 'leader',
      to: '*',
      type: 'broadcast',
      audience: 'leaders',
      subject: 'leaders only',
      body: 'body',
      priority: 'normal',
    });

    const result = await queryMessagesForActor(mailbox, ACTOR, { limit: 1 });
    expect(result).toHaveLength(1);
    expect(result[0]?.id).toBe(visible.id);
  });
});

describe('isMessageUnreadForActor', () => {
  it('treats a message read by ANOTHER actor as unread for this actor', () => {
    const message = projection({
      recipientState: {
        'agent-c': { actorId: 'agent-c', readAt: '2026-07-16T00:00:01.000Z' },
      },
    });

    expect(isMessageUnreadForActor(message, 'agent-b')).toBe(true);
  });

  it('treats a message read by THIS actor as read', () => {
    const message = projection({ readBy: { 'agent-b': '2026-07-16T00:00:01.000Z' } });

    expect(isMessageUnreadForActor(message, 'agent-b')).toBe(false);
  });

  it('treats a message completed by THIS actor as not unread', () => {
    const message = projection({
      recipientState: {
        'agent-b': {
          actorId: 'agent-b',
          readAt: '2026-07-16T00:00:01.000Z',
          completedAt: '2026-07-16T00:00:02.000Z',
        },
      },
    });

    expect(isMessageUnreadForActor(message, 'agent-b')).toBe(false);
  });

  it('treats a message completed by ANOTHER actor as still unread', () => {
    const message = projection({
      recipientState: {
        'agent-c': {
          actorId: 'agent-c',
          completedAt: '2026-07-16T00:00:02.000Z',
        },
      },
    });

    expect(isMessageUnreadForActor(message, 'agent-b')).toBe(true);
  });

  it('treats legacy global completion as completed for every actor', () => {
    const message = projection({ legacyGlobalCompletion: true });

    expect(isMessageUnreadForActor(message, 'agent-b')).toBe(false);
  });
});
