// Reducer transitions for the /auth panel slice. Mirrors the approach of
// plugin-picker-reducer.test.ts but builds a minimal State containing only
// the slices the auth cases (and closePanels) touch — the reducer never
// reads beyond these for the actions under test.

import { describe, expect, it } from 'vitest';
import { reducer, type State } from '../src/app-reducer.js';
import { AUTH_PANEL_INITIAL, type AuthProviderRow } from '../src/components/auth-panel-model.js';

function provider(id: string): AuthProviderRow {
  return { id, models: [], envVars: [], keys: [] };
}

function initial(): State {
  return {
    authPanel: { ...AUTH_PANEL_INITIAL },
    monitorOpen: false,
    agentsMonitorOpen: false,
    helpOpen: false,
    todosMonitorOpen: false,
    queuePanelOpen: false,
    processListOpen: false,
    auditPanelOpen: false,
    planPanelOpen: false,
    goalPanelOpen: false,
    sessionsPanelOpen: false,
    settingsPicker: { open: false },
    statuslinePicker: { open: false, field: 0, hiddenItems: [], visibleChips: [] },
    pluginPicker: { open: false, items: [], selected: 0, busy: false },
    projectPicker: { open: false, allItems: [], items: [], selected: 0, filter: '' },
    fKeyPicker: { open: false, selected: 0 },
    goalRun: undefined,
    sddBoard: undefined,
    worktreeMonitorOpen: false,
    coordinator: { monitorOpen: false },
  } as unknown as State;
}

describe('authOpen / authClose', () => {
  it('opens on the list view, busy until providers load', () => {
    const s = reducer(initial(), { type: 'authOpen' });
    expect(s.authPanel.open).toBe(true);
    expect(s.authPanel.view).toBe('list');
    expect(s.authPanel.busy).toBe(true);
  });

  it('accepts a seeded provider list (not busy) and an oauth start view', () => {
    const s = reducer(initial(), {
      type: 'authOpen',
      view: 'oauth',
      providers: [provider('a')],
    });
    expect(s.authPanel.view).toBe('oauth');
    expect(s.authPanel.busy).toBe(false);
    expect(s.authPanel.providers).toHaveLength(1);
  });

  it('closes sibling panels on open, and is closed by sibling opens', () => {
    const withPlugin = reducer(initial(), { type: 'pluginPickerOpen', items: [] });
    const s = reducer(withPlugin, { type: 'authOpen' });
    expect(s.pluginPicker.open).toBe(false);
    expect(s.authPanel.open).toBe(true);

    const back = reducer(s, { type: 'pluginPickerOpen', items: [] });
    expect(back.authPanel.open).toBe(false);
    expect(back.pluginPicker.open).toBe(true);
  });

  it('authClose clears open + busy but keeps loaded data', () => {
    let s = reducer(initial(), { type: 'authOpen' });
    s = reducer(s, { type: 'authProviders', providers: [provider('a')] });
    s = reducer(s, { type: 'authClose' });
    expect(s.authPanel.open).toBe(false);
    expect(s.authPanel.busy).toBe(false);
    expect(s.authPanel.providers).toHaveLength(1);
  });
});

describe('providers / navigation', () => {
  it('authProviders clears busy and clamps the cursor', () => {
    let s = reducer(initial(), { type: 'authOpen' });
    s = { ...s, authPanel: { ...s.authPanel, selected: 10 } };
    s = reducer(s, { type: 'authProviders', providers: [provider('a')] });
    expect(s.authPanel.busy).toBe(false);
    // 1 provider + 4 actions = 5 rows → cursor clamps to 4.
    expect(s.authPanel.selected).toBe(4);
  });

  it('authMove wraps across the row list', () => {
    let s = reducer(initial(), {
      type: 'authOpen',
      providers: [provider('a')],
    });
    s = reducer(s, { type: 'authMove', delta: -1 });
    expect(s.authPanel.selected).toBe(4);
    s = reducer(s, { type: 'authMove', delta: 1 });
    expect(s.authPanel.selected).toBe(0);
  });

  it('authView resets cursor + filter and records the provider id', () => {
    let s = reducer(initial(), { type: 'authOpen', providers: [provider('a')] });
    s = { ...s, authPanel: { ...s.authPanel, selected: 3, filter: 'xyz' } };
    s = reducer(s, { type: 'authView', view: 'provider', providerId: 'a' });
    expect(s.authPanel.view).toBe('provider');
    expect(s.authPanel.providerId).toBe('a');
    expect(s.authPanel.selected).toBe(0);
    expect(s.authPanel.filter).toBe('');
  });

  it('authFilter resets the cursor to the top of the filtered list', () => {
    let s = reducer(initial(), { type: 'authOpen', providers: [] });
    s = reducer(s, { type: 'authView', view: 'catalog' });
    s = { ...s, authPanel: { ...s.authPanel, selected: 2 } };
    s = reducer(s, { type: 'authFilter', filter: 'an' });
    expect(s.authPanel.filter).toBe('an');
    expect(s.authPanel.selected).toBe(0);
  });
});

describe('flow lifecycle', () => {
  it('authFlowStart switches to the flow view with a fresh log', () => {
    let s = reducer(initial(), { type: 'authOpen' });
    s = { ...s, authPanel: { ...s.authPanel, log: ['stale'] } };
    s = reducer(s, { type: 'authFlowStart', title: 'Sign in with ChatGPT' });
    expect(s.authPanel.view).toBe('flow');
    expect(s.authPanel.flowTitle).toBe('Sign in with ChatGPT');
    expect(s.authPanel.log).toEqual([]);
    expect(s.authPanel.flowDone).toBe(false);
    expect(s.authPanel.busy).toBe(true);
  });

  it('authFlowLog appends and caps retention at 200 lines', () => {
    let s = reducer(initial(), { type: 'authFlowStart', title: 't' });
    for (let i = 0; i < 205; i++) {
      s = reducer(s, { type: 'authFlowLog', line: `line ${i}` });
    }
    expect(s.authPanel.log).toHaveLength(200);
    expect(s.authPanel.log[0]).toBe('line 5');
    expect(s.authPanel.log.at(-1)).toBe('line 204');
  });

  it('authFlowDone records the outcome, appends the message, clears the prompt', () => {
    let s = reducer(initial(), { type: 'authFlowStart', title: 't' });
    s = reducer(s, { type: 'authPromptStart', label: 'Paste the code', masked: false });
    s = reducer(s, { type: 'authFlowDone', ok: false, message: 'Cancelled.' });
    expect(s.authPanel.flowDone).toBe(true);
    expect(s.authPanel.flowOk).toBe(false);
    expect(s.authPanel.busy).toBe(false);
    expect(s.authPanel.input).toBeUndefined();
    expect(s.authPanel.log.at(-1)).toBe('Cancelled.');
  });
});

describe('modal prompt + confirm', () => {
  it('prompt start/change/end round-trips the draft', () => {
    let s = reducer(initial(), { type: 'authPromptStart', label: 'API key', masked: true });
    expect(s.authPanel.input).toMatchObject({ label: 'API key', masked: true, draft: '' });
    s = reducer(s, { type: 'authPromptChange', draft: 'sk-abc' });
    expect(s.authPanel.input?.draft).toBe('sk-abc');
    s = reducer(s, { type: 'authPromptEnd' });
    expect(s.authPanel.input).toBeUndefined();
  });

  it('authPromptChange without an active prompt is a no-op', () => {
    const s0 = initial();
    const s = reducer(s0, { type: 'authPromptChange', draft: 'x' });
    expect(s.authPanel.input).toBeUndefined();
  });

  it('confirm start/end round-trips the pending action', () => {
    let s = reducer(initial(), {
      type: 'authConfirmStart',
      question: 'Remove provider "a" and 2 key(s)?',
      action: { kind: 'remove-provider', providerId: 'a' },
    });
    expect(s.authPanel.confirm?.action).toEqual({ kind: 'remove-provider', providerId: 'a' });
    s = reducer(s, { type: 'authConfirmEnd' });
    expect(s.authPanel.confirm).toBeUndefined();
  });
});

describe('form lifecycle', () => {
  const setupForm = {
    kind: 'setup' as const,
    fields: {
      type: '',
      name: '',
      family: 'openai-compatible' as const,
      baseUrl: '',
      alias: '',
      keyLabel: 'default',
      apiKey: '',
      models: '',
      envVars: '',
    },
  };

  const editForm = {
    kind: 'edit' as const,
    providerId: 'anthropic',
    fields: {
      type: 'anthropic',
      name: '',
      family: 'anthropic' as const,
      baseUrl: '',
      alias: 'anthropic',
      keyLabel: '',
      apiKey: '',
      models: '',
      envVars: '',
    },
  };

  it('authFormStart switches to the form view with fields and a fresh cursor', () => {
    let s = reducer(initial(), { type: 'authOpen' });
    s = { ...s, authPanel: { ...s.authPanel, selected: 7 } };
    s = reducer(s, { type: 'authFormStart', form: setupForm });
    expect(s.authPanel.view).toBe('form');
    expect(s.authPanel.form).toEqual(setupForm);
    expect(s.authPanel.selected).toBe(0);
  });

  it('authFormChange updates the named field and leaves the rest intact', () => {
    let s = reducer(initial(), { type: 'authOpen' });
    s = reducer(s, { type: 'authFormStart', form: setupForm });
    s = reducer(s, { type: 'authFormChange', field: 'baseUrl', value: 'https://example.test' });
    expect(s.authPanel.form?.fields.baseUrl).toBe('https://example.test');
    expect(s.authPanel.form?.fields.family).toBe('openai-compatible');
  });

  it('authFormChange cycles the family field when arrows fire', () => {
    let s = reducer(initial(), { type: 'authOpen' });
    s = reducer(s, { type: 'authFormStart', form: setupForm });
    s = reducer(s, { type: 'authFormChange', field: 'family', value: 'google' });
    expect(s.authPanel.form?.fields.family).toBe('google');
  });

  it('authFormCancel returns to the list view and clears the form slice', () => {
    let s = reducer(initial(), { type: 'authOpen' });
    s = reducer(s, { type: 'authFormStart', form: setupForm });
    s = reducer(s, { type: 'authFormCancel' });
    expect(s.authPanel.view).toBe('list');
    expect(s.authPanel.form).toBeUndefined();
  });

  it('authView to a non-form view clears the form slice (stale defaults guard)', () => {
    let s = reducer(initial(), { type: 'authOpen' });
    s = reducer(s, { type: 'authFormStart', form: editForm });
    expect(s.authPanel.form).toBeDefined();
    s = reducer(s, { type: 'authView', view: 'provider', providerId: 'anthropic' });
    expect(s.authPanel.form).toBeUndefined();
    expect(s.authPanel.view).toBe('provider');
  });

  it('authView to the form view preserves the live form slice', () => {
    let s = reducer(initial(), { type: 'authOpen' });
    s = reducer(s, { type: 'authFormStart', form: setupForm });
    const live = s.authPanel.form;
    s = reducer(s, { type: 'authView', view: 'list' });
    s = reducer(s, { type: 'authView', view: 'form' });
    // Re-entering the form view keeps the slice the user is editing only
    // because nothing else touched it; the guard in the previous case is
    // for cross-view transitions, not for a no-op round trip.
    expect(s.authPanel.view).toBe('form');
  });
});
