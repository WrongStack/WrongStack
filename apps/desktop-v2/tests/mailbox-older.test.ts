import { expect, it } from 'vitest';
import { oldestMailTimestamp, withOlderMail } from '../src/mailbox-model';

const mail = (id: string, timestamp: string) => ({ id, timestamp });

it('reads older mailbox pages from the oldest loaded timestamp without duplicates', () => {
  const loaded = [mail('c', '2026-10-29T10:00:03Z'), mail('b', '2026-10-29T10:00:02Z')];
  expect(oldestMailTimestamp(loaded)).toBe('2026-10-29T10:00:02Z');
  expect(oldestMailTimestamp([{ id: 'x', timestamp: 'not a time' }])).toBeNull();
  const next = withOlderMail(
    loaded,
    [mail('b', '2026-10-29T10:00:02Z'), mail('a', '2026-10-29T10:00:01Z')],
    2,
  );
  expect(next.messages.map((m) => m['id'])).toEqual(['c', 'b', 'a']);
  expect(next).toMatchObject({ added: 1, complete: false });
  // Only messages already loaded came back in a short page: nothing older remains.
  expect(withOlderMail(next.messages, [mail('a', '2026-10-29T10:00:01Z')], 2)).toMatchObject({
    added: 0,
    complete: true,
    stuck: false,
  });
  // A full page of already-loaded messages cannot move the bound.
  expect(
    withOlderMail(
      next.messages,
      [mail('a', '2026-10-29T10:00:01Z'), mail('b', '2026-10-29T10:00:02Z')],
      2,
    ),
  ).toMatchObject({ added: 0, complete: false, stuck: true });
});
