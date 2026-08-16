import { afterEach, describe, expect, it, vi } from 'vitest';
import { WrongStackWebSocketClient } from '../../src/lib/ws-client.js';

describe('WrongStackWebSocketClient chat echo suppression', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('suppresses exactly one matching response for a UI data request', () => {
    const client = new WrongStackWebSocketClient('ws://127.0.0.1:3457');

    client.listSkills({ echoToChat: false });

    expect(client.consumeSuppressedChatEcho('skills.list')).toBe(true);
    expect(client.consumeSuppressedChatEcho('skills.list')).toBe(false);
  });

  it('keeps normal inspect commands eligible for chat output', () => {
    const client = new WrongStackWebSocketClient('ws://127.0.0.1:3457');

    client.listSkills();
    client.getStats();

    expect(client.consumeSuppressedChatEcho('skills.list')).toBe(false);
    expect(client.consumeSuppressedChatEcho('stats.get')).toBe(false);
  });

  it('tracks concurrent UI requests independently by response type', () => {
    const client = new WrongStackWebSocketClient('ws://127.0.0.1:3457');

    client.listSageMemories({ echoToChat: false });
    client.listSageMemories({ echoToChat: false });
    client.debugContext({ echoToChat: false });

    expect(client.consumeSuppressedChatEcho('memory.sage.list')).toBe(true);
    expect(client.consumeSuppressedChatEcho('context.debug')).toBe(true);
    expect(client.consumeSuppressedChatEcho('memory.sage.list')).toBe(true);
    expect(client.consumeSuppressedChatEcho('memory.sage.list')).toBe(false);
  });

  it('expires a suppression when the UI request never receives a response', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-07-16T12:00:00Z'));
    const client = new WrongStackWebSocketClient('ws://127.0.0.1:3457');
    client.listTools({ echoToChat: false });

    vi.advanceTimersByTime(30_001);

    expect(client.consumeSuppressedChatEcho('tools.list')).toBe(false);
  });

  it('sweep clears expired entries and self-stops the timer (RAM-leak fix 2026-08-16)', async () => {
    // TTL trimming used to run only on consume — a suppressed-but-never-
    // consumed response type retained stale timestamps indefinitely. The
    // lazy sweep (started on first suppression, 15 s cadence) must release
    // expired entries and clear itself once the map is empty.
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-16T12:00:00Z'));
    const client = new WrongStackWebSocketClient('ws://127.0.0.1:3457');
    client.listTools({ echoToChat: false });
    client.listSkills({ echoToChat: false });

    // The sweep timer is the only timer a fresh, disconnected client owns.
    expect(vi.getTimerCount()).toBe(1);

    // Advance past TTL (30 s) + one sweep interval (15 s).
    await vi.advanceTimersByTimeAsync(45_001);

    expect(client.consumeSuppressedChatEcho('tools.list')).toBe(false);
    expect(client.consumeSuppressedChatEcho('skills.list')).toBe(false);
    expect(vi.getTimerCount()).toBe(0); // self-stopped when the map emptied
  });

  it('disconnect() stops the echo sweep timer and drops pending suppressions', () => {
    vi.useFakeTimers();
    const client = new WrongStackWebSocketClient('ws://127.0.0.1:3457');
    client.listTools({ echoToChat: false });
    expect(vi.getTimerCount()).toBe(1);

    client.disconnect();

    expect(vi.getTimerCount()).toBe(0);
    expect(client.consumeSuppressedChatEcho('tools.list')).toBe(false);
  });
});

describe('WrongStackWebSocketClient echo-suppression sweep (RAM-leak audit 2026-08-16)', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('clears expired entries without a consume and self-stops the sweep timer', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-16T12:00:00Z'));
    const client = new WrongStackWebSocketClient('ws://127.0.0.1:3457');
    // The sweep state is private; the regression test needs to observe the
    // timer lifecycle directly (arming, sharing, self-stop, re-arm).
    const internals = client as unknown as {
      suppressedChatEchoes: Map<string, number[]>;
      echoSweepTimer: ReturnType<typeof setInterval> | null;
    };

    client.listTools({ echoToChat: false });

    // Armed on first suppression, and shared — a second push must not
    // create a second interval.
    expect(internals.echoSweepTimer).not.toBeNull();
    const firstTimer = internals.echoSweepTimer;
    client.listTools({ echoToChat: false });
    expect(internals.echoSweepTimer).toBe(firstTimer);

    // First sweep tick runs before the 30 s TTL elapses: nothing cleared.
    vi.advanceTimersByTime(15_000);
    expect(internals.suppressedChatEchoes.get('tools.list')?.length).toBe(2);
    expect(internals.echoSweepTimer).toBe(firstTimer);

    // Past TTL: the sweep trims every expired entry WITHOUT any consume()
    // call, then self-stops once the map is empty.
    vi.advanceTimersByTime(16_000);
    expect(internals.suppressedChatEchoes.size).toBe(0);
    expect(internals.echoSweepTimer).toBeNull();
    expect(client.consumeSuppressedChatEcho('tools.list')).toBe(false);

    // Re-arms lazily on the next suppression after a self-stop…
    client.listTools({ echoToChat: false });
    expect(internals.echoSweepTimer).not.toBeNull();
    // …and disconnect() tears the re-armed timer down with the client.
    client.disconnect();
    expect(internals.echoSweepTimer).toBeNull();
  });
});
