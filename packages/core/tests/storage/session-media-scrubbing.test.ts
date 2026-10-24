import type { SessionEvent } from '@wrongstack/contracts/types/session';
import { describe, expect, it } from 'vitest';
import { DefaultSecretScrubber } from '../../src/security/secret-scrubber.js';
import { scrubPersistedSessionEvent } from '../../src/storage/session-read-scrubber.js';
import { scrubSessionWriterEvent } from '../../src/storage/session-writer-scrubber.js';

const IMAGE_DATA = `/EAAA${'A'.repeat(24)}/AA`;
const SECRET = `sk-ant-api03-${'a'.repeat(49)}`;

function event(): SessionEvent {
  return {
    type: 'message_appended',
    ts: '2026-10-23T10:35:07.000Z',
    version: 1,
    message: {
      role: 'user',
      content: [
        {
          type: 'image',
          source: { type: 'base64', media_type: 'image/png', data: IMAGE_DATA },
        },
        { type: 'text', text: `credential ${SECRET}` },
      ],
    },
  };
}

function assertSafe(output: SessionEvent): void {
  expect(output.type).toBe('message_appended');
  if (output.type !== 'message_appended' || !Array.isArray(output.message.content)) return;
  const image = output.message.content[0];
  const text = output.message.content[1];
  expect(image?.type).toBe('image');
  expect(image?.type === 'image' ? image.source.data : undefined).toBe(IMAGE_DATA);
  expect(text?.type === 'text' ? text.text : undefined).toContain('[REDACTED:anthropic_key]');
}

describe('session media scrubbing', () => {
  it('preserves opaque image bytes at both journal write and legacy read boundaries', () => {
    const scrubber = new DefaultSecretScrubber();
    assertSafe(scrubSessionWriterEvent(event(), scrubber));
    assertSafe(scrubPersistedSessionEvent(event(), scrubber));
  });
});
