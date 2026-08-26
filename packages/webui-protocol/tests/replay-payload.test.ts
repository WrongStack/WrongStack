/**
 * Regression tests for `buildReplayPayload`.
 *
 * Two servers (standalone webui and CLI --webui) emit this payload. The doc
 * header on `replay-payload.ts` documents a real drift incident where one
 * server fell back to in-memory conversation and the other did not, and
 * only one applied the message cap consistently. Pin the contract here so
 * a future regression to that state fails loudly in CI.
 */

import { describe, expect, it } from 'vitest';
import {
  buildReplayPayload,
  REPLAY_MESSAGE_CAP,
  type ReplaySource,
} from '../src/index.js';

function message(id: string): ReplaySource['messages'][number] {
  return {
    id,
    role: 'user',
    content: `hello-${id}`,
    createdAt: '2026-08-26T00:00:00.000Z',
  } as ReplaySource['messages'][number];
}

describe('buildReplayPayload — messages', () => {
  it('omits replayMessages when there are no messages', () => {
    const out = buildReplayPayload({ messages: [] });
    expect(out.replayMessages).toBeUndefined();
  });

  it('copies the messages verbatim when under the cap', () => {
    const out = buildReplayPayload({ messages: [message('a'), message('b')] });
    expect(out.replayMessages).toHaveLength(2);
    expect(out.replayMessages?.[0].id).toBe('a');
    expect(out.replayMessages?.[1].id).toBe('b');
  });

  it('returns a fresh array (caller cannot mutate the source)', () => {
    const source = [message('a'), message('b')];
    const out = buildReplayPayload({ messages: source });
    expect(out.replayMessages).not.toBe(source);
    expect(out.replayMessages).toEqual(source);
  });

  it('truncates to the most recent REPLAY_MESSAGE_CAP messages', () => {
    const cap = REPLAY_MESSAGE_CAP;
    const messages = Array.from({ length: cap + 50 }, (_, i) => message(`m${i}`));
    const out = buildReplayPayload({ messages });
    expect(out.replayMessages).toHaveLength(cap);
    expect(out.replayMessages?.[0].id).toBe('m50');
    expect(out.replayMessages?.[cap - 1].id).toBe(`m${cap + 49}`);
  });

  it('REPLAY_MESSAGE_CAP is exported and equals 2000', () => {
    expect(REPLAY_MESSAGE_CAP).toBe(2000);
  });
});

describe('buildReplayPayload — usage', () => {
  it('omits replayUsage when all counters are zero', () => {
    const out = buildReplayPayload({
      messages: [message('a')],
      usage: { input: 0, output: 0 },
    });
    expect(out.replayUsage).toBeUndefined();
  });

  it('includes replayUsage when input is non-zero', () => {
    const out = buildReplayPayload({
      messages: [message('a')],
      usage: { input: 10, output: 0 },
    });
    expect(out.replayUsage).toEqual({ input: 10, output: 0, cacheRead: 0, cacheWrite: 0 });
  });

  it('defaults cacheRead and cacheWrite to zero when missing', () => {
    const out = buildReplayPayload({
      messages: [message('a')],
      usage: { input: 1, output: 1 },
    });
    expect(out.replayUsage?.cacheRead).toBe(0);
    expect(out.replayUsage?.cacheWrite).toBe(0);
  });

  it('treats cacheRead alone as a non-zero total', () => {
    const out = buildReplayPayload({
      messages: [message('a')],
      usage: { input: 0, output: 0, cacheRead: 42 },
    });
    expect(out.replayUsage?.cacheRead).toBe(42);
  });

  it('treats cacheWrite alone as a non-zero total', () => {
    const out = buildReplayPayload({
      messages: [message('a')],
      usage: { input: 0, output: 0, cacheWrite: 7 },
    });
    expect(out.replayUsage?.cacheWrite).toBe(7);
  });
});

describe('buildReplayPayload — events / markers', () => {
  it('omits replayMarkers when no events are provided', () => {
    const out = buildReplayPayload({ messages: [message('a')] });
    expect(out.replayMarkers).toBeUndefined();
  });

  it('omits replayMarkers when events are empty', () => {
    const out = buildReplayPayload({ messages: [message('a')], events: [] });
    expect(out.replayMarkers).toBeUndefined();
  });

  it('skips events that project to zero markers', () => {
    const event = { kind: 'noise' } as unknown as ReplaySource['events'] extends readonly (infer E)[]
      ? E
      : never;
    const out = buildReplayPayload({ messages: [message('a')], events: [event] });
    expect(out.replayMarkers).toBeUndefined();
  });
});

describe('buildReplayPayload — field omission policy', () => {
  it('omits every field when source is empty', () => {
    const out = buildReplayPayload({ messages: [] });
    expect(out).toEqual({});
  });

  it('preserves key ordering consistent with the wire shape', () => {
    const out = buildReplayPayload({
      messages: [message('a')],
      usage: { input: 1, output: 1 },
    });
    expect(Object.keys(out)).toEqual(['replayMessages', 'replayUsage']);
  });
});
