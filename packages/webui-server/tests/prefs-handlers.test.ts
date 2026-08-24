import { describe, expect, it, vi } from 'vitest';
import type { WebSocket } from 'ws';
import {
  handleAutonomySwitch,
  handlePrefsGet,
  handlePrefsUpdate,
  type PrefsHandlerContext,
} from '../src/server/prefs-handlers.js';
import type { WSServerMessage } from '../src/server/types.js';

const ws = {} as WebSocket;

function makeContext() {
  const meta: Record<string, unknown> = {};
  const sent: WSServerMessage[] = [];
  const broadcasts: WSServerMessage[] = [];
  const persist = vi.fn(async () => {});
  const setYolo = vi.fn();
  const setAutonomy = vi.fn();
  const applyConfigPrefs = vi.fn();
  const setAutoCompact = vi.fn();
  const setLogLevel = vi.fn();
  const updateConfig = vi.fn();
  const context: PrefsHandlerContext = {
    meta,
    snapshot: () => ({ ...meta }),
    persist,
    pendingConfirms: new Map(),
    configStore: { update: updateConfig } as never,
    setYolo,
    setAutonomy,
    applyConfigPrefs,
    setAutoCompact,
    setLogLevel,
    send: (_socket, message) => sent.push(message),
    broadcast: (message) => broadcasts.push(message),
  };
  return {
    context,
    meta,
    sent,
    broadcasts,
    persist,
    setYolo,
    setAutonomy,
    applyConfigPrefs,
    setAutoCompact,
    setLogLevel,
    updateConfig,
  };
}

describe('canonical preference handlers', () => {
  it('returns the live preference snapshot', () => {
    const { context, meta, sent } = makeContext();
    meta['autonomy'] = 'auto';

    handlePrefsGet(context, ws);

    expect(sent).toEqual([{ type: 'prefs.updated', payload: { autonomy: 'auto' } }]);
  });

  it('applies validated preferences through host capabilities', async () => {
    const state = makeContext();
    const payload = {
      yolo: true,
      fallbackModels: ['openai/gpt-5'],
      contextAutoCompact: false,
      logLevel: 'warn',
      featureMcp: true,
    };

    await handlePrefsUpdate(state.context, ws, payload);

    expect(state.meta).toMatchObject(payload);
    expect(state.persist).toHaveBeenCalledWith(payload);
    expect(state.setYolo).toHaveBeenCalledWith(true);
    expect(state.applyConfigPrefs).toHaveBeenCalledWith(payload);
    expect(state.updateConfig).toHaveBeenCalledWith({ fallbackModels: ['openai/gpt-5'] });
    expect(state.setAutoCompact).toHaveBeenCalledWith(false);
    expect(state.setLogLevel).toHaveBeenCalledWith('warn');
    expect(state.broadcasts.at(-1)).toEqual({ type: 'prefs.updated', payload });
  });

  it('rejects unknown preferences before changing runtime state', async () => {
    const state = makeContext();

    await handlePrefsUpdate(state.context, ws, { unknownPreference: true });

    expect(state.meta).toEqual({});
    expect(state.persist).not.toHaveBeenCalled();
    expect(state.broadcasts).toEqual([]);
    expect(state.sent.at(-1)).toMatchObject({
      type: 'key.operation_result',
      payload: { success: false },
    });
  });

  it('switches real autonomy state, persists, and broadcasts', () => {
    const state = makeContext();

    handleAutonomySwitch(state.context, ws, 'suggest');

    expect(state.meta['autonomy']).toBe('suggest');
    expect(state.setAutonomy).toHaveBeenCalledWith('suggest');
    expect(state.persist).toHaveBeenCalledWith({ autonomy: 'suggest' });
    expect(state.broadcasts).toContainEqual({
      type: 'prefs.updated',
      payload: { autonomy: 'suggest' },
    });
  });
});
