import { describe, expect, it } from 'vitest';
import { reducer } from '../src/app-reducer.js';
import type { Settings } from '../src/app-state.js';
import { resolveAppSidebarLayout } from '../src/app-ui-state.js';
import {
  sidebarOffsetForCell,
  sidebarScrollbarThumb,
} from '../src/components/sidebar-scrollbar.js';
import { estimateSidebarMaxScroll } from '../src/reducers/workspace-panels.js';
import { hasPanelRoutedToSidebar } from '../src/ui-contracts.js';
import { createTestState } from './helpers/create-test-state.js';

describe('sidebar pin rule — a routed panel keeps the rail on', () => {
  it('hasPanelRoutedToSidebar detects per-panel routes and the legacy swarm mode', () => {
    expect(hasPanelRoutedToSidebar(undefined, false)).toBe(false);
    expect(hasPanelRoutedToSidebar({ fleet: 'bottom', todos: 'bottom' }, false)).toBe(false);
    expect(hasPanelRoutedToSidebar({ fleet: 'sidebar' }, false)).toBe(true);
    expect(hasPanelRoutedToSidebar({ todos: 'sidebar' }, false)).toBe(true);
    // Legacy tri-state swarm mode ('sidebar') also pins the rail.
    expect(hasPanelRoutedToSidebar(undefined, true)).toBe(true);
    expect(hasPanelRoutedToSidebar(undefined, false)).toBe(false);
  });

  it('field 61 refuses off while a panel routes to the sidebar, with an explanatory hint', () => {
    let s = reducer(createTestState(), {
      type: 'settingsValueSet',
      patch: { panelPositions: { fleet: 'sidebar' } },
    });
    s = reducer(s, { type: 'settingsFieldSet', field: 61 });
    s = reducer(s, { type: 'settingsValueChange' });
    expect(s.settingsPicker.showSidebar).toBe(true);
    expect(s.settingsPicker.hint).toContain('pinned');
  });

  it('field 61 still toggles freely when nothing is routed to the sidebar', () => {
    let s = reducer(createTestState(), { type: 'settingsFieldSet', field: 61 });
    s = reducer(s, { type: 'settingsValueChange' });
    expect(s.settingsPicker.showSidebar).toBe(false);
    expect(s.settingsPicker.hint).toBeUndefined();
  });

  it('settingsValueSet clamps a showSidebar:false patch while pinned, but never blocks turning it on', () => {
    let s = reducer(createTestState(), {
      type: 'settingsValueSet',
      patch: { panelPositions: { kanban: 'sidebar' } },
    });
    s = reducer(s, { type: 'settingsValueSet', patch: { showSidebar: false } });
    expect(s.settingsPicker.showSidebar).toBe(true);
    expect(s.settingsPicker.hint).toContain('pinned');

    s = reducer(s, { type: 'settingsValueSet', patch: { showSidebar: true } });
    expect(s.settingsPicker.showSidebar).toBe(true);
    expect(s.settingsPicker.hint).toBeUndefined();
  });

  it('resolveSidebarLayout keeps the rail visible even when a stale config says off while pinned', () => {
    const state = createTestState();
    // A hand-edited / older config: a panel routed to the sidebar AND the
    // master switch off. The render-side clamp must win.
    const pinnedOff = {
      panelPositions: { fleet: 'sidebar' },
      showSidebar: false,
    } as unknown as Settings;
    const layout = resolveAppSidebarLayout(state, 100, pinnedOff, false);
    expect(layout.sidebarWidth).toBeGreaterThan(0);

    // Without the pin, off is honored (rail collapses).
    const off = { showSidebar: false } as unknown as Settings;
    expect(resolveAppSidebarLayout(state, 100, off, false).sidebarWidth).toBe(0);
  });
});

describe('sidebar scrollbar math', () => {
  it('thumb covers the viewport when the content fits', () => {
    expect(sidebarScrollbarThumb(20, 0, 0)).toEqual({ size: 20, top: 0 });
  });

  it('thumb size and top stay inside the track across the whole scroll range', () => {
    const viewportRows = 30;
    const maxScroll = 90;
    for (let offset = 0; offset <= maxScroll; offset += 7) {
      const { size, top } = sidebarScrollbarThumb(viewportRows, maxScroll, offset);
      expect(size).toBeGreaterThanOrEqual(1);
      expect(size).toBeLessThanOrEqual(viewportRows);
      expect(top).toBeGreaterThanOrEqual(0);
      expect(top).toBeLessThanOrEqual(viewportRows - size);
    }
  });

  it('offsetForCell inverts the mapping monotonically and clamps to [0, maxScroll]', () => {
    const viewportRows = 24;
    const maxScroll = 48;
    expect(sidebarOffsetForCell(-3, viewportRows, maxScroll)).toBe(0);
    expect(sidebarOffsetForCell(viewportRows + 5, viewportRows, maxScroll)).toBe(maxScroll);
    let prev = -1;
    for (let cell = 0; cell < viewportRows; cell++) {
      const offset = sidebarOffsetForCell(cell, viewportRows, maxScroll);
      expect(offset).toBeGreaterThanOrEqual(prev);
      expect(offset).toBeLessThanOrEqual(maxScroll);
      prev = offset;
    }
    // No overflow → always 0.
    expect(sidebarOffsetForCell(4, 10, 0)).toBe(0);
  });
});

describe('estimateSidebarMaxScroll mirrors the reducer clamp', () => {
  it('equals the sidebarScroll clamp ceiling for identical inputs', () => {
    let s = createTestState();
    s = reducer(s, {
      type: 'settingsValueSet',
      patch: { panelPositions: { fleet: 'sidebar' } },
    });
    const fleet: Record<string, { id: string; name: string; status: string }> = {};
    for (let i = 0; i < 10; i++) {
      fleet[`a-${i}`] = { id: `a-${i}`, name: `agent-${i}`, status: 'running' };
    }
    s = { ...s, fleet: fleet as never };

    const viewport = 30;
    const twinRows = 20;
    const swarm = true;
    let scrolled = s;
    for (let i = 0; i < 200; i++) {
      scrolled = reducer(scrolled, {
        type: 'sidebarScroll',
        delta: 1,
        viewportHeight: viewport,
        sidebarTwinRowCount: twinRows,
        effectiveSwarmOnSidebar: swarm,
      });
    }
    expect(scrolled.sidebarScrollOffset).toBe(
      estimateSidebarMaxScroll(s, viewport - twinRows, swarm),
    );
  });
});
