import { pendingBtwCount, setBtwNote } from '@wrongstack/core/agent';
import { acpBtwBlock, startAcpTurnReminders } from '@wrongstack/fleet';
import { afterEach, describe, expect, it, vi } from 'vitest';

afterEach(() => vi.useRealTimers());

describe('startAcpTurnReminders', () => {
  it('replaces a mailbox awareness body with an inbox tool cue', () => {
    const block = acpBtwBlock([
      '[MAILBOX BTW] Mailbox awareness update:\nPrivate message body',
      'remember the review',
    ]);
    expect(block).toContain('action "inbox"');
    expect(block).toContain('remember the review');
    expect(block).not.toContain('Private message body');
  });

  it('nudges an active ACP worker to call inbox when unread mail appears, without flooding it', async () => {
    vi.useFakeTimers();
    let unread = 0;
    const steer = vi.fn(async (_text: string) => 'injected' as const);
    const read = vi.fn(async () => unread);
    const stop = startAcpTurnReminders({ steer, unreadCount: read, mailPollMs: 1_000 });
    await vi.advanceTimersByTimeAsync(1_000);
    expect(steer).not.toHaveBeenCalled();

    unread = 2;
    await vi.advanceTimersByTimeAsync(1_000);
    expect(steer).toHaveBeenCalledOnce();
    expect(steer.mock.calls[0]?.[0]).toContain('action "inbox"');
    await vi.advanceTimersByTimeAsync(5_000);
    expect(steer).toHaveBeenCalledOnce();

    unread = 3;
    await vi.advanceTimersByTimeAsync(1_000);
    expect(steer).toHaveBeenCalledTimes(2);
    stop();
    await vi.advanceTimersByTimeAsync(5_000);
    expect(read).toHaveBeenCalledTimes(8);
  });

  it('returns an undelivered /btw note to the next ACP turn', async () => {
    vi.useFakeTimers();
    const context = { meta: {} };
    const steer = vi.fn(async (_text: string) => 'promptRequired' as const);
    const stop = startAcpTurnReminders({ context: context as never, steer, btwPollMs: 1_000 });
    setBtwNote(context as never, 'remember the review');
    await vi.advanceTimersByTimeAsync(1_000);
    expect(steer.mock.calls[0]?.[0]).toContain('remember the review');
    expect(pendingBtwCount(context as never)).toBe(1);
    stop();
  });
});
