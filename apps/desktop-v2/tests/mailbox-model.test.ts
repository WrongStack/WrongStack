import { describe, expect, it } from 'vitest';
import { MailboxDraftStore, mailboxDraftStore } from '../src/mailbox-draft';
import { emptyMailDraft, mailboxDuration, mailboxThreads, unreadMail } from '../src/mailbox-model';

describe('project mailbox', () => {
  it('groups replies, missing parents and cycles without creating phantom messages', () => {
    const messages = [
      { id: 'a', timestamp: 1 },
      { id: 'b', replyTo: 'a', timestamp: 2 },
      { id: 'c', replyTo: 'b', timestamp: 3 },
      { id: 'orphan', replyTo: 'missing', timestamp: 4 },
      { id: 'x', replyTo: 'y', timestamp: 5 },
      { id: 'y', replyTo: 'x', timestamp: 6 },
    ];
    const groups = mailboxThreads(messages);
    expect(groups.map((thread) => thread.id)).toEqual(['x', 'missing', 'a']);
    expect(
      groups.find((thread) => thread.id === 'a')?.items.map((message) => message['id']),
    ).toEqual(['a', 'b', 'c']);
    expect(groups.find((thread) => thread.id === 'missing')?.missingParent).toBe(true);
    expect(groups.flatMap((thread) => thread.items)).toHaveLength(messages.length);
  });
  it('uses the canonical unread meaning rather than assuming any open message is unread', () => {
    expect(unreadMail({ completed: true, readByCount: 0 })).toBe(false);
    expect(unreadMail({ completed: false, readByCount: 2, readBy: {} })).toBe(false);
    expect(unreadMail({ completed: false, readByCount: 0 })).toBe(true);
  });
  it.each(['', '-1', 'Infinity', 'NaN', '9007199254740992'])(
    'rejects invalid maintenance duration %s',
    (hours) => {
      expect(() => mailboxDuration(hours, 'Age')).toThrow();
    },
  );
  it.each([
    ['0', 0],
    ['0.5', 1_800_000],
    ['1.1', 3_960_000],
    ['2.3', 8_280_000],
    ['0.3', 1_080_000],
    ['24', 86_400_000],
  ])('accepts %s hours as whole milliseconds', (hours, ms) => {
    expect(mailboxDuration(hours, 'Age')).toBe(ms);
  });
  it('preserves a failed send draft, refuses duplicate pending sends and publishes acknowledgement across views', () => {
    const store = new MailboxDraftStore();
    const draft = { ...emptyMailDraft(), subject: 'Retain this', body: 'Unsent content' };
    store.update(draft);
    const submitted = store.begin();
    expect(() => store.begin()).toThrow('already awaiting');
    store.update(emptyMailDraft());
    expect(store.snapshot().draft).toBe(draft);
    store.fail(Error('Detached workspace'));
    expect(store.snapshot().error).toContain('Check recent mailbox');
    expect(store.snapshot().draft).toBe(draft);
    store.begin();
    store.acknowledge(submitted);
    expect(store.snapshot().pending).toBe(false);
    expect(store.snapshot().draft.body).toBe('');
  });
  it('keeps shared draft ownership within one project', () => {
    const id = crypto.randomUUID();
    expect(mailboxDraftStore(id)).toBe(mailboxDraftStore(id));
    expect(mailboxDraftStore(id)).not.toBe(mailboxDraftStore(crypto.randomUUID()));
  });
  it('words an invalid maintenance duration through the given words', () => {
    expect(() => mailboxDuration('-1', 'Age')).toThrow(
      'Age must be a non-negative number of hours.',
    );
    expect(() => mailboxDuration('-1', 'Yaş', (label) => `${label}: geçersiz`)).toThrow(
      'Yaş: geçersiz',
    );
  });
});
