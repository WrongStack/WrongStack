import { describe, expect, it, vi } from 'vitest';
import type { WebSocket } from 'ws';
import { handlePrefsUpdate, type PrefsHandlerContext } from '../src/server/prefs-handlers.js';
import { handleProviderRoute, type ProviderRouteHandlers } from '../src/server/provider-routes.js';

describe('ACP runtime settings routes', () => {
  it('correlates advertised options and agent failures', async () => {
    const send = vi.fn();
    const ws = { readyState: 1, send } as unknown as WebSocket;
    const inspect = vi
      .fn()
      .mockResolvedValueOnce({ agentId: 'fixture', options: [], applied: {} })
      .mockRejectedValueOnce(Error('Agent login required'));
    for (const requestId of ['read', 'error']) {
      expect(
        await handleProviderRoute(
          ws,
          { type: 'acp.config_options', payload: { agentId: 'fixture', values: {}, requestId } },
          { acpConfigOptions: inspect } as unknown as ProviderRouteHandlers,
        ),
      ).toBe(true);
    }
    expect(send.mock.calls.map((call) => JSON.parse(call[0]).payload)).toEqual([
      { ok: true, agentId: 'fixture', options: [], applied: {}, requestId: 'read' },
      { ok: false, agentId: 'fixture', error: 'Agent login required', requestId: 'error' },
    ]);
  });
  it('rejects malformed values before starting any process', async () => {
    const send = vi.fn();
    const inspect = vi.fn();
    await handleProviderRoute(
      { readyState: 1, send } as unknown as WebSocket,
      {
        type: 'acp.config_options',
        payload: { agentId: 'fixture', values: { thought: 3 }, requestId: 'invalid' },
      },
      { acpConfigOptions: inspect } as unknown as ProviderRouteHandlers,
    );
    expect(inspect).not.toHaveBeenCalled();
    expect(JSON.parse(send.mock.calls[0]![0]).payload).toMatchObject({
      ok: false,
      requestId: 'invalid',
    });
  });
  it('journals only the calling session and excludes ACP settings from config persistence', async () => {
    const meta = {};
    const sessionMeta = {};
    const persist = vi.fn();
    const setAcpRuntime = vi.fn();
    const sent = vi.fn();
    const context = {
      meta,
      metaFor: () => sessionMeta,
      snapshot: () => ({}),
      persist,
      setAcpRuntime,
      pendingConfirms: new Map(),
      send: sent,
      broadcast: vi.fn(),
    } as PrefsHandlerContext;
    const settings = { fixture: { engine: 'deep', thought: 'ultra' } };
    await handlePrefsUpdate(context, {} as WebSocket, { acpRuntime: settings }, 'first');
    expect(setAcpRuntime).toHaveBeenCalledWith(settings, 'first');
    expect(sessionMeta).toEqual({ acpRuntime: settings });
    expect(meta).toEqual({});
    expect(persist).not.toHaveBeenCalled();
  });
});
