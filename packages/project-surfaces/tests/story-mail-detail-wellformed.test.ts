import { describe, expect, it } from 'vitest';
import { buildSessionStory } from '../src/story/session-story.js';

const ROCKET = '\u{1F680}';

const mail = (body: string) => [
  {
    id: 'm1',
    from: 'leader',
    to: 'worker',
    type: 'report',
    subject: 'subj',
    body,
    priority: 'normal',
    timestamp: '2026-01-01T00:00:00.000Z',
    senderSessionId: 'sess-1',
    readBy: {},
    audience: 'all',
    completed: false,
  },
];

const mailEvent = (body: string) =>
  buildSessionStory('sess-1', [], [], mail(body) as never, [], '').events.find(
    (event) => event.kind === 'mail',
  );

/**
 * F2658: the story view renders the mail body as the event detail, cut at 3000
 * UTF-16 units with a plain `slice`. A body whose astral character straddles the
 * cut leaves a lone surrogate in the rendered detail.
 */
describe('session-story mail detail keeps valid UTF-16 (F2658)', () => {
  it('drops the orphaned half in a long mail body', () => {
    const event = mailEvent(`${'b'.repeat(2999)}${ROCKET}tail`);

    expect(event?.detail.isWellFormed()).toBe(true);
  });

  it('keeps a short body unchanged (control)', () => {
    const event = mailEvent('short body');

    expect(event?.detail).toContain('short body');
  });
});
