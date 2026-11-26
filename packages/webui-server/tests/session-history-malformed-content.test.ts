import { describe, expect, it } from 'vitest';
import { buildInspectPayload } from '../src/server/session-history.js';

const fallback = {
  id: 'session-1',
  title: 'audit',
  model: 'model',
  provider: 'provider',
  startedAt: '2026-11-25T00:00:00.000Z',
};
const ts = '2026-11-25T00:00:01.000Z';

/**
 * F2233: journal events are parsed with a shallow guard, so the inspect
 * projection must render a labelled placeholder for a content entry that is not
 * a block instead of throwing out of `session.inspect`.
 */
describe('session inspect projection tolerates malformed content (F2233)', () => {
  it.each([
    ['user_input', { type: 'user_input', ts, content: [null] }],
    [
      'message_appended',
      { type: 'message_appended', ts, version: 1, message: { role: 'user', content: [null] } },
    ],
    ['primitive content entry', { type: 'user_input', ts, content: [42] }],
    ['block without a kind', { type: 'user_input', ts, content: [{ text: 'no kind' }] }],
  ])('renders a placeholder for %s', (_label, event) => {
    const payload = buildInspectPayload(undefined, [event as never], fallback);
    expect(payload.lastUserMessage).toBe('(non-text input)');
    expect(payload.events).toHaveLength(1);
  });

  it('still renders real text, tool and result blocks', () => {
    const payload = buildInspectPayload(
      undefined,
      [
        { type: 'user_input', ts, content: [{ type: 'text', text: 'fix the build' }] },
        {
          type: 'message_appended',
          ts,
          version: 1,
          message: {
            role: 'user',
            content: [
              { type: 'text', text: 'then' },
              { type: 'tool_result', tool_use_id: 't1', content: 'ok' },
            ],
          },
        },
      ] as never,
      fallback,
    );
    expect(payload.lastUserMessage).toBe('then');
    expect(payload.events.map((event) => event.label)).toEqual([
      'User: fix the build',
      'Message appended: user',
    ]);
  });

  it('keeps the surrounding events when a user input has null content', () => {
    const payload = buildInspectPayload(
      undefined,
      [
        { type: 'user_input', ts, content: 'before' },
        { type: 'user_input', ts, content: null },
        { type: 'user_input', ts, content: 'after' },
      ] as never,
      fallback,
    );
    expect(payload.lastUserMessage).toBe('after');
    expect(payload.events.map((event) => event.label)).toEqual([
      'User: before',
      'User: [input]',
      'User: after',
    ]);
  });
});
