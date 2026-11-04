import { describe, expect, it, vi } from 'vitest';
import {
  type DesktopStoryValue,
  desktopStoryFeed,
  mailboxMessages,
  sessionStartedAt,
} from '../src/desktop-story-feed';
import type { EngineState } from '../src/engine-state';

const withResults = (results: Record<string, Record<string, unknown>>) =>
  ({ results }) as unknown as EngineState;

function feedWith(command: DesktopStoryValue['command'], state = withResults({})) {
  const send = vi.fn(async () => undefined);
  const onBack = vi.fn();
  const value = {
    state,
    projectRoot: 'D:/repo',
    send,
    command,
    onBack,
  } as DesktopStoryValue;
  return { feed: desktopStoryFeed(() => value), send, onBack };
}

describe('desktop story feed', () => {
  it('reads the start and the Chronicle capability from the session.start reply', () => {
    const state = withResults({
      'session.start': {
        startedAt: '2026-11-03T12:29:43.648Z',
        protocolCapabilities: ['protocol.directional-decoder', 'chronicle.query'],
      },
    });
    const ask = async () => ({});
    expect(sessionStartedAt(state)).toBe(Date.parse('2026-11-03T12:29:43.648Z'));
    expect(feedWith(ask, state).feed.supportsChronicle()).toBe(true);
    expect(sessionStartedAt(withResults({}))).toBe(0);
    expect(feedWith(ask, withResults({ 'session.start': {} })).feed.supportsChronicle()).toBe(
      false,
    );
  });

  it('reads mailbox messages only from a list', () => {
    expect(mailboxMessages({ messages: [{ id: 'm1' }] })).toEqual([{ id: 'm1' }]);
    expect(mailboxMessages({ messages: 'none' })).toEqual([]);
    expect(mailboxMessages(undefined)).toEqual([]);
  });

  it('asks the engine for the conversation history and returns its reply', async () => {
    const result = { events: [], total: 0, summary: {} };
    const command = vi.fn(async () => result);
    const { feed } = feedWith(command);
    await expect(
      feed.queryChronicle({ sessionId: 's1', limit: 5 }, new AbortController().signal),
    ).resolves.toBe(result);
    expect(command).toHaveBeenCalledWith(
      'chronicle.query',
      { query: { sessionId: 's1', limit: 5 } },
      ['chronicle.query_result', 'chronicle.error'],
      { timeoutMs: 45000 },
    );
  });

  it("rejects with the engine's message when the query fails", async () => {
    const { feed } = feedWith(async () => ({ message: 'chronicle store unavailable' }));
    await expect(
      feed.queryChronicle({ sessionId: 's1' }, new AbortController().signal),
    ).rejects.toThrow('chronicle store unavailable');
  });

  it('stops waiting when the story abandons the query', async () => {
    const { feed } = feedWith(() => new Promise(() => undefined));
    const controller = new AbortController();
    const pending = feed.queryChronicle({ sessionId: 's1' }, controller.signal);
    controller.abort();
    await expect(pending).rejects.toThrow('cancelled');
  });

  it('refreshes the mailbox and returns to the conversation', () => {
    const { feed, send, onBack } = feedWith(async () => ({}));
    feed.refreshMail();
    feed.back();
    expect(send).toHaveBeenCalledWith('mailbox.messages', { limit: 100 });
    expect(onBack).toHaveBeenCalledOnce();
  });
});
