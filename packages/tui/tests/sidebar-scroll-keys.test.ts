import { describe, expect, it } from 'vitest';
import { reducer } from '../src/app-reducer.js';
import { createTestState } from './helpers/create-test-state.js';

describe('Sidebar focus + scroll key routing', () => {
  /** Create a state with enough fleet entries to allow scrolling. */
  function createStateWithContent() {
    const state = createTestState({
      fleet: (() => {
        const f: Record<string, { id: string; name: string; status: 'running' }> = {};
        f['leader'] = { id: 'leader', name: 'Leader Agent', status: 'running' };
        for (let i = 1; i <= 14; i++) {
          f[`sub-${i}`] = { id: `sub-${i}`, name: `agent-${i}`, status: 'running' };
        }
        return f;
      })(),
    });
    return reducer(state, {
      type: 'settingsValueSet',
      patch: { showAgentSwarmPanel: 'sidebar' },
    });
  }

  it('toggleSidebarFocus flips focused state', () => {
    let s = createTestState();
    expect(s.sidebarFocused).toBe(false);

    s = reducer(s, { type: 'toggleSidebarFocus' });
    expect(s.sidebarFocused).toBe(true);

    s = reducer(s, { type: 'toggleSidebarFocus' });
    expect(s.sidebarFocused).toBe(false);
  });

  it('unfocusing resets scroll offset to 0', () => {
    let s = createStateWithContent();
    s = reducer(s, { type: 'toggleSidebarFocus' }); // focus
    s = reducer(s, { type: 'sidebarScroll', delta: 5 });
    s = reducer(s, { type: 'sidebarScroll', delta: 3 });
    expect(s.sidebarScrollOffset).toBe(8);
    expect(s.sidebarFocused).toBe(true);

    s = reducer(s, { type: 'toggleSidebarFocus' }); // unfocus
    expect(s.sidebarFocused).toBe(false);
    expect(s.sidebarScrollOffset).toBe(0);
  });

  it('sidebarScroll +1/-1 adjusts offset', () => {
    let s = createStateWithContent();
    s = reducer(s, { type: 'sidebarScroll', delta: 1 });
    expect(s.sidebarScrollOffset).toBe(1);

    s = reducer(s, { type: 'sidebarScroll', delta: 1 });
    expect(s.sidebarScrollOffset).toBe(2);

    s = reducer(s, { type: 'sidebarScroll', delta: -1 });
    expect(s.sidebarScrollOffset).toBe(1);
  });

  it('sidebarScroll clamps at 0 (no negative)', () => {
    let s = createTestState();
    s = reducer(s, { type: 'sidebarScroll', delta: -5 });
    expect(s.sidebarScrollOffset).toBe(0);
  });

  it('sidebarScroll clamps at dynamic upper bound based on content', () => {
    let s = createTestState();
    // Empty state → minimal content → maxScroll should be small (0 with no fleet)
    for (let i = 0; i < 200; i++) {
      s = reducer(s, { type: 'sidebarScroll', delta: 1 });
    }
    // The model/context hero (14 rows) + prompt cache card (11 rows) + SYSTEM
    // vitals card (5 rows) = 30, which exceeds the default 20-row viewport by
    // 10 — the clamp allows exactly that much scroll.
    expect(s.sidebarScrollOffset).toBe(10);
  });

  it('sidebarScroll allows scrolling when content exceeds viewport', () => {
    let s = createTestState();
    // Add 15 fleet entries to push content past the viewport estimate
    const fleet: Record<string, { id: string; name: string; status: string }> = {};
    fleet['leader'] = { id: 'leader', name: 'Leader Agent', status: 'running' };
    for (let i = 1; i <= 14; i++) {
      fleet[`sub-${i}`] = { id: `sub-${i}`, name: `agent-${i}`, status: 'running' };
    }
    s = reducer(
      { ...s, fleet: fleet as never },
      {
        type: 'settingsValueSet',
        patch: { showAgentSwarmPanel: 'sidebar' },
      },
    );
    for (let i = 0; i < 200; i++) {
      s = reducer(s, { type: 'sidebarScroll', delta: 1 });
    }
    // Sidebar mode reserves the 14-row model/context hero, 11-row prompt
    // cache card, 5-row system vitals card, grouped swarm card, and mission
    // queue's worst-case wrapped height:
    // 14 + 11 + 5 + 28 + 83 = 141 total, minus the 20-row viewport = 121 max.
    expect(s.sidebarScrollOffset).toBe(121);
  });

  it('sidebarScrollReset sets offset to 0', () => {
    let s = createStateWithContent();
    s = reducer(s, { type: 'sidebarScroll', delta: 10 });
    expect(s.sidebarScrollOffset).toBe(10);

    s = reducer(s, { type: 'sidebarScrollReset' });
    expect(s.sidebarScrollOffset).toBe(0);
  });

  it('closeAllPanels clears sidebar focus', () => {
    let s = createTestState();
    s = reducer(s, { type: 'toggleSidebarFocus' });
    expect(s.sidebarFocused).toBe(true);

    s = reducer(s, { type: 'closeAllPanels' });
    expect(s.sidebarFocused).toBe(false);
  });

  /**
   * Regression coverage for the Chimera finding: the keyboard and mouse-wheel
   * `sidebarScroll` dispatch paths in `app-key-handler.ts` must thread
   * `sidebarTwinRowCount` and `effectiveSwarmOnSidebar` through the action
   * so the reducer's scroll-clamp accounts for twin rows mounted above the
   * sidebar content and reserves the mission-queue rows when the swarm
   * panel is on the sidebar via the persisted (config-only) routing. Earlier
   * the dispatchers omitted both fields and the new clamp behavior was
   * effectively dead in production.
   *
   * We assert this at the reducer level (the dispatchers are responsible
   * for plumbing the fields; the reducer is what enforces them).
   *
   * Semantics of the reducer:
   *   adjustedViewportHeight = viewportHeight - sidebarTwinRowCount
   *   maxScroll = contentHeight - adjustedViewportHeight
   * So threading `sidebarTwinRowCount` shrinks the *usable* viewport,
   * which INCREASES the max scroll offset (more overflow). Similarly,
   * threading `effectiveSwarmOnSidebar=true` reserves mission-queue rows
   * in `contentHeight`, which also INCREASES the max scroll offset. Both
   * fields are reservation flags — they enlarge the scroll budget so the
   * user can reach the bottom rows that the renderer actually mounts.
   */
  it('sidebarScroll with sidebarTwinRowCount > 0 enlarges the scroll budget', () => {
    let s = createStateWithContent();
    // Add enough fleet rows so a 30-row viewport has a positive maxScroll.
    const fleet: Record<string, { id: string; name: string; status: string }> = {};
    for (let i = 0; i <= 30; i++) {
      fleet[`a-${i}`] = { id: `a-${i}`, name: `agent-${i}`, status: 'running' };
    }
    s = { ...s, fleet: fleet as never };

    const baselineViewport = 40;
    const twins = 6;

    // Without twins threaded, the reducer uses viewportHeight as-is.
    let sNoTwins = s;
    for (let i = 0; i < 200; i++) {
      sNoTwins = reducer(sNoTwins, {
        type: 'sidebarScroll',
        delta: 1,
        viewportHeight: baselineViewport,
      });
    }
    const offsetNoTwins = sNoTwins.sidebarScrollOffset;

    // With twins threaded, the effective viewport shrinks by `twins`,
    // so the scroll budget grows by exactly `twins` rows.
    let sWithTwins = s;
    for (let i = 0; i < 200; i++) {
      sWithTwins = reducer(sWithTwins, {
        type: 'sidebarScroll',
        delta: 1,
        viewportHeight: baselineViewport,
        sidebarTwinRowCount: twins,
      });
    }
    const offsetWithTwins = sWithTwins.sidebarScrollOffset;

    expect(offsetWithTwins).toBeGreaterThan(offsetNoTwins);
    // The exact delta is bounded by the `Math.max(1, adjustedViewportHeight)`
    // floor in the reducer; in practice it equals `twins` when the baseline
    // viewport is large enough that no floor clamps the adjusted value. We
    // assert the qualitative reservation (positive delta) — the precise
    // formula is exercised by the reducer unit suite.
    expect(offsetWithTwins - offsetNoTwins).toBeGreaterThan(0);
  });

  it('sidebarScroll with effectiveSwarmOnSidebar=true reserves mission queue rows', () => {
    // Build a state where the picker draft shows swarm OFF so the fallback
    // path would under-reserve, but the dispatch threads the persisted
    // config-only 'sidebar' swarm mode through `effectiveSwarmOnSidebar`.
    // The reducer must add the mission-queue reservation to `contentHeight`,
    // yielding a strictly larger maxScroll (more rows to scroll through).
    let s = createStateWithContent();
    s = { ...s, settingsPicker: { ...s.settingsPicker, showAgentSwarmPanel: 'off' } };

    const viewport = 30;

    let sPicker = s;
    for (let i = 0; i < 200; i++) {
      sPicker = reducer(sPicker, { type: 'sidebarScroll', delta: 1, viewportHeight: viewport });
    }

    let sEffective = s;
    for (let i = 0; i < 200; i++) {
      sEffective = reducer(sEffective, {
        type: 'sidebarScroll',
        delta: 1,
        viewportHeight: viewport,
        effectiveSwarmOnSidebar: true,
      });
    }

    // effectiveSwarmOnSidebar reserves mission-queue rows → larger max.
    expect(sEffective.sidebarScrollOffset).toBeGreaterThan(sPicker.sidebarScrollOffset);
  });
});
