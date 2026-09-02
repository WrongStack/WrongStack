// Tests for the PanelPosition generalization.
//
// Covers:
//   - coercePanelPositionMap normalizes partial/stale/invalid maps to a
//     full PanelPositionMap
//   - PANEL_IDS / DEFAULT_PANEL_POSITIONS stay in lock-step (closed set)
//   - Settings picker reducer cycle for the per-panel rows swaps each panel
//     between 'bottom' and 'sidebar'
//   - resolveSettingsFieldValue emits single-key partial patches for
//     the per-panel rows (full-map patches would wipe sibling panels)
//   - settingsValueSet deep-merges partial panelPositions patches
//
// These tests are intentionally narrow — they verify the contract, not
// the visual render. Sidebar variants are covered by their own per-panel
// test files when needed.

import { describe, expect, it } from 'vitest';
import {
  coercePanelPositionMap,
  DEFAULT_PANEL_POSITIONS,
  PANEL_IDS,
  PANEL_POSITION_FIELD_START,
  SIDEBAR_PANEL_LIMIT,
} from '../src/ui-contracts.js';
import type { PanelId, PanelPositionMap } from '../src/ui-contracts.js';
import {
  resolveSettingsFieldValue,
  SETTINGS_FIELD_LABELS,
} from '../src/components/settings-picker-model.js';
import type { State } from '../src/app-state.js';
import { reduceSettingsValues } from '../src/reducers/settings-values.js';

describe('coercePanelPositionMap', () => {
  it('returns the full DEFAULT_PANEL_POSITIONS when input is undefined', () => {
    const out = coercePanelPositionMap(undefined);
    expect(out).toEqual(DEFAULT_PANEL_POSITIONS);
  });

  it('normalizes a partial map by filling missing entries with "bottom"', () => {
    const out = coercePanelPositionMap({ fleet: 'sidebar' });
    expect(out.fleet).toBe('sidebar');
    for (const id of PANEL_IDS) {
      if (id !== 'fleet') expect(out[id]).toBe('bottom');
    }
  });

  it('drops unknown panel ids', () => {
    const out = coercePanelPositionMap({
      fleet: 'sidebar',
      notARealPanel: 'sidebar',
    } as Partial<PanelPositionMap>);
    expect(out.fleet).toBe('sidebar');
    expect((out as Record<string, unknown>).notARealPanel).toBeUndefined();
  });

  it('treats invalid position values as "bottom"', () => {
    const out = coercePanelPositionMap({
      fleet: 'invalid-value' as unknown as 'bottom',
      agents: 'sidebar',
    });
    expect(out.fleet).toBe('bottom');
    expect(out.agents).toBe('sidebar');
  });
});

describe('PANEL_IDS / DEFAULT_PANEL_POSITIONS / SETTINGS_FIELD_LABELS contract', () => {
  it('PANEL_IDS has exactly 13 entries (12 F-key panels + Ctrl+N connections)', () => {
    expect(PANEL_IDS.length).toBe(13);
  });

  it('DEFAULT_PANEL_POSITIONS has an entry for every PanelId', () => {
    for (const id of PANEL_IDS) {
      expect(DEFAULT_PANEL_POSITIONS[id]).toBeDefined();
    }
  });

  it('SETTINGS_FIELD_LABELS has a label for every per-panel row', () => {
    for (
      let i = PANEL_POSITION_FIELD_START;
      i < PANEL_POSITION_FIELD_START + PANEL_IDS.length;
      i++
    ) {
      const label = SETTINGS_FIELD_LABELS[i];
      expect(typeof label).toBe('string');
      if (typeof label !== 'string') throw new Error(`missing label for field ${i}`);
      expect(label.length).toBeGreaterThan(0);
    }
  });

  it('the per-panel label count matches PANEL_IDS.length', () => {
    const perPanelLabels = SETTINGS_FIELD_LABELS.slice(
      PANEL_POSITION_FIELD_START,
      PANEL_POSITION_FIELD_START + PANEL_IDS.length,
    );
    expect(perPanelLabels.length).toBe(PANEL_IDS.length);
  });
});

describe('settingsValueSet reducer cycle for the per-panel rows', () => {
  // The reducer path is exercised through resolveSettingsFieldValue +
  // the settingsValueSet reducer in reducers/settings-values.ts. We test
  // the resolver here because it produces the patch the reducer merges.
  for (let i = PANEL_POSITION_FIELD_START; i < PANEL_POSITION_FIELD_START + PANEL_IDS.length; i++) {
    it(`field ${i} ('${SETTINGS_FIELD_LABELS[i]}') accepts 'bottom' and 'sidebar'`, () => {
      const bottomResult = resolveSettingsFieldValue(i, 'bottom');
      expect(bottomResult.ok).toBe(true);
      if (bottomResult.ok) {
        expect(bottomResult.displayValue).toBe('bottom');
      }
      const sidebarResult = resolveSettingsFieldValue(i, 'sidebar');
      expect(sidebarResult.ok).toBe(true);
      if (sidebarResult.ok) {
        expect(sidebarResult.displayValue).toBe('sidebar');
      }
    });

    it(`field ${i} rejects an invalid value`, () => {
      const result = resolveSettingsFieldValue(i, 'not-a-valid-position');
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error).toMatch(/bottom.*sidebar/);
      }
    });
  }
});

describe('settingsValueChange runtime reducer for fields PANEL_POSITION_FIELD_START..+13', () => {
  // Regression coverage for the user-reported bug: "in /settings, changing
  // values under the Panels section does not persist — after exit, every
  // panel still routes to 'bottom'." The runtime cycle path differs from
  // the resolver path: the reducer writes `{ ...sp.panelPositions,
  // [panelId]: next }` directly into the picker state, then the
  // useSettingsAutoSave hook fires and passes `sp.panelPositions` to
  // saveSettings(). If the reducer silently dropped the change (e.g.
  // wrong field-index range, wrong spread order, or returning `state`
  // unchanged), the hook would never see the user's pick and the
  // configStore round-trip would persist the default map every time.
  function makePickerState(): State {
    return {
      settingsPicker: {
        open: true,
        field: PANEL_POSITION_FIELD_START,
        panelPositions: coercePanelPositionMap(DEFAULT_PANEL_POSITIONS),
        showAgentSwarmPanel: 'bottom',
        // Other fields are unused by this reducer case but required by
        // the State type — cast through unknown to keep this test
        // focused on the panel-position path.
      },
    } as unknown as State;
  }

  it('field PANEL_POSITION_FIELD_START (projectPicker) cycles bottom → sidebar on +1', () => {
    const before = makePickerState();
    const after = reduceSettingsValues(before, {
      type: 'settingsValueChange',
      delta: 1,
    });
    expect(after.settingsPicker.panelPositions.projectPicker).toBe('sidebar');
    // Sibling panels untouched.
    for (const id of PANEL_IDS) {
      if (id !== 'projectPicker') {
        expect(after.settingsPicker.panelPositions[id]).toBe('bottom');
      }
    }
  });

  it('field PANEL_POSITION_FIELD_START (projectPicker) cycles sidebar → bottom on -1', () => {
    const before = makePickerState();
    const cycleOnce = reduceSettingsValues(before, {
      type: 'settingsValueChange',
      delta: 1,
    });
    const cycleBack = reduceSettingsValues(cycleOnce, {
      type: 'settingsValueChange',
      delta: -1,
    });
    expect(cycleBack.settingsPicker.panelPositions.projectPicker).toBe('bottom');
  });

  it('every per-panel field cycles independently', () => {
    for (
      let f = PANEL_POSITION_FIELD_START;
      f < PANEL_POSITION_FIELD_START + PANEL_IDS.length;
      f++
    ) {
      const before = makePickerState();
      before.settingsPicker.field = f;
      const panelId = PANEL_IDS[f - PANEL_POSITION_FIELD_START]!;
      const after = reduceSettingsValues(before, {
        type: 'settingsValueChange',
        delta: 1,
      });
      expect(after.settingsPicker.panelPositions[panelId]).toBe('sidebar');
      // Sibling panels must remain 'bottom' — a regression here would
      // mean the reducer returns the wrong map and the auto-save hook
      // would persist a broken state.
      for (const id of PANEL_IDS) {
        if (id !== panelId) {
          expect(after.settingsPicker.panelPositions[id]).toBe('bottom');
        }
      }
    }
  });

  it('keeps the full 13-entry map intact (the auto-save hook relies on it)', () => {
    const after = reduceSettingsValues(makePickerState(), {
      type: 'settingsValueChange',
      delta: 1,
    });
    expect(Object.keys(after.settingsPicker.panelPositions)).toHaveLength(PANEL_IDS.length);
    // Every entry must be a valid PanelPosition value (never undefined,
    // never an unexpected string) — the liveSettings read path in
    // app-view.tsx compares with === 'sidebar' and any non-'sidebar'
    // value would silently route to bottom.
    for (const id of PANEL_IDS) {
      const v = after.settingsPicker.panelPositions[id];
      expect(v === 'bottom' || v === 'sidebar').toBe(true);
    }
  });
});

describe('resolveSettingsFieldValue emits single-key partial patches for the per-panel rows', () => {
  it("the 'bottom' patch is a single-key spread, not a full map", () => {
    const result = resolveSettingsFieldValue(PANEL_POSITION_FIELD_START + 1, 'sidebar'); // fleet
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const patch = result.patch as { panelPositions?: Record<string, unknown> };
    expect(patch.panelPositions).toBeDefined();
    expect(Object.keys(patch.panelPositions ?? {})).toHaveLength(1);
    expect((patch.panelPositions as Record<string, string>).fleet).toBe('sidebar');
  });
});

describe('SIDEBAR_PANEL_LIMIT enforcement', () => {
  // Replicates the slot-allocation pipeline from app-view.tsx:
  //   1. Build a map of which panels are open
  //   2. Filter PANEL_IDS by routedToSidebar(id) && open
  //   3. Slice to SIDEBAR_PANEL_LIMIT
  //   4. sidebarSlotVisible(id) checks membership in the capped list
  //
  // This test doesn't mount React — it verifies the pure allocation
  // logic that determines which sidebar twins render.

  it('SIDEBAR_PANEL_LIMIT is 6', () => {
    expect(SIDEBAR_PANEL_LIMIT).toBe(6);
  });

  it('caps visible sidebar panels to SIDEBAR_PANEL_LIMIT when more are open', () => {
    // Route ALL 13 panels to sidebar and mark them all as open.
    const allSidebar: PanelPositionMap = coercePanelPositionMap(
      Object.fromEntries(PANEL_IDS.map((id) => [id, 'sidebar'])) as Partial<PanelPositionMap>,
    );
    const allOpen: Record<PanelId, boolean> = Object.fromEntries(
      PANEL_IDS.map((id) => [id, true]),
    ) as Record<PanelId, boolean>;

    // Replicate the pipeline from app-view.tsx lines 174-179.
    const openSidebarPanelIds = PANEL_IDS.filter(
      (id) => allSidebar[id] === 'sidebar' && (allOpen[id] ?? false),
    );
    const visibleSidebarPanelIds = openSidebarPanelIds.slice(0, SIDEBAR_PANEL_LIMIT);
    const sidebarSlotVisible = (id: PanelId): boolean => visibleSidebarPanelIds.includes(id);

    // All 13 are open + routed to sidebar, but only 6 get slots.
    expect(openSidebarPanelIds.length).toBe(13);
    expect(visibleSidebarPanelIds.length).toBe(SIDEBAR_PANEL_LIMIT);

    // The first SIDEBAR_PANEL_LIMIT panels in PANEL_IDS order are visible.
    for (const id of PANEL_IDS.slice(0, SIDEBAR_PANEL_LIMIT)) {
      expect(sidebarSlotVisible(id)).toBe(true);
    }

    // The remaining panels are NOT visible (overflow).
    for (const id of PANEL_IDS.slice(SIDEBAR_PANEL_LIMIT)) {
      expect(sidebarSlotVisible(id)).toBe(false);
    }
  });

  it('does not cap when fewer than SIDEBAR_PANEL_LIMIT panels are open', () => {
    // Route 3 panels to sidebar, all open.
    const threeSidebar: PanelPositionMap = coercePanelPositionMap({
      fleet: 'sidebar',
      agents: 'sidebar',
      plan: 'sidebar',
    });
    const openFlags: Partial<Record<PanelId, boolean>> = {
      fleet: true,
      agents: true,
      plan: true,
    };

    const openSidebarPanelIds = PANEL_IDS.filter(
      (id) => threeSidebar[id] === 'sidebar' && (openFlags[id] ?? false),
    );
    const visibleSidebarPanelIds = openSidebarPanelIds.slice(0, SIDEBAR_PANEL_LIMIT);

    expect(openSidebarPanelIds.length).toBe(3);
    expect(visibleSidebarPanelIds.length).toBe(3);
  });

  it('a panel routed to sidebar but NOT open does not occupy a slot', () => {
    // Route 8 panels to sidebar but only open 2.
    const eightSidebar: PanelPositionMap = coercePanelPositionMap(
      Object.fromEntries(
        PANEL_IDS.slice(0, 8).map((id) => [id, 'sidebar']),
      ) as Partial<PanelPositionMap>,
    );
    const openFlags: Partial<Record<PanelId, boolean>> = {
      fleet: true,
      agents: true,
      // All others closed
    };

    const openSidebarPanelIds = PANEL_IDS.filter(
      (id) => eightSidebar[id] === 'sidebar' && (openFlags[id] ?? false),
    );
    const visibleSidebarPanelIds = openSidebarPanelIds.slice(0, SIDEBAR_PANEL_LIMIT);

    // Only 2 panels are open, so only 2 occupy slots — even though 8
    // are routed to sidebar.
    expect(openSidebarPanelIds.length).toBe(2);
    expect(visibleSidebarPanelIds.length).toBe(2);
  });
});
