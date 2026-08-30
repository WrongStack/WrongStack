import { describe, expect, it } from 'vitest';
import { applyContextSnapshot, replayableMessage } from '../../src/storage/session-store/replay.js';
import { scrubSessionWriterEvent } from '../../src/storage/session-writer-scrubber.js';
import type { Message } from '../../src/types/messages.js';
import type { SecretScrubber } from '../../src/types/secret-scrubber.js';
import type { SessionEvent } from '../../src/types/session.js';

const markerScrubber: SecretScrubber = {
  scrub: (text) => text.replaceAll('SECRET_VALUE', '[REDACTED]'),
  scrubObject: <T>(obj: T): T =>
    JSON.parse(JSON.stringify(obj).replaceAll('SECRET_VALUE', '[REDACTED]')) as T,
};

describe('session message provenance', () => {
  it('survives writer persistence while internal token estimates are stripped', () => {
    const event = scrubSessionWriterEvent({
      type: 'message_appended',
      ts: '2026-08-08T20:00:00.000Z',
      version: 1,
      message: {
        role: 'user',
        content: 'continue the original task',
        origin: 'user_input',
        _estTokens: 42,
      },
    });

    expect(event.type).toBe('message_appended');
    if (event.type !== 'message_appended') return;
    expect(event.message).toMatchObject({
      role: 'user',
      content: 'continue the original task',
      origin: 'user_input',
    });
    expect(event.message._estTokens).toBeUndefined();
  });

  it('survives append replay and context-snapshot replay on resume', () => {
    const appended = replayableMessage(
      { role: 'user', content: 'human instruction', origin: 'user_input' },
      '2026-08-08T20:01:00.000Z',
    );
    expect(appended).toMatchObject({
      origin: 'user_input',
      ts: '2026-08-08T20:01:00.000Z',
    });

    const target: Message[] = [];
    const applied = applyContextSnapshot(target, new Set<string>(), [
      { role: 'user', content: 'human instruction', origin: 'user_input' },
      { role: 'user', content: '[loop-detector] steer', origin: 'runtime' },
    ]);
    expect(applied).toBe(true);
    expect(target.map((message) => message.origin)).toEqual(['user_input', 'runtime']);
  });

  it('scrubs persisted tool inputs, outputs and side effects', () => {
    const events: SessionEvent[] = [
      {
        type: 'tool_call_start',
        ts: '2026-08-08T20:02:00.000Z',
        name: 'bash',
        id: 'call-1',
        input: { env: { API_TOKEN: 'SECRET_VALUE' } },
      } as SessionEvent,
      {
        type: 'tool_result',
        ts: '2026-08-08T20:02:01.000Z',
        id: 'call-1',
        content: 'Authorization: Bearer SECRET_VALUE',
        isError: false,
      } as SessionEvent,
      {
        type: 'side_effect',
        ts: '2026-08-08T20:02:02.000Z',
        toolUseId: 'call-1',
        toolName: 'bash',
        input: { command: 'echo SECRET_VALUE' },
        risk: 'shell',
      } as SessionEvent,
    ];

    const persisted = events.map((event) => scrubSessionWriterEvent(event, markerScrubber));
    const raw = JSON.stringify(persisted);
    expect(raw).not.toContain('SECRET_VALUE');
    expect(raw).toContain('[REDACTED]');
  });
});
