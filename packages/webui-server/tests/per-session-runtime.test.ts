import { describe, expect, it, vi } from 'vitest';
import type WebSocket from 'ws';
import { handleAutonomySwitch, handlePrefsUpdate } from '../src/server/prefs-handlers.js';
import { createSessionStartPayload } from '../src/server/server-runtime.js';

/**
 * Per-session runtime isolation for the multi-tab WebUI.
 *
 * Four tabs run four sessions at once, and everything that shapes a turn —
 * model, mode, context strategy, identity prompt, autonomy/yolo — belongs to
 * the tab that set it. The shared root context is NOT that tab: it points at
 * whichever session the runtime last activated, so a handler that writes
 * through it silently re-configures a conversation the user is not looking at.
 *
 * These pin the routing, not the individual features.
 */

const ws = {} as WebSocket;

function prefsHarness() {
  const rootMeta: Record<string, unknown> = {};
  const sessionMetas = new Map<string, Record<string, unknown>>([
    ['sess_a', {}],
    ['sess_b', {}],
  ]);
  const broadcasts: Array<{ type: string; payload: unknown }> = [];
  const persisted: Array<Record<string, unknown>> = [];
  const ctx = {
    meta: rootMeta,
    metaFor: (sessionId?: string) =>
      (sessionId ? sessionMetas.get(sessionId) : undefined) ?? rootMeta,
    snapshot: () => ({}),
    persist: async (payload: Record<string, unknown>) => {
      persisted.push(payload);
    },
    pendingConfirms: new Map(),
    setYolo: vi.fn(),
    setAutonomy: vi.fn(),
    send: vi.fn(),
    broadcast: (message: { type: string; payload: unknown }) => broadcasts.push(message),
  };
  return { ctx, rootMeta, sessionMetas, broadcasts, persisted };
}

describe('per-session runtime — preferences', () => {
  it('routes session-scoped prefs to the calling tab, not the shared root', async () => {
    const h = prefsHarness();

    await handlePrefsUpdate(
      h.ctx as never,
      ws,
      { yolo: true, contextStrategy: 'selective' },
      'sess_a',
    );

    expect(h.sessionMetas.get('sess_a')).toMatchObject({
      yolo: true,
      contextStrategy: 'selective',
    });
    // The tab beside it keeps its own (safe) settings.
    expect(h.sessionMetas.get('sess_b')).toEqual({});
    expect(h.rootMeta['yolo']).toBeUndefined();
  });

  it('keeps genuinely process-wide prefs on the shared root', async () => {
    const h = prefsHarness();

    await handlePrefsUpdate(h.ctx as never, ws, { uiLocale: 'tr', yolo: true }, 'sess_a');

    // Locale is an app-level choice — one home, shared by every tab.
    expect(h.rootMeta['uiLocale']).toBe('tr');
    expect(h.sessionMetas.get('sess_a')?.['uiLocale']).toBeUndefined();
    // …while yolo stays scoped to the tab that enabled it.
    expect(h.sessionMetas.get('sess_a')?.['yolo']).toBe(true);
    expect(h.rootMeta['yolo']).toBeUndefined();
  });

  it('scopes autonomy.switch to the requesting tab', () => {
    const h = prefsHarness();

    handleAutonomySwitch(h.ctx as never, ws, 'eternal', 'sess_b');

    expect(h.sessionMetas.get('sess_b')?.['autonomy']).toBe('eternal');
    expect(h.sessionMetas.get('sess_a')?.['autonomy']).toBeUndefined();
    expect(h.rootMeta['autonomy']).toBeUndefined();
    const updated = h.broadcasts.find((m) => m.type === 'prefs.updated');
    expect((updated?.payload as { sessionId?: string })?.sessionId).toBe('sess_b');
  });

  it('falls back to the shared meta when the host has no per-session contexts', async () => {
    const h = prefsHarness();
    // Embedded single-session runtimes wire no `metaFor`.
    const ctx = { ...h.ctx, metaFor: undefined };

    await handlePrefsUpdate(ctx as never, ws, { yolo: true }, 'sess_a');

    expect(h.rootMeta['yolo']).toBe(true);
  });
});

describe('per-session runtime — session.start payload', () => {
  const contexts = new Map<
    string,
    { model: string; provider: { id: string }; meta: Record<string, unknown> }
  >([
    [
      'sess_a',
      {
        model: 'model-a',
        provider: { id: 'prov-a' },
        meta: { modeId: 'review', contextWindowMode: 'frugal' },
      },
    ],
    ['sess_b', { model: 'model-b', provider: { id: 'prov-b' }, meta: {} }],
  ]);

  const build = () =>
    createSessionStartPayload({
      getConfig: () => ({ provider: 'global-prov', model: 'global-model' }) as never,
      getSessionId: () => 'sess_a',
      getProjectRoot: () => '/proj',
      getWorkingDir: () => '/proj',
      getModeId: () => 'default',
      getContextMode: () => 'balanced',
      getNeedsSetup: () => false,
      modelsRegistry: { getProvider: async () => undefined } as never,
      getSessionContext: (sessionId: string) => contexts.get(sessionId),
    });

  it('reports the TARGET tab, not whichever session the runtime is on', async () => {
    const payload = await build()({ sessionId: 'sess_b' });

    expect(payload.sessionId).toBe('sess_b');
    expect(payload.model).toBe('model-b');
    expect(payload.provider).toBe('prov-b');
  });

  it('reports a tab own mode and context strategy over the global defaults', async () => {
    const payload = await build()({ sessionId: 'sess_a' });

    expect(payload.mode).toBe('review');
    expect(payload.contextMode).toBe('frugal');
  });

  it('falls back to the global defaults for a tab that never overrode them', async () => {
    const payload = await build()({ sessionId: 'sess_b' });

    expect(payload.mode).toBe('default');
    expect(payload.contextMode).toBe('balanced');
  });

  it('describes the runtime session when no target is named', async () => {
    const payload = await build()();

    expect(payload.sessionId).toBe('sess_a');
    expect(payload.model).toBe('model-a');
  });
});
