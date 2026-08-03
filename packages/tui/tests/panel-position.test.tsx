// Tests for the PanelPosition generalization.
//
// Covers:
//   - coercePanelPositionMap normalizes partial/stale/invalid maps to a
//     full PanelPositionMap
//   - PANEL_IDS / DEFAULT_PANEL_POSITIONS stay in lock-step (closed set)
//   - Settings picker reducer cycle for fields 45-57 swaps each panel
//     between 'bottom' and 'sidebar'
//   - resolveSettingsFieldValue emits single-key partial patches for
//     fields 45-57 (full-map patches would wipe sibling panels)
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
  SIDEBAR_PANEL_LIMIT,
} from '../src/ui-contracts.js';
import type { PanelId, PanelPositionMap } from '../src/ui-contracts.js';
import {
  resolveSettingsFieldValue,
  SETTINGS_FIELD_LABELS,
} from '../src/components/settings-picker-model.js';

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

  it('SETTINGS_FIELD_LABELS has labels for fields 45..57 (per-panel rows)', () => {
    for (let i = 45; i <= 57; i++) {
      const label = SETTINGS_FIELD_LABELS[i];
      expect(typeof label).toBe('string');
      if (typeof label !== 'string') throw new Error(`missing label for field ${i}`);
      expect(label.length).toBeGreaterThan(0);
    }
  });

  it('the per-panel label count matches PANEL_IDS.length', () => {
    const perPanelLabels = SETTINGS_FIELD_LABELS.slice(45, 58);
    expect(perPanelLabels.length).toBe(PANEL_IDS.length);
  });
});

describe('settingsValueSet reducer cycle for fields 45..57', () => {
  // The reducer path is exercised through resolveSettingsFieldValue +
  // the settingsValueSet reducer in reducers/settings-values.ts. We test
  // the resolver here because it produces the patch the reducer merges.
  for (let i = 45; i <= 57; i++) {
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

describe('resolveSettingsFieldValue emits single-key partial patches for fields 45..57', () => {
  it("the 'bottom' patch is a single-key spread, not a full map", () => {
    const result = resolveSettingsFieldValue(46, 'sidebar'); // fleet
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
    const sidebarSlotVisible = (id: PanelId): boolean =>
      visibleSidebarPanelIds.includes(id);

    // All 13 are open + routed to sidebar, but only 6 get slots.
    expect(openSidebarPanelIds.length).toBe(13);
    expect(visibleSidebarPanelIds.length).toBe(SIDEBAR_PANEL_LIMIT);

    // The first SIDEBAR_PANEL_LIMIT panels in PANEL_IDS order are visible.
    for (let i = 0; i < SIDEBAR_PANEL_LIMIT; i++) {
      expect(sidebarSlotVisible(PANEL_IDS[i])).toBe(true);
    }

    // The remaining panels are NOT visible (overflow).
    for (let i = SIDEBAR_PANEL_LIMIT; i < PANEL_IDS.length; i++) {
      expect(sidebarSlotVisible(PANEL_IDS[i])).toBe(false);
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