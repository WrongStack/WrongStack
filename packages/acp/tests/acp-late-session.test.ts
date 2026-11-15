/**
 * Deterministic coverage for `cancelLateAcpSession`'s send-timeout branch
 * (acp-late-session.ts:20) and the client `prompt()` abort races that the
 * incidental session tests never reach.
 *
 * The late-cancel helper is fire-and-forget: when an abandoned `session/new`
 * resolves after its waiter gave up, it sends a best-effort `session/cancel`
 * bounded by a 10s timer. The rejector inside that timer only fires when the
 * transport `send` HANGS (neither resolves nor rejects) — a path the existing
 * "failed late-cancel send" test (which rejects) never hits. Here the send
 * returns a never-settling promise and fake timers are advanced past the 10s
 * bound.
 *
 * `cancelLateAcpSession` is exported from the module (not the barrel), so it
 * can be driven directly with a minimal hanging transport — no session
 * handshake required.
 */
import { describe, expect, it, vi } from 'vitest';
import type { ACPClientTransport } from '../src/agent/stdio-transport.js';
import { cancelLateAcpSession } from '../src/client/acp-late-session.js';

const LATE_CANCEL_SEND_TIMEOUT_MS = 10_000;

describe('cancelLateAcpSession', () => {
  it('warns when the late-cancel send hangs past the 10s bound', async () => {
    vi.useFakeTimers();
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    // A transport whose send never settles — models a dead socket.
    const transport = {
      send: () => new Promise<void>(() => {}),
    } as unknown as ACPClientTransport;

    cancelLateAcpSession(transport, Promise.resolve('sess_hang' as never));

    // Let the create-promise `.then` chain start the send + arm the timer.
    await vi.advanceTimersByTimeAsync(0);
    // Cross the 10s deadline; the timer's rejector fires.
    await vi.advanceTimersByTimeAsync(LATE_CANCEL_SEND_TIMEOUT_MS + 1);

    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(String(warnSpy.mock.calls[0]?.[0])).toContain('acp_session.late_cancel_failed');
    expect(String(warnSpy.mock.calls[0]?.[0])).toContain('sess_hang');
    expect(String(warnSpy.mock.calls[0]?.[0])).toContain('late session/cancel send timed out');

    vi.useRealTimers();
  });

  it('does not warn when the late-cancel send resolves before the bound', async () => {
    vi.useFakeTimers();
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const transport = {
      send: async () => {},
    } as unknown as ACPClientTransport;

    cancelLateAcpSession(transport, Promise.resolve('sess_ok' as never));
    await vi.advanceTimersByTimeAsync(LATE_CANCEL_SEND_TIMEOUT_MS + 1);

    expect(warnSpy).not.toHaveBeenCalled();
    vi.useRealTimers();
  });
  it('closes the abandoned session when the agent supports session/close', async () => {
    vi.useFakeTimers();
    const sent: Array<{ id?: unknown; method?: string; params?: unknown }> = [];
    const transport = {
      send: async (m: { id?: unknown; method?: string; params?: unknown }) => {
        sent.push(m);
      },
    } as unknown as ACPClientTransport;
    let next = 41;
    cancelLateAcpSession(transport, Promise.resolve('sess_close' as never), () => ++next);
    await vi.advanceTimersByTimeAsync(0);

    expect(sent).toHaveLength(1);
    expect(sent[0]?.method).toBe('session/close');
    expect(sent[0]?.id).toBe(42);
    expect(sent[0]?.params).toEqual({ sessionId: 'sess_close' });
    vi.useRealTimers();
  });

  it('keeps the session/cancel fallback when the agent cannot close a session', async () => {
    vi.useFakeTimers();
    const sent: Array<{ id?: unknown; method?: string; params?: unknown }> = [];
    const transport = {
      send: async (m: { id?: unknown; method?: string; params?: unknown }) => {
        sent.push(m);
      },
    } as unknown as ACPClientTransport;
    cancelLateAcpSession(transport, Promise.resolve('sess_cancel' as never));
    await vi.advanceTimersByTimeAsync(0);

    expect(sent).toHaveLength(1);
    expect(sent[0]?.method).toBe('session/cancel');
    expect(sent[0]?.id).toBeUndefined();
    expect(sent[0]?.params).toEqual({ sessionId: 'sess_cancel' });
    vi.useRealTimers();
  });
});
