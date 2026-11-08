import { describe, expect, it, vi } from 'vitest';
import type { WebSocket } from 'ws';
import { handleAutonomySwitch } from '../src/server/autonomy-switch.js';
import {
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
    configStore: { get: () => ({ features: { memory: true } }), update: updateConfig } as never,
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
  it('updates the live shared config when Tool Coach is switched off', async () => {
    const state = makeContext();
    await handlePrefsUpdate(state.context, ws, { featureToolCoach: false });
    expect(state.persist).toHaveBeenCalledWith({ featureToolCoach: false });
    expect(state.updateConfig).toHaveBeenCalledWith({
      features: { memory: true, toolCoach: false },
    });
    expect(state.meta['featureToolCoach']).toBe(false);
  });
  it('switches YOLO and YOLO+ off before the settings are saved, and on only after', async () => {
    const state = makeContext();
    state.meta['yolo'] = true;
    state.meta['yoloPlus'] = true;
    let finishSave!: () => void;
    state.persist.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          finishSave = resolve;
        }),
    );
    // A prompt that arrives while the save is on disk must already ask for approval.
    const off = handlePrefsUpdate(state.context, ws, { yolo: false, yoloPlus: false });
    await Promise.resolve();
    expect(state.setYolo).toHaveBeenCalledWith(false, undefined);
    expect(state.meta['yolo']).toBe(false);
    expect(state.meta['yoloPlus']).toBe(false);
    finishSave();
    await off;
    // Loosening waits for the save: a failed save leaves the protection on.
    state.setYolo.mockClear();
    const on = handlePrefsUpdate(state.context, ws, { yolo: true });
    await Promise.resolve();
    expect(state.setYolo).not.toHaveBeenCalled();
    expect(state.meta['yolo']).toBe(false);
    finishSave();
    await on;
    expect(state.setYolo).toHaveBeenCalledWith(true, undefined);
  });
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

  it('does not publish or apply a durable preference when the config write fails', async () => {
    const state = makeContext();
    state.persist.mockRejectedValueOnce(new Error('disk is read-only'));

    await handlePrefsUpdate(state.context, ws, { yolo: true });

    expect(state.meta).toEqual({});
    expect(state.setYolo).not.toHaveBeenCalled();
    expect(state.applyConfigPrefs).not.toHaveBeenCalled();
    expect(state.broadcasts).toEqual([]);
    expect(state.sent).toContainEqual({
      type: 'key.operation_result',
      payload: {
        success: false,
        message: 'Settings were not saved: disk is read-only',
      },
    });
  });

  it('applies the session-only subagent policy without persisting a global default', async () => {
    const state = makeContext();
    const setSubagentsAllowed = vi.fn(async () => undefined);
    state.context.setSubagentsAllowed = setSubagentsAllowed;

    await handlePrefsUpdate(state.context, ws, { subagentsAllowed: false }, 'solo-session');

    // A plain solo toggle is strict: the companions stop too.
    expect(setSubagentsAllowed).toHaveBeenCalledWith(false, 'solo-session', false);
    expect(state.meta['subagentsAllowed']).toBe(false);
    expect(state.persist).not.toHaveBeenCalled();
  });

  it('passes the companion half of a solo request through, still session-only', async () => {
    const state = makeContext();
    const setSubagentsAllowed = vi.fn(async () => undefined);
    state.context.setSubagentsAllowed = setSubagentsAllowed;

    await handlePrefsUpdate(
      state.context,
      ws,
      { subagentsAllowed: false, subagentCompanionsAllowed: true },
      'bughunt-session',
    );

    expect(setSubagentsAllowed).toHaveBeenCalledWith(false, 'bughunt-session', true);
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

  it('switches real autonomy state, persists, and broadcasts', async () => {
    const state = makeContext();

    await handleAutonomySwitch(state.context, ws, 'suggest');

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

  it('tells the runtime WHICH tab switched autonomy', async () => {
    // Without the id the CLI host cannot tell a background tab's change from
    // the leader's, and it moves the process-wide mode ref for both — which
    // put the eternal-autonomy block into every conversation's system prompt.
    const state = makeContext();

    await handleAutonomySwitch(state.context, ws, 'eternal', 'sess_2');

    expect(state.setAutonomy).toHaveBeenCalledWith('eternal', 'sess_2');
  });

  it('turns on the tab YOLO when a host that drives the loop starts eternal, as the CLI does', async () => {
    const state = makeContext();
    state.context.metaFor = () => state.meta;
    state.context.checkAutonomy = vi.fn(async () => undefined);

    await handleAutonomySwitch(state.context, ws, 'eternal', 'sess_2');

    expect(state.meta['yolo']).toBe(true);
    expect(state.setYolo).toHaveBeenCalledWith(true, 'sess_2');
    // Before the loop starts, so its first tool call does not wait for approval.
    expect(state.setYolo.mock.invocationCallOrder[0]).toBeLessThan(
      state.setAutonomy.mock.invocationCallOrder[0] ?? 0,
    );
    expect(state.broadcasts).toContainEqual({
      type: 'prefs.updated',
      payload: { autonomy: 'eternal', yolo: true, sessionId: 'sess_2' },
    });
    // YOLO stays the tab's: nothing is written to the saved defaults for it.
    expect(state.persist).toHaveBeenCalledWith({ autonomy: 'eternal' });
  });

  it('leaves YOLO alone without an eternal driver and for the other modes', async () => {
    const withoutDriver = makeContext();
    await handleAutonomySwitch(withoutDriver.context, ws, 'eternal', 'sess_2');
    expect(withoutDriver.setYolo).not.toHaveBeenCalled();

    const otherMode = makeContext();
    otherMode.context.checkAutonomy = vi.fn(async () => undefined);
    await handleAutonomySwitch(otherMode.context, ws, 'auto', 'sess_2');
    expect(otherMode.setYolo).not.toHaveBeenCalled();
    expect(otherMode.meta['yolo']).toBeUndefined();
  });

  it('changes nothing when the host refuses the switch, and says why', async () => {
    const state = makeContext();
    state.meta['autonomy'] = 'auto';
    const checkAutonomy = vi.fn(async () => 'Eternal autonomy needs a goal.');
    state.context.checkAutonomy = checkAutonomy;

    await handleAutonomySwitch(state.context, ws, 'eternal', 'sess_2');

    expect(checkAutonomy).toHaveBeenCalledWith('eternal', 'sess_2');
    expect(state.persist).not.toHaveBeenCalled();
    expect(state.setAutonomy).not.toHaveBeenCalled();
    expect(state.meta['autonomy']).toBe('auto');
    expect(state.sent).toContainEqual(
      expect.objectContaining({
        payload: { success: false, message: 'Eternal autonomy needs a goal.' },
      }),
    );
  });
});
