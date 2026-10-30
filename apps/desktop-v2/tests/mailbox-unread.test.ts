import { expect, it } from 'vitest';
import { MAILBOX_UNREAD_PAGE, mailboxUnreadSummary } from '../src/MailboxUnread';

it('counts only messages nobody has read and names the newest', () => {
  expect(
    mailboxUnreadSummary([
      { from: 'scout', subject: 'Old', timestamp: 1, readBy: {} },
      { from: 'leader', subject: 'Newest', timestamp: '1970-01-01T00:00:00.005Z', readBy: {} },
      { from: 'coder', subject: 'Read', timestamp: 9, readBy: { desktop: 9 } },
      { from: 'coder', subject: 'Done', timestamp: 10, completed: true, readBy: {} },
    ]),
  ).toEqual({ count: '2', latest: { from: 'leader', subject: 'Newest' } });
  expect(mailboxUnreadSummary([])).toEqual({ count: '0', latest: null });
  expect(mailboxUnreadSummary([{ timestamp: 1, readBy: {} }]).latest).toEqual({
    from: 'unknown sender',
    subject: '(no subject)',
  });
});

it('says "100+" when a full page is unread', () => {
  const page = Array.from({ length: MAILBOX_UNREAD_PAGE }, (_, index) => ({
    from: 'a',
    subject: `m${index}`,
    timestamp: index,
    readBy: {},
  }));
  expect(mailboxUnreadSummary(page).count).toBe('100+');
});
