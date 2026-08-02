/**
 * Tests for PluginToggleList — the WebUI Settings → Features per-plugin
 * enable/disable list.
 *
 * Verifies the list is driven by the shared audit catalog
 * (@wrongstack/plugins/plugin-audit-catalog): EVERY plugin the host knows
 * about renders (active AND inactive), default enablement follows the catalog
 * defaultState, the catalog summary renders as a hint, and toggling writes
 * through localPrefs.pluginsEnabled (the existing per-browser override that
 * the server persists to extensions.<name>.enabled).
 *
 * No i18n mock needed — the real i18n module initialises on first import and
 * t(key) falls back to the key string for missing translations; non-curated
 * plugins use a name-derived label, so their switch aria-labels are stable.
 */
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { PLUGIN_AUDIT_ENTRIES } from '@wrongstack/plugins/plugin-audit-catalog';
import { PluginToggleList } from '../../src/components/SettingsPanel/PluginToggleList';
import { useLocalPrefs } from '../../src/stores/local-prefs';

const STORAGE_KEY = 'wrongstack-local-prefs';

function getSwitchByLabel(label: string): HTMLElement {
  const el = screen.getAllByRole('switch').find((s) => s.getAttribute('aria-label') === label);
  if (!el) throw new Error(`PluginToggleList switch not found for label "${label}"`);
  return el;
}

beforeEach(() => {
  localStorage.removeItem(STORAGE_KEY);
  // Start from a clean per-plugin override map so catalog defaults apply.
  useLocalPrefs.setState({ pluginsEnabled: {} });
});

afterEach(() => {
  cleanup();
  localStorage.removeItem(STORAGE_KEY);
});

describe('PluginToggleList — full catalog rendering', () => {
  it('renders one toggle for every plugin in the shared catalog (active and inactive)', () => {
    render(<PluginToggleList />);
    const switches = screen.getAllByRole('switch');
    expect(switches.length).toBe(PLUGIN_AUDIT_ENTRIES.length);
    // The old implementation hardcoded 17 plugins; the catalog-driven list
    // must be substantially larger (host + official entries).
    expect(PLUGIN_AUDIT_ENTRIES.length).toBeGreaterThan(17);
  });

  it('shows inactive-by-default plugins off and active-by-default plugins on', () => {
    render(<PluginToggleList />);
    // agent-handoff: official, defaultState 'inactive', name-derived label.
    expect(getSwitchByLabel('Agent Handoff').getAttribute('aria-checked')).toBe('false');
    // config-validator: official, defaultState 'active', name-derived label.
    expect(getSwitchByLabel('Config Validator').getAttribute('aria-checked')).toBe('true');
  });

  it('renders the catalog summary as a hint under each plugin', () => {
    render(<PluginToggleList />);
    const entry = PLUGIN_AUDIT_ENTRIES.find((e) => e.name === 'agent-handoff');
    expect(entry, 'agent-handoff catalog entry').toBeDefined();
    expect(screen.getAllByText(entry!.summary).length).toBeGreaterThan(0);
  });
});

describe('PluginToggleList — toggle write-side', () => {
  it('writes the flipped state to localPrefs.pluginsEnabled on click', () => {
    render(<PluginToggleList />);
    const switchEl = getSwitchByLabel('Agent Handoff');
    expect(switchEl.getAttribute('aria-checked')).toBe('false');
    fireEvent.click(switchEl);
    expect(useLocalPrefs.getState().pluginsEnabled['agent-handoff']).toBe(true);
    expect(getSwitchByLabel('Agent Handoff').getAttribute('aria-checked')).toBe('true');
  });

  it('honours an existing localPrefs override over the catalog default', () => {
    // agent-handoff defaults inactive; pin it enabled via the override map.
    useLocalPrefs.setState({ pluginsEnabled: { 'agent-handoff': true } });
    render(<PluginToggleList />);
    expect(getSwitchByLabel('Agent Handoff').getAttribute('aria-checked')).toBe('true');
  });
});
