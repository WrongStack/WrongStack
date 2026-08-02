/**
 * Tests for ChimeraSettingsPanel — the dedicated WebUI section that exposes
 * every knob of the post-session `wstack-chimera` plugin and the mid-session
 * `wstack-auto-review` plugin (provider, model, maxFiles, fallbackProfile,
 * fallbackModels, debounce, concurrency, toggles). Mutating follow-up controls
 * are intentionally absent because report completion is passive.
 *
 * The decisive checks here are *contract*: every PrefKey the panel reads
 * must exist on LocalPrefs (catches drift between the panel and the typed
 * store), and the panel must emit the correct pref key on each interaction.
 *
 * No i18n mock is needed — the real i18n module initialises on first import,
 * and `t(key)` falls back to the key string when a translation is missing,
 * which is fine for tests that assert on `key`-based text.
 */

import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ChimeraSettingsPanel } from '../../src/components/SettingsPanel/ChimeraSettingsPanel';
import { useLocalPrefs } from '../../src/stores/local-prefs';

const STORAGE_KEY = 'wrongstack-local-prefs';

function clearPersisted(): void {
  localStorage.removeItem(STORAGE_KEY);
}

function setPersisted(patch: Record<string, unknown>): void {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(patch));
}

beforeEach(() => {
  clearPersisted();
});

afterEach(() => {
  cleanup();
  clearPersisted();
});

describe('ChimeraSettingsPanel — typed contract', () => {
  it('renders every PrefKey it binds to (catches drift between panel and store)', () => {
    render(
      <ChimeraSettingsPanel
        syncPref={vi.fn()}
        sessionProvider="anthropic"
        sessionModel="claude-opus"
      />,
    );
    // The panel reads/writes these LocalPrefs slots. If any of them disappear
    // from LocalPrefs, this test fails — preventing silent panel/store drift.
    const required = [
      'chimeraEnabled',
      'chimeraProvider',
      'chimeraModel',
      'chimeraMaxFiles',
      'autoReviewEnabled',
      'autoReviewProvider',
      'autoReviewModel',
      'autoReviewFallbackProfile',
      'autoReviewDebounceMs',
      'autoReviewMaxFilesPerBatch',
      'autoReviewMaxConcurrentReviews',
    ];
    for (const k of required) {
      expect(
        k in useLocalPrefs.getState(),
        `LocalPrefs slot "${k}" missing — ChimeraSettingsPanel relies on it`,
      ).toBe(true);
    }
  });

  it('does not expose automatic fix or cascade controls', () => {
    render(<ChimeraSettingsPanel syncPref={vi.fn()} />);
    expect(screen.queryByText('Auto-fix mode')).toBeNull();
    expect(screen.queryByText('Cascade on')).toBeNull();
  });
});

describe('ChimeraSettingsPanel — toggle emissions', () => {
  it('flips chimeraEnabled through syncPref when the section toggle is clicked', () => {
    const syncPref = vi.fn();
    render(<ChimeraSettingsPanel syncPref={syncPref} />);

    // Find the section toggles — the panel renders exactly one master toggle
    // per section (chimera + auto-review). Switches are rendered as
    // role="switch" buttons.
    const toggles = screen.getAllByRole('switch');
    expect(toggles.length).toBe(2);
    // First toggle = chimeraEnabled; clicking it flips the default (true → false).
    fireEvent.click(toggles[0]!);
    expect(syncPref).toHaveBeenCalledWith('chimeraEnabled', false);
  });

  it('flips autoReviewEnabled through syncPref when the auto-review toggle is clicked', () => {
    const syncPref = vi.fn();
    render(<ChimeraSettingsPanel syncPref={syncPref} />);
    const toggles = screen.getAllByRole('switch');
    fireEvent.click(toggles[1]!);
    expect(syncPref).toHaveBeenCalledWith('autoReviewEnabled', true);
  });
});

describe('ChimeraSettingsPanel — model picker dialog opens', () => {
  it('opens the unified ModelSelectDialog when the chimera model picker row is activated', () => {
    render(
      <ChimeraSettingsPanel
        syncPref={vi.fn()}
        sessionProvider="anthropic"
        sessionModel="claude-opus-4-6"
      />,
    );
    // The picker row is a div[role=button] containing the "Model" label
    // from the English locale (the real i18n resolves translations
    // from the bundled JSON).
    const picker = screen.getAllByRole('button').find((el) => el.textContent?.includes('Model'));
    expect(picker, 'chimera model picker row').toBeDefined();
    fireEvent.click(picker!);
    // The dialog mounts ModelSelectDialog which renders the i18n title
    // "Pick provider/model for Chimera" from settings.json.
    expect(
      screen.getByText('Pick provider/model for Chimera'),
      'dialog title from the chimera picker',
    ).toBeTruthy();
  });
});

describe('ChimeraSettingsPanel — fallback chain display', () => {
  it('shows the empty-chain hint when no fallback profile is selected and the resolved chain is empty', () => {
    setPersisted({
      state: { autoReviewFallbackModels: [] },
      version: 9,
    });
    render(<ChimeraSettingsPanel syncPref={vi.fn()} />);
    expect(screen.getByText('No fallback models configured')).toBeTruthy();
  });

  it('surfaces the named profile chain when a fallback profile is selected', () => {
    // Seed the persisted store with a named fallback profile so the panel
    // reads the chain through useLocalPrefs.getState() at render time.
    // The persist middleware has already hydrated before render; we update
    // the live store directly rather than waiting for a localStorage change.
    useLocalPrefs.setState({
      autoReviewFallbackProfile: 'review',
      autoReviewFallbackModels: [],
      fallbackProfiles: { review: ['anthropic/claude-opus-4-6', 'openai/gpt-4o'] },
    });
    render(<ChimeraSettingsPanel syncPref={vi.fn()} />);
    // The named profile's chain entries appear as monospace badges.
    expect(screen.getByText('anthropic/claude-opus-4-6')).toBeTruthy();
    expect(screen.getByText('openai/gpt-4o')).toBeTruthy();
  });
});
