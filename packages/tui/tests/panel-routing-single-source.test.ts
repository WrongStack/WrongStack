import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import type { Settings } from '../src/app-settings-type.js';
import {
  buildSidebarOpenFlags,
  effectiveAgentSwarmPanelMode,
  effectivePanelPositions,
  resolveAppSidebarLayout,
} from '../src/app-ui-state.js';
import { SIDEBAR_TWIN_HEIGHT_BY_PANEL } from '../src/sidebar-sizing.js';
import { SIDEBAR_TWIN_MAX_WRAP_LINES } from '../src/ui-contracts.js';
import { createTestState } from './helpers/create-test-state.js';

const SRC_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'src');

function pickerState(panelPositions: Record<string, 'bottom' | 'sidebar'>, open: boolean) {
  const base = createTestState();
  return createTestState({
    settingsPicker: {
      ...base.settingsPicker,
      open,
      panelPositions: { ...base.settingsPicker.panelPositions, ...panelPositions },
    },
  });
}

const persistedSidebarFleet = {
  panelPositions: { fleet: 'sidebar' },
} as unknown as Settings;

describe('panel routing single source (effectivePanelPositions)', () => {
  it('uses the picker draft while the settings picker is open', () => {
    const state = pickerState({ fleet: 'sidebar' }, true);
    // Persisted config says bottom (default) — the draft must win.
    expect(effectivePanelPositions(state, undefined).fleet).toBe('sidebar');
    expect(effectivePanelPositions(state, persistedSidebarFleet).todos).toBe('bottom');
  });

  it('uses the persisted config when the picker is closed', () => {
    // Draft says sidebar but the picker is closed — persisted (default
    // bottom) must win; a stale draft must never leak out of the picker.
    const state = pickerState({ fleet: 'sidebar' }, false);
    expect(effectivePanelPositions(state, undefined).fleet).toBe('bottom');
    expect(effectivePanelPositions(state, persistedSidebarFleet).fleet).toBe('sidebar');
  });

  it('resolveAppSidebarLayout routes from the draft, so the dispatcher matches the renderer', () => {
    const state = pickerState({ fleet: 'sidebar' }, true);
    const layout = resolveAppSidebarLayout(state, 120, undefined, false);
    expect(layout.panelPositions.fleet).toBe('sidebar');
  });

  it('reserves per-panel twin heights for wrapped worklists and two-line connections', () => {
    const base = createTestState();
    const state = createTestState({
      todosMonitorOpen: true,
      connectionsPanelOpen: true,
      settingsPicker: {
        ...base.settingsPicker,
        open: true,
        panelPositions: {
          ...base.settingsPicker.panelPositions,
          todos: 'sidebar',
          connections: 'sidebar',
        },
      },
    });

    const layout = resolveAppSidebarLayout(state, 80, undefined, false);
    expect(layout.sidebarTwinRowCount).toBe(
      SIDEBAR_TWIN_HEIGHT_BY_PANEL.todos + SIDEBAR_TWIN_HEIGHT_BY_PANEL.connections,
    );
    expect(SIDEBAR_TWIN_HEIGHT_BY_PANEL.todos).toBeGreaterThan(12 * SIDEBAR_TWIN_MAX_WRAP_LINES);
    expect(SIDEBAR_TWIN_HEIGHT_BY_PANEL.connections).toBeGreaterThanOrEqual(26);
  });
});

describe('agent swarm mode single source (effectiveAgentSwarmPanelMode)', () => {
  it('prefers the picker draft while open and the persisted value otherwise', () => {
    const base = createTestState();
    const open = createTestState({
      settingsPicker: { ...base.settingsPicker, open: true, showAgentSwarmPanel: 'off' },
    });
    const closed = createTestState({
      settingsPicker: { ...base.settingsPicker, open: false, showAgentSwarmPanel: 'off' },
    });
    const persisted = { showAgentSwarmPanel: 'sidebar' } as unknown as Settings;
    expect(effectiveAgentSwarmPanelMode(open, persisted)).toBe('off');
    expect(effectiveAgentSwarmPanelMode(closed, persisted)).toBe('sidebar');
    expect(effectiveAgentSwarmPanelMode(closed, undefined)).toBe('bottom');
  });

  it('gates the agents sidebar slot on the effective (draft-aware) mode', () => {
    const base = createTestState();
    // Persisted mode visible, but the user is previewing 'off' in the open
    // picker: the agents slot must NOT be offered.
    const state = createTestState({
      agentsMonitorOpen: true,
      settingsPicker: { ...base.settingsPicker, open: true, showAgentSwarmPanel: 'off' },
    });
    const persisted = { showAgentSwarmPanel: 'bottom' } as unknown as Settings;
    expect(buildSidebarOpenFlags(state, persisted).agents).toBe(false);
    expect(
      buildSidebarOpenFlags(
        { ...state, settingsPicker: { ...state.settingsPicker, open: false } },
        persisted,
      ).agents,
    ).toBe(true);
  });
});

describe('all surfaces read routing through the shared authority', () => {
  // The bug this pins: app.tsx, app-view.tsx, and app-status-region.tsx each
  // answered "where is this panel routed?" from a different source (persisted
  // config vs picker draft), so a panel routed to the sidebar from the open
  // settings picker rendered on BOTH surfaces at once. Any direct read of
  // `liveSettings?.panelPositions` or `settingsPicker.panelPositions` outside
  // app-ui-state.ts re-introduces that split-brain.
  const SURFACES = ['app.tsx', 'app-view.tsx', 'app-status-region.tsx'];

  for (const file of SURFACES) {
    it(`${file} does not read routing from the persisted config directly`, () => {
      const src = readFileSync(join(SRC_DIR, file), 'utf8');
      // Passing the raw draft TO the settings picker component itself
      // (`panelPositions={state.settingsPicker.panelPositions}`) is fine —
      // the picker renders its own draft. What must never come back is a
      // surface answering "where is this panel routed?" from the persisted
      // config alone.
      expect(src).not.toMatch(/liveSettings\?\.panelPositions/);
      expect(src).not.toMatch(/liveSettings\?\.showAgentSwarmPanel/);
    });
  }

  it('app.tsx and app-view.tsx both call resolveAppSidebarLayout', () => {
    for (const file of ['app.tsx', 'app-view.tsx']) {
      const src = readFileSync(join(SRC_DIR, file), 'utf8');
      expect(src).toContain('resolveAppSidebarLayout(');
      expect(src).not.toMatch(/[^p]resolveSidebarLayout\(/);
    }
  });
});
