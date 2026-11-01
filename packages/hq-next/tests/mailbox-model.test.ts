import type { FlatMessage } from '@hq/domain/mailbox-grouping';
import type { HqMailboxMessageSummary, HqMailboxSummary } from '@wrongstack/hq';
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_FILTERS,
  filterMail,
  isUnread,
  mailFigures,
  mailTypeLabel,
  replyDraft,
} from '../src/features/mailbox/model';

const mail = (
  mailId: string,
  extra: Partial<HqMailboxMessageSummary> = {},
  projectId = 'p1',
): FlatMessage => ({
  key: mailId,
  source: 'event',
  projectId,
  message: {
    mailId,
    messageId: `msg-${mailId}`,
    from: 'builder',
    to: 'leader',
    scope: 'project',
    type: 'note',
    subject: `Subject ${mailId}`,
    priority: 'normal',
    timestamp: '2026-10-31T10:00:00.000Z',
    completed: false,
    hasBody: true,
    bodyPreview: 'tests are green',
    ...extra,
  } as HqMailboxMessageSummary,
});

describe('mailbox unread and labels', () => {
  it('treats a message as unread until someone read or completed it', () => {
    expect(isUnread({ completed: false })).toBe(true);
    expect(isUnread({ completed: false, readCount: 0 })).toBe(true);
    expect(isUnread({ completed: false, readCount: 2 })).toBe(false);
    expect(isUnread({ completed: true })).toBe(false);
  });

  it('names types in words and keeps unknown ones', () => {
    expect(mailTypeLabel('ask')).toBe('Question');
    expect(mailTypeLabel('btw')).toBe('FYI');
    expect(mailTypeLabel('custom')).toBe('custom');
  });
});

describe('filterMail', () => {
  const messages = [
    mail('a'),
    mail('b', { completed: true }),
    mail('c', { type: 'ask', priority: 'high' }, 'p2'),
    mail('d', { subject: 'Deploy window', bodyPreview: 'tonight' }),
  ];
  const ids = (list: FlatMessage[]) => list.map((flat) => flat.message.mailId);

  it('hides done messages unless asked', () => {
    expect(ids(filterMail(messages, DEFAULT_FILTERS))).toEqual(['a', 'c', 'd']);
    expect(ids(filterMail(messages, { ...DEFAULT_FILTERS, showDone: true }))).toHaveLength(4);
  });

  it('narrows by project, type and priority', () => {
    expect(ids(filterMail(messages, { ...DEFAULT_FILTERS, projectId: 'p2' }))).toEqual(['c']);
    expect(ids(filterMail(messages, { ...DEFAULT_FILTERS, type: 'ask' }))).toEqual(['c']);
    expect(ids(filterMail(messages, { ...DEFAULT_FILTERS, priority: 'high' }))).toEqual(['c']);
  });

  it('matches every search word across subject and body', () => {
    expect(ids(filterMail(messages, { ...DEFAULT_FILTERS, query: 'deploy TONIGHT' }))).toEqual([
      'd',
    ]);
    expect(ids(filterMail(messages, { ...DEFAULT_FILTERS, query: 'deploy green' }))).toEqual([]);
  });
});

describe('mailFigures', () => {
  it('sums the server totals across mailboxes', () => {
    const box = (unread: number, open: number): HqMailboxSummary =>
      ({
        mailboxId: 'm',
        projectId: 'p',
        scope: 'project',
        messageCount: 10,
        unreadCount: unread,
        incompleteCount: open,
        highPriorityCount: 1,
        onlineAgentCount: 2,
      }) as HqMailboxSummary;
    expect(mailFigures([box(1, 3), box(2, 0)])).toEqual({
      messages: 20,
      unread: 3,
      open: 3,
      high: 2,
      onlineAgents: 4,
    });
  });
});

describe('replyDraft', () => {
  it('answers the sender in the same project and prefixes the subject once', () => {
    const draft = replyDraft(mail('a', { from: 'reviewer', subject: 'Diff ready' }, 'p9'), 'p1');
    expect(draft).toMatchObject({ projectId: 'p9', to: 'reviewer', subject: 'Re: Diff ready' });
    expect(replyDraft(mail('b', { subject: 're: Diff ready' }), 'p1').subject).toBe(
      're: Diff ready',
    );
  });

  it('answers a question with a result and keeps high priority', () => {
    const draft = replyDraft(mail('c', { type: 'ask', priority: 'high' }), 'p1');
    expect(draft.type).toBe('result');
    expect(draft.priority).toBe('high');
  });
});
