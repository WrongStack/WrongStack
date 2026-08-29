import { act, cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AgentSettingsTab } from '../../src/components/SettingsPanel/AgentSettingsTab';
import { useLocalPrefs } from '../../src/stores/local-prefs';
import { useSessionStore } from '../../src/stores/session-store';

// No i18n mock: the real module bundles the English catalog inline, so `t()`
// resolves synchronously and asserting on English labels is meaningful.

const syncPref = vi.fn();

function renderTab() {
  return render(
    <AgentSettingsTab syncPref={syncPref} switchAutonomy={() => {}} />,
  );
}

/** The reasoning-effort dropdown is a native <select> rendered by
 *  PreferenceSelect, which wires <label for={id}>→<select id={id}>.
 *  Resolve through that association — robust against select ordering. */
function effortSelect(): HTMLSelectElement {
  const label = screen.getByText('Reasoning effort', { selector: 'label' });
  const id = label.getAttribute('for');
  expect(id).toBeTruthy();
  const el = document.getElementById(id!);
  expect(el).toBeInstanceOf(HTMLSelectElement);
  return el as HTMLSelectElement;
}

beforeEach(() => {
  vi.clearAllMocks();
  useLocalPrefs.setState({
    reasoningMode: 'auto',
    reasoningEffort: 'high',
    reasoningPreserve: false,
    cacheTtl: 'default',
  });
  useSessionStore.setState({ reasoningEffortLevels: undefined });
});

afterEach(() => {
  cleanup();
});

describe('AgentSettingsTab effort dropdown (model-aware)', () => {
  it('shows auto + the full canonical set when the model advertises no levels', () => {
    renderTab();
    const options = Array.from(effortSelect().options).map((o) => o.value);
    expect(options).toEqual(['auto', 'none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']);
  });

  it('narrows to auto + the advertised levels when session.start carries them', () => {
    act(() => {
      useSessionStore.setState({ reasoningEffortLevels: ['low', 'high'] });
    });
    renderTab();
    const options = Array.from(effortSelect().options).map((o) => o.value);
    expect(options).toEqual(['auto', 'low', 'high']);
  });

  it('keeps the current value selectable when it is advertised', () => {
    act(() => {
      useSessionStore.setState({ reasoningEffortLevels: ['low', 'medium', 'high'] });
    });
    renderTab();
    expect(effortSelect().value).toBe('high');
  });

  it('falls back to auto + the full set when the store list is empty after a switch', () => {
    act(() => {
      useSessionStore.setState({ reasoningEffortLevels: ['low', 'high'] });
    });
    renderTab();
    expect(Array.from(effortSelect().options).map((o) => o.value)).toEqual(['auto', 'low', 'high']);
    // Model switch clears the list (setSession lifecycle) → full set returns.
    act(() => {
      useSessionStore.setState({ reasoningEffortLevels: undefined });
    });
    expect(Array.from(effortSelect().options).map((o) => o.value)).toEqual([
      'auto',
      'none',
      'minimal',
      'low',
      'medium',
      'high',
      'xhigh',
      'max',
    ]);
  });
});
