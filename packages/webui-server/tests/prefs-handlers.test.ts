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
    // The session that asked travels with the flag: a host whose apply path
    // writes a context meta must not write the leader's for another tab.
    expect(state.setYolo).toHaveBeenCalledWith(true, undefined);
    expect(state.applyConfigPrefs).toHaveBeenCalledWith(payload);
    expect(state.updateConfig).toHaveBeenCalledWith({ fallbackModels: ['openai/gpt-5'] });
    expect(state.setAutoCompact).toHaveBeenCalledWith(false);
    expect(state.setLogLevel).toHaveBeenCalledWith('warn');
    // The echo is split in two: session-scoped keys addressed at the tab
    // that set them, project-wide keys untagged for everyone. Between them
    // they still carry the whole snapshot.
    const echoed = Object.assign(
      {},
      ...state.broadcasts
        .filter((b) => b.type === 'prefs.updated')
        .map((b) => b.payload as Record<string, unknown>),
    );
    expect(echoed).toMatchObject(payload);
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

  it('applies the session-only subagent policy without persisting a global default', async () => {
    const state = makeContext();
    const setSubagentsAllowed = vi.fn(async () => undefined);
    state.context.setSubagentsAllowed = setSubagentsAllowed;

    await handlePrefsUpdate(state.context, ws, { subagentsAllowed: false }, 'solo-session');

    expect(setSubagentsAllowed).toHaveBeenCalledWith(false, 'solo-session');
    expect(state.meta['subagentsAllowed']).toBe(false);
    expect(state.persist).not.toHaveBeenCalled();
  });

  it('rejects a mid-session subagent policy change and restores the snapshot', async () => {
    const state = makeContext();
    state.meta['subagentsAllowed'] = false;
    state.meta['subagentsPolicyLocked'] = true;
    state.context.setSubagentsAllowed = vi.fn(async () => {
      throw new Error('Subagent policy is locked after the session starts.');
    });

    await handlePrefsUpdate(state.context, ws, { subagentsAllowed: true }, 'locked-session');

    expect(state.meta['subagentsAllowed']).toBe(false);
    expect(state.persist).not.toHaveBeenCalled();
    expect(state.sent).toContainEqual({
      type: 'key.operation_result',
      payload: {
        success: false,
        message: 'Subagent policy is locked after the session starts.',
      },
    });
  });

  it('switches real autonomy state, persists, and broadcasts', () => {
    const state = makeContext();

    handleAutonomySwitch(state.context, ws, 'suggest');

    expect(state.meta['autonomy']).toBe('suggest');
    // Addressed, like `setYolo`: the runtime knob behind this seam is
    // process-wide, so it must know which tab asked. Unstamped here because
    // this call names no session.
    expect(state.setAutonomy).toHaveBeenCalledWith('suggest', undefined);
    expect(state.persist).toHaveBeenCalledWith({ autonomy: 'suggest' });
    expect(state.broadcasts).toContainEqual({
      type: 'prefs.updated',
      payload: { autonomy: 'suggest' },
    });
  });

  it('tells the runtime WHICH tab switched autonomy', () => {
    // Without the id the CLI host cannot tell a background tab's change from
    // the leader's, and it moves the process-wide mode ref for both — which
    // put the eternal-autonomy block into every conversation's system prompt.
    const state = makeContext();

    handleAutonomySwitch(state.context, ws, 'eternal', 'sess_2');

    expect(state.setAutonomy).toHaveBeenCalledWith('eternal', 'sess_2');
  });
});
