import { describe, expect, it, vi } from 'vitest';
import type { KeyEvent } from '../src/components/input.js';
import { routeInputKey, type InputKeyRouterHost } from '../src/input-key-router.js';

function key(overrides: Partial<KeyEvent> = {}): KeyEvent {
  return {
    upArrow: false,
    downArrow: false,
    leftArrow: false,
    rightArrow: false,
    return: false,
    escape: false,
    ctrl: false,
    meta: false,
    shift: false,
    tab: false,
    backspace: false,
    delete: false,
    pageUp: false,
    pageDown: false,
    home: false,
    end: false,
    ...overrides,
  };
}

function host(overrides: Partial<InputKeyRouterHost> = {}): InputKeyRouterHost {
  return {
    state: { status: 'idle', inputHistory: [], historyIndex: 0, bashMode: false },
    draft: { buffer: '', cursor: 0 },
    overlayOpen: false,
    prompt: '❯ ',
    terminalColumns: 80,
    terminalRows: 24,
    nextSteps: {
      timer: { current: undefined },
      suggestion: { current: null },
      label: null,
      setCountdown: vi.fn(),
      setLabel: vi.fn(),
      cancel: vi.fn(),
    },
    dispatch: vi.fn(),
    setDraft: vi.fn(),
    pasteClipboardText: vi.fn().mockResolvedValue(undefined),
    pasteClipboardImage: vi.fn().mockResolvedValue(undefined),
    commitPaste: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

describe('routeInputKey', () => {
  it('inserts text at the current cursor and cancels auto-submit', async () => {
    const fixture = host({ draft: { buffer: 'ac', cursor: 1 } });

    expect(await routeInputKey(fixture, 'b', key())).toBe(true);
    expect(fixture.nextSteps.cancel).toHaveBeenCalledOnce();
    expect(fixture.setDraft).toHaveBeenCalledWith('abc', 2);
  });

  it('deletes an attachment chip as one backspace operation', async () => {
    const buffer = 'inspect [file:src/app.ts]';
    const fixture = host({ draft: { buffer, cursor: buffer.length } });

    await routeInputKey(fixture, '', key({ backspace: true }));

    expect(fixture.setDraft).toHaveBeenCalledWith('inspect ', 8);
  });

  it('leaves bash mode on backspace over an empty line, deletes normally otherwise', async () => {
    const bashEmpty = host({
      state: { status: 'idle', inputHistory: [], historyIndex: 0, bashMode: true },
    });
    await routeInputKey(bashEmpty, '', key({ backspace: true }));
    expect(bashEmpty.dispatch).toHaveBeenCalledWith({ type: 'bashModeExit' });
    expect(bashEmpty.setDraft).not.toHaveBeenCalled();

    const bashWithText = host({
      state: { status: 'idle', inputHistory: [], historyIndex: 0, bashMode: true },
      draft: { buffer: 'ls', cursor: 2 },
    });
    await routeInputKey(bashWithText, '', key({ backspace: true }));
    expect(bashWithText.dispatch).not.toHaveBeenCalledWith({ type: 'bashModeExit' });
    expect(bashWithText.setDraft).toHaveBeenCalledWith('l', 1);
  });

  it('routes single-line up-arrow into input history unless an overlay owns it', async () => {
    const fixture = host({
      state: { status: 'idle', inputHistory: ['previous'], historyIndex: 0, bashMode: false },
    });

    await routeInputKey(fixture, '', key({ upArrow: true }));
    expect(fixture.dispatch).toHaveBeenCalledWith({ type: 'historyUp' });

    const overlayFixture = host({
      state: { status: 'idle', inputHistory: ['previous'], historyIndex: 0, bashMode: false },
      overlayOpen: true,
    });
    await routeInputKey(overlayFixture, '', key({ upArrow: true }));
    expect(overlayFixture.dispatch).not.toHaveBeenCalled();
  });

  it('uses the clipboard adapter only while the composer is idle', async () => {
    const idle = host();
    await routeInputKey(idle, 'v', key({ ctrl: true }));
    expect(idle.pasteClipboardText).toHaveBeenCalledOnce();

    const busy = host({
      state: { status: 'running', inputHistory: [], historyIndex: 0, bashMode: false },
    });
    await routeInputKey(busy, 'v', key({ ctrl: true }));
    expect(busy.pasteClipboardText).not.toHaveBeenCalled();
    expect(busy.dispatch).toHaveBeenCalledWith({
      type: 'addEntry',
      entry: { kind: 'info', text: 'Input locked — wait for the agent to finish before pasting.' },
    });
  });

  it('routes multi-line and large chunks through the paste adapter', async () => {
    const fixture = host();
    await routeInputKey(fixture, 'line one\nline two', key());
    expect(fixture.commitPaste).toHaveBeenCalledWith('line one\nline two');

    const large = 'x'.repeat(201);
    await routeInputKey(fixture, large, key());
    expect(fixture.commitPaste).toHaveBeenCalledWith(large);
  });
});
