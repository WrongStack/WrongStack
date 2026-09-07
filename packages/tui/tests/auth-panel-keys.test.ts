// Tests for the /auth panel FORM key routing in tryAuthModelPickerKeys —
// the branch that turns raw keystrokes into authFormChange dispatches:
//   - text fields accept printable input + backspace
//   - the family row cycles WIRE_FAMILIES on ←/→ (with wraparound) and
//     ignores printable input
//   - up/down/enter still route to row selection (handled before the form
//     branch), and every key in the form view is consumed (returns true)
//
// The reducer side of authFormChange is covered by auth-panel-reducer.test.ts;
// here we assert the exact actions the router dispatches.

import { describe, expect, it, vi } from 'vitest';
import type { Action, State } from '../src/app-reducer.js';
import {
  AUTH_PANEL_INITIAL,
  type AuthPanelState,
  type WIRE_FAMILIES,
} from '../src/components/auth-panel-model.js';
import type { KeyEvent } from '../src/components/input.js';
import { tryAuthModelPickerKeys } from '../src/hooks/use-picker-keys-auth-model.js';
import type { PickerKeysHost } from '../src/hooks/use-picker-keys-types.js';

/** All-false KeyEvent; flip the keys a test needs. */
function keyEvt(over: Partial<KeyEvent> = {}): KeyEvent {
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
    ...over,
  };
}

/** Setup form with the defaults the controller dispatches on open. */
function setupPanel(selected: number, family = 'openai-compatible'): AuthPanelState {
  return {
    ...AUTH_PANEL_INITIAL,
    open: true,
    view: 'form',
    selected,
    form: {
      kind: 'setup',
      fields: {
        type: 'anthropic',
        name: 'Anthropic',
        family: family as (typeof WIRE_FAMILIES)[number],
        baseUrl: 'https://api.anthropic.com',
        alias: 'anthropic',
        keyLabel: 'default',
        apiKey: 'sk-1234',
        models: '',
        envVars: '',
      },
    },
  };
}

/** Minimal host: the router only reads state + dispatch in the form branch. */
function makeHost(panel: AuthPanelState): { host: PickerKeysHost; actions: Action[] } {
  const actions: Action[] = [];
  const host = {
    state: { authPanel: panel } as unknown as State,
    dispatch: (action: Action) => {
      actions.push(action);
    },
    lastEnterAtRef: { current: 0 },
    inputGateRef: { current: false },
    onAuthEnter: vi.fn(),
    onAuthBack: vi.fn(),
  } as unknown as PickerKeysHost;
  return { host, actions };
}

const noDebounce = () => false;

describe('auth form key routing — text fields', () => {
  it('appends printable input to the selected field', () => {
    // Setup rows: 0 type · 1 name · 2 family · 3 baseUrl · 4 alias …
    const { host, actions } = makeHost(setupPanel(4));
    const consumed = tryAuthModelPickerKeys(host, 'abc', keyEvt(), false, noDebounce);
    expect(consumed).toBe(true);
    expect(actions).toEqual([{ type: 'authFormChange', field: 'alias', value: 'anthropicabc' }]);
  });

  it('accepts a whole bracketed-paste string as one append', () => {
    const { host, actions } = makeHost(setupPanel(3)); // baseUrl
    const consumed = tryAuthModelPickerKeys(host, 'https://x.test/v1', keyEvt(), false, noDebounce);
    expect(consumed).toBe(true);
    expect(actions).toEqual([
      {
        type: 'authFormChange',
        field: 'baseUrl',
        value: 'https://api.anthropic.comhttps://x.test/v1',
      },
    ]);
  });

  it('backspace deletes the last character of the selected field', () => {
    const { host, actions } = makeHost(setupPanel(4)); // alias = 'anthropic'
    const consumed = tryAuthModelPickerKeys(
      host,
      '',
      keyEvt({ backspace: true }),
      false,
      noDebounce,
    );
    expect(consumed).toBe(true);
    expect(actions).toEqual([
      { type: 'authFormChange', field: 'alias', value: 'anthropic'.slice(0, -1) },
    ]);
  });

  it('backspace on an empty field dispatches the same empty value (idempotent)', () => {
    const panel = setupPanel(7); // models = ''
    const { host, actions } = makeHost(panel);
    tryAuthModelPickerKeys(host, '', keyEvt({ backspace: true }), false, noDebounce);
    expect(actions).toEqual([{ type: 'authFormChange', field: 'models', value: '' }]);
  });

  it('ignores ctrl/meta printable input on text fields but still consumes the key', () => {
    const { host, actions } = makeHost(setupPanel(4));
    const ctrl = tryAuthModelPickerKeys(host, 'c', keyEvt({ ctrl: true }), false, noDebounce);
    const meta = tryAuthModelPickerKeys(host, 'c', keyEvt({ meta: true }), false, noDebounce);
    expect(ctrl).toBe(true);
    expect(meta).toBe(true);
    expect(actions).toEqual([]);
  });
});

describe('auth form key routing — family ←/→ cycling', () => {
  it('→ moves to the next family', () => {
    const { host, actions } = makeHost(setupPanel(2, 'openai'));
    const consumed = tryAuthModelPickerKeys(
      host,
      '',
      keyEvt({ rightArrow: true }),
      false,
      noDebounce,
    );
    expect(consumed).toBe(true);
    expect(actions).toEqual([
      { type: 'authFormChange', field: 'family', value: 'openai-compatible' },
    ]);
  });

  it('← moves to the previous family', () => {
    const { host, actions } = makeHost(setupPanel(2, 'openai-compatible'));
    tryAuthModelPickerKeys(host, '', keyEvt({ leftArrow: true }), false, noDebounce);
    expect(actions).toEqual([{ type: 'authFormChange', field: 'family', value: 'openai' }]);
  });

  it('→ wraps from the last family back to the first', () => {
    const { host, actions } = makeHost(setupPanel(2, 'google'));
    tryAuthModelPickerKeys(host, '', keyEvt({ rightArrow: true }), false, noDebounce);
    expect(actions).toEqual([{ type: 'authFormChange', field: 'family', value: 'anthropic' }]);
  });

  it('← wraps from the first family back to the last', () => {
    const { host, actions } = makeHost(setupPanel(2, 'anthropic'));
    tryAuthModelPickerKeys(host, '', keyEvt({ leftArrow: true }), false, noDebounce);
    expect(actions).toEqual([{ type: 'authFormChange', field: 'family', value: 'google' }]);
  });

  it('an empty family enters the cycle on the first entry', () => {
    const { host, actions } = makeHost(setupPanel(2, ''));
    tryAuthModelPickerKeys(host, '', keyEvt({ rightArrow: true }), false, noDebounce);
    expect(actions).toEqual([{ type: 'authFormChange', field: 'family', value: 'anthropic' }]);
  });

  it('typing on the family row is ignored (arrows own the field)', () => {
    const { host, actions } = makeHost(setupPanel(2));
    const consumed = tryAuthModelPickerKeys(host, 'x', keyEvt(), false, noDebounce);
    expect(consumed).toBe(true);
    expect(actions).toEqual([]);
  });
});

describe('auth form key routing — non-field rows and navigation', () => {
  it('keys pressed on the Cancel/Save rows are consumed but change nothing', () => {
    // Setup: 9 field rows (0-8) then 9 cancel · 10 save.
    const { host, actions } = makeHost(setupPanel(9));
    const consumed = tryAuthModelPickerKeys(host, 'x', keyEvt(), false, noDebounce);
    expect(consumed).toBe(true);
    expect(actions).toEqual([]);
  });

  it('up/down still move the row selection instead of editing text', () => {
    const { host, actions } = makeHost(setupPanel(4));
    tryAuthModelPickerKeys(host, '', keyEvt({ downArrow: true }), false, noDebounce);
    tryAuthModelPickerKeys(host, '', keyEvt({ upArrow: true }), false, noDebounce);
    expect(actions).toEqual([
      { type: 'authMove', delta: 1 },
      { type: 'authMove', delta: -1 },
    ]);
  });

  it('Enter routes to onAuthEnter (field advance / Cancel / Save live there)', () => {
    const { host } = makeHost(setupPanel(9));
    const consumed = tryAuthModelPickerKeys(host, '', keyEvt({ return: true }), true, noDebounce);
    expect(consumed).toBe(true);
    expect(host.onAuthEnter).toHaveBeenCalledTimes(1);
  });

  it('Esc routes to onAuthBack so the form returns to the previous view', () => {
    const { host } = makeHost(setupPanel(0));
    const consumed = tryAuthModelPickerKeys(host, '', keyEvt({ escape: true }), false, noDebounce);
    expect(consumed).toBe(true);
    expect(host.onAuthBack).toHaveBeenCalledTimes(1);
  });

  it('the form branch never fires outside the form view', () => {
    const { host, actions } = makeHost({
      ...AUTH_PANEL_INITIAL,
      open: true,
      view: 'list',
      selected: 0,
    });
    const consumed = tryAuthModelPickerKeys(host, 'x', keyEvt(), false, noDebounce);
    expect(consumed).toBe(true);
    expect(actions).toEqual([]);
  });
});
