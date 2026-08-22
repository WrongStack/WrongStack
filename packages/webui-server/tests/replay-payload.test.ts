import type { Message, SessionEvent } from '@wrongstack/core/types';
import { buildReplayPayload, REPLAY_MESSAGE_CAP } from '@wrongstack/webui-protocol';
import { describe, expect, it } from 'vitest';

const TS = '2026-07-25T10:00:00.000Z';

function messages(count: number): Message[] {
  return Array.from({ length: count }, (_, i) => ({
    role: 'user' as const,
    content: `m${i}`,
    ts: TS,
  }));
}

describe('buildReplayPayload', () => {
  it('omits every field for an empty session rather than sending empty arrays', () => {
    // Clients test `if (replay)` — an empty array would read as "there is a
    // replay" and wipe a transcript the server never persisted.
    expect(buildReplayPayload({ messages: [] })).toEqual({});
  });

  it('passes a short conversation through untouched', () => {
    const msgs = messages(3);
    expect(buildReplayPayload({ messages: msgs }).replayMessages).toEqual(msgs);
  });

  it('keeps the newest messages when the conversation exceeds the cap', () => {
    const msgs = messages(REPLAY_MESSAGE_CAP + 25);
    const out = buildReplayPayload({ messages: msgs }).replayMessages;
    expect(out).toHaveLength(REPLAY_MESSAGE_CAP);
    expect(out?.[out.length - 1]).toEqual(msgs[msgs.length - 1]);
    expect(out?.[0]).toEqual(msgs[25]);
  });

  it('projects audit markers and drops checkpoints (one per prompt is chat noise)', () => {
    const events: SessionEvent[] = [
      { type: 'checkpoint', ts: TS, promptIndex: 0, promptPreview: 'hi' },
      { type: 'compaction', ts: TS, before: 8_000, after: 2_000 },
      { type: 'mode_changed', ts: TS, from: 'plan', to: 'build' },
    ];
    const markers = buildReplayPayload({ messages: messages(1), events }).replayMarkers;
    expect(markers?.map((m) => m.source)).toEqual(['compaction', 'mode_changed']);
  });

  it('omits replayMarkers when no events were loaded', () => {
    expect(buildReplayPayload({ messages: messages(1) }).replayMarkers).toBeUndefined();
  });

  it('omits replayMarkers when the events carry no markers', () => {
    const events: SessionEvent[] = [{ type: 'user_input', ts: TS, content: 'hi' }];
    expect(buildReplayPayload({ messages: messages(1), events }).replayMarkers).toBeUndefined();
  });

  it('normalizes usage and omits it when nothing was spent', () => {
    expect(
      buildReplayPayload({ messages: [], usage: { input: 10, output: 5 } }).replayUsage,
    ).toEqual({ input: 10, output: 5, cacheRead: 0, cacheWrite: 0 });
    expect(
      buildReplayPayload({ messages: [], usage: { input: 0, output: 0 } }).replayUsage,
    ).toBeUndefined();
  });

  it('counts cache-only usage as spend', () => {
    expect(
      buildReplayPayload({
        messages: [],
        usage: { input: 0, output: 0, cacheRead: 42, cacheWrite: 0 },
      }).replayUsage,
    ).toEqual({ input: 0, output: 0, cacheRead: 42, cacheWrite: 0 });
  });

  it('does not alias the caller-owned message array', () => {
    // Both servers hand in the store's cached `data.messages`; mutating it
    // through the payload would corrupt the session store's load cache.
    const msgs = messages(2);
    const out = buildReplayPayload({ messages: msgs }).replayMessages;
    expect(out).not.toBe(msgs);
  });
});
