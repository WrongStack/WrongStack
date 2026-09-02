import { beforeEach, describe, expect, it } from 'vitest';
import { useConfigStore } from '../../src/stores/config-store';

function resetStore() {
  useConfigStore.setState({
    provider: '',
    model: '',
    wsUrl: 'ws://127.0.0.1:3457',
    wsConnected: false,
    wsStatus: { state: 'connecting' },
    theme: 'system',
    palette: 'signal',
    autoConnect: true,
    soundOnComplete: false,
  });
}

// ── setProvider ───────────────────────────────────────────────────

describe('setProvider', () => {
  beforeEach(() => resetStore());

  it('updates the provider', () => {
    useConfigStore.getState().setProvider('openai');
    expect(useConfigStore.getState().provider).toBe('openai');
  });

  it('preserves model', () => {
    useConfigStore.getState().setModel('gpt-4o');
    useConfigStore.getState().setProvider('anthropic');
    expect(useConfigStore.getState().model).toBe('gpt-4o');
  });
});

// ── setModel ─────────────────────────────────────────────────────

describe('setModel', () => {
  beforeEach(() => resetStore());

  it('updates the model', () => {
    useConfigStore.getState().setModel('gpt-4o');
    expect(useConfigStore.getState().model).toBe('gpt-4o');
  });
});

// ── setConfig ───────────────────────────────────────────────────

describe('setConfig', () => {
  beforeEach(() => resetStore());

  it('applies partial config', () => {
    useConfigStore.getState().setConfig({ autoConnect: false, soundOnComplete: true });
    const state = useConfigStore.getState();
    expect(state.autoConnect).toBe(false);
    expect(state.soundOnComplete).toBe(true);
    expect(state.theme).toBe('system');
  });

  it('updates wsConnected', () => {
    useConfigStore.getState().setConfig({ wsConnected: true });
    expect(useConfigStore.getState().wsConnected).toBe(true);
  });

  it('updates wsStatus but not wsConnected (use setWsStatus for that)', () => {
    // setConfig just spreads config — wsConnected inference requires setWsStatus
    useConfigStore.getState().setConfig({ wsStatus: { state: 'open' } });
    expect(useConfigStore.getState().wsStatus).toEqual({ state: 'open' });
    // wsConnected is NOT auto-updated via setConfig — must use setWsStatus directly
    expect(useConfigStore.getState().wsConnected).toBe(false);
  });

  it('handles reconnecting status', () => {
    useConfigStore.getState().setConfig({
      wsStatus: {
        state: 'reconnecting',
        attempt: 3,
        nextRetryAt: Date.now(),
        lastError: 'timeout',
      },
    });
    expect(useConfigStore.getState().wsConnected).toBe(false);
  });

  it('handles closed status with error', () => {
    useConfigStore.getState().setConfig({
      wsStatus: { state: 'closed', error: 'Connection refused' },
    });
    expect(useConfigStore.getState().wsConnected).toBe(false);
  });
});

// ── setTheme ────────────────────────────────────────────────────

describe('setTheme', () => {
  beforeEach(() => resetStore());

  it('updates theme', () => {
    useConfigStore.getState().setTheme('dark');
    expect(useConfigStore.getState().theme).toBe('dark');
  });

  it('accepts all theme variants', () => {
    for (const t of ['light', 'dark', 'system'] as const) {
      useConfigStore.getState().setTheme(t);
      expect(useConfigStore.getState().theme).toBe(t);
    }
  });
});

// ── setWsConnected ───────────────────────────────────────────────

describe('setWsConnected', () => {
  beforeEach(() => resetStore());

  it('sets connected to true', () => {
    useConfigStore.getState().setWsConnected(true);
    expect(useConfigStore.getState().wsConnected).toBe(true);
  });

  it('sets connected to false', () => {
    useConfigStore.getState().setWsConnected(false);
    expect(useConfigStore.getState().wsConnected).toBe(false);
  });
});

// ── setWsStatus ─────────────────────────────────────────────────

describe('setWsStatus', () => {
  beforeEach(() => resetStore());

  it('updates wsStatus and infers wsConnected', () => {
    useConfigStore.getState().setWsStatus({ state: 'open' });
    expect(useConfigStore.getState().wsStatus).toEqual({ state: 'open' });
    expect(useConfigStore.getState().wsConnected).toBe(true);
  });

  it('closed state sets wsConnected to false', () => {
    useConfigStore.getState().setWsStatus({ state: 'closed', error: 'err' });
    expect(useConfigStore.getState().wsConnected).toBe(false);
  });

  it('reconnecting state sets wsConnected to false', () => {
    useConfigStore.getState().setWsStatus({ state: 'reconnecting', attempt: 1, nextRetryAt: 0 });
    expect(useConfigStore.getState().wsConnected).toBe(false);
  });

  it('connecting state sets wsConnected to false', () => {
    useConfigStore.getState().setWsStatus({ state: 'connecting' });
    expect(useConfigStore.getState().wsConnected).toBe(false);
  });
});

// ── setSoundOnComplete ──────────────────────────────────────────

describe('setSoundOnComplete', () => {
  beforeEach(() => resetStore());

  it('enables sound', () => {
    useConfigStore.getState().setSoundOnComplete(true);
    expect(useConfigStore.getState().soundOnComplete).toBe(true);
  });

  it('disables sound', () => {
    useConfigStore.getState().setSoundOnComplete(false);
    expect(useConfigStore.getState().soundOnComplete).toBe(false);
  });
});

// ── palette persistence merge ──────────────────────────────────────
//
// The store's `merge` must never let a corrupted/legacy persisted palette id
// land in state, and it must converge with the ThemeProvider's authoritative
// localStorage entry (`wrongstack-palette`) even on the upgrade path where
// `wrongstack-config` predates the `palette` field.

describe('palette merge fallback', () => {
  beforeEach(() => {
    // Full isolation: reset the store (so `current` in merge is pristine and
    // wsUrl keeps its hardcoded test value) AND clear both persistence keys.
    resetStore();
    localStorage.removeItem('wrongstack-config');
    localStorage.removeItem('wrongstack-palette');
  });

  afterEach(() => {
    // rehydrate's merge recomputes wsUrl from window.location (jsdom port
    // 3000); restore the store so later suites see their expected values.
    resetStore();
    localStorage.removeItem('wrongstack-config');
    localStorage.removeItem('wrongstack-palette');
  });

  it('adopts the ThemeProvider localStorage palette when the persisted config palette is invalid', async () => {
    localStorage.setItem('wrongstack-palette', 'blue-navy');
    localStorage.setItem(
      'wrongstack-config',
      JSON.stringify({ state: { palette: 'bogus-palette' }, version: 0 }),
    );
    await useConfigStore.persist.rehydrate();
    expect(useConfigStore.getState().palette).toBe('blue-navy');
  });

  it('falls back to the default when neither source has a valid palette', async () => {
    localStorage.setItem(
      'wrongstack-config',
      JSON.stringify({ state: { palette: 'bogus-palette' }, version: 0 }),
    );
    await useConfigStore.persist.rehydrate();
    expect(useConfigStore.getState().palette).toBe('signal');
  });

  it('prefers a valid persisted config palette over the localStorage entry', async () => {
    localStorage.setItem('wrongstack-palette', 'blue-navy');
    localStorage.setItem(
      'wrongstack-config',
      JSON.stringify({ state: { palette: 'emerald-gold' }, version: 0 }),
    );
    await useConfigStore.persist.rehydrate();
    expect(useConfigStore.getState().palette).toBe('emerald-gold');
  });
});

// ── wsUrl initialization ─────────────────────────────────────────

describe('wsUrl initialization', () => {
  // Self-contained: reset the store so this suite never depends on another
  // suite's afterEach having run first (rehydrate's merge recomputes wsUrl
  // from window.location, which is jsdom port 3000 here).
  beforeEach(() => resetStore());

  it('uses localhost address for localhost hostname', () => {
    // In jsdom, window.location.hostname is 'localhost'
    const state = useConfigStore.getState();
    expect(state.wsUrl).toBe('ws://127.0.0.1:3457');
  });

  it('wsUrl is a valid ws:// URL', () => {
    const state = useConfigStore.getState();
    expect(state.wsUrl).toMatch(/^ws:\/\/.+:/);
  });

  it('does not persist runtime wsUrl or transient connection state', () => {
    const partialize = useConfigStore.persist.getOptions().partialize;
    const persisted = partialize?.({
      ...useConfigStore.getState(),
      wsUrl: 'ws://127.0.0.1:9999',
      wsConnected: true,
      wsStatus: { state: 'open' },
    });
    expect(persisted).not.toHaveProperty('wsUrl');
    expect(persisted).not.toHaveProperty('wsConnected');
    expect(persisted).not.toHaveProperty('wsStatus');
  });
});
