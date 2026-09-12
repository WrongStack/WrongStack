import { describe, expect, it, vi } from 'vitest';
import type { WebSocket } from 'ws';
import { handlePrefsUpdate, type PrefsHandlerContext } from '../src/server/prefs-handlers.js';
import { SESSION_SCOPED_PREF_KEYS } from '../src/server/session-scoped-prefs.js';
import type { WSServerMessage } from '../src/server/types.js';

const ws = {} as WebSocket;

function makeContext(opts: { withSetter?: boolean } = {}) {
  const meta: Record<string, unknown> = {};
  const sessionMeta: Record<string, unknown> = {};
  const sent: WSServerMessage[] = [];
  const persist = vi.fn(async () => {});
  const setSubagentModelPlan = vi.fn(async () => {});
  const context: PrefsHandlerContext = {
    meta,
    metaFor: (sessionId?: string) => (sessionId ? sessionMeta : meta),
    snapshot: () => ({ ...meta }),
    persist,
    pendingConfirms: new Map(),
    ...(opts.withSetter === false ? {} : { setSubagentModelPlan }),
    send: (_socket, message) => sent.push(message),
    broadcast: () => {},
  };
  return { context, meta, sessionMeta, sent, persist, setSubagentModelPlan };
}

const PLAN = {
  enabled: true,
  lock: true,
  slots: [
    { provider: 'anthropic', model: 'claude-opus-5' },
    { provider: 'openai', model: 'gpt-5' },
  ],
};

describe('subagentModelPlan preference', () => {
  it('is session-scoped', () => {
    expect(SESSION_SCOPED_PREF_KEYS.has('subagentModelPlan')).toBe(true);
  });

  it('applies the plan to the calling tab and never persists it to config', async () => {
    const state = makeContext();

    await handlePrefsUpdate(state.context, ws, { subagentModelPlan: PLAN }, 'sess-1');

    expect(state.setSubagentModelPlan).toHaveBeenCalledWith(PLAN, 'sess-1');
    // Session-scoped: lands on the calling tab's meta, not the process-wide bag.
    expect(state.sessionMeta['subagentModelPlan']).toEqual(PLAN);
    expect(state.meta['subagentModelPlan']).toBeUndefined();
    // A plan belongs to one conversation — writing it to config.json would leak
    // one tab's lanes into every session opened afterwards.
    expect(state.persist).not.toHaveBeenCalled();
  });

  it('still persists the durable keys that travel with a plan', async () => {
    const state = makeContext();

    await handlePrefsUpdate(
      state.context,
      ws,
      { subagentModelPlan: PLAN, favoriteModelsOnly: true },
      'sess-1',
    );

    expect(state.persist).toHaveBeenCalledWith({ favoriteModelsOnly: true });
  });

  it('reports a failure instead of half-applying it', async () => {
    const state = makeContext();
    state.setSubagentModelPlan.mockRejectedValueOnce(new Error('no session writer'));

    await handlePrefsUpdate(state.context, ws, { subagentModelPlan: PLAN }, 'sess-1');

    const result = state.sent.find((m) => m.type === 'key.operation_result');
    expect(result).toMatchObject({ payload: { success: false } });
    expect(state.sessionMeta['subagentModelPlan']).toBeUndefined();
  });

  it('refuses when the host wires no plan setter', async () => {
    const state = makeContext({ withSetter: false });

    await handlePrefsUpdate(state.context, ws, { subagentModelPlan: PLAN }, 'sess-1');

    const result = state.sent.find((m) => m.type === 'key.operation_result');
    expect(result).toMatchObject({ payload: { success: false } });
  });

  it('rejects a malformed plan before it reaches the host', async () => {
    const state = makeContext();

    await handlePrefsUpdate(state.context, ws, { subagentModelPlan: { slots: 'nope' } }, 'sess-1');

    expect(state.setSubagentModelPlan).not.toHaveBeenCalled();
    const result = state.sent.find((m) => m.type === 'key.operation_result');
    expect(result).toMatchObject({ payload: { success: false } });
  });

  it('rejects a prototype-polluting role key', async () => {
    const state = makeContext();

    await handlePrefsUpdate(
      state.context,
      ws,
      // Built through JSON.parse on purpose: an object LITERAL with
      // `__proto__` sets the prototype instead of creating an own key, so the
      // literal form would not reproduce what arrives over the wire.
      JSON.parse('{"subagentModelPlan":{"roles":{"__proto__":{"model":"x"}}}}'),
      'sess-1',
    );

    const result = state.sent.find((m) => m.type === 'key.operation_result');
    expect(result).toMatchObject({ payload: { success: false } });
  });
});
