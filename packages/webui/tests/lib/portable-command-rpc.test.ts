import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { invokePortableCommand } from '../../src/lib/portable-command-rpc';

const ws = vi.hoisted(() => ({ send: vi.fn(), on: vi.fn(), off: vi.fn() }));
vi.mock('@/lib/ws-client', () => ({ getWSClient: () => ws }));
beforeEach(() => {
  vi.useFakeTimers();
  ws.send.mockReset().mockReturnValue(true);
  ws.off.mockReset();
  ws.on.mockReset().mockReturnValue(ws.off);
});
afterEach(() => {
  vi.useRealTimers();
});

describe('portable command RPC lifecycle', () => {
  it('returns only its correlated reply and releases listeners', async () => {
    const pending = invokePortableCommand('adr', 'summary-json', { sessionId: 's' });
    const handler = ws.on.mock.calls[0][1];
    handler({ payload: { requestId: 'other', message: 'ignored' } });
    expect(ws.off).not.toHaveBeenCalled();
    handler({ payload: { requestId: ws.send.mock.calls[0][0].payload.requestId, message: 'ok' } });
    expect(await pending).toEqual({ message: 'ok' });
    expect(ws.off).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });
  it('releases an in-flight subscription immediately when cancelled', async () => {
    const controller = new AbortController();
    const pending = invokePortableCommand('adr', 'summary-json', {
      sessionId: 's',
      signal: controller.signal,
    });
    controller.abort();
    expect(await pending).toMatchObject({ error: 'Command request cancelled.' });
    expect(ws.off).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });
  it('does not send an already cancelled query or queue an offline poll', async () => {
    const controller = new AbortController();
    controller.abort();
    expect(
      await invokePortableCommand('adr', 'summary-json', { signal: controller.signal }),
    ).toHaveProperty('error');
    expect(ws.send).not.toHaveBeenCalled();
    ws.send.mockReturnValue(false);
    expect(
      await invokePortableCommand('adr', 'summary-json', {
        sessionId: 's',
        queueIfDisconnected: false,
      }),
    ).toHaveProperty('error', 'WebSocket not connected.');
    expect(ws.send.mock.calls[0][1]).toEqual({ queueIfDisconnected: false });
    expect(ws.off).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });
});
