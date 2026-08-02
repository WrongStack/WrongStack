import { describe, expect, it } from 'vitest';
import { reducer } from '../src/app-reducer.js';
import { createTestState } from './helpers/create-test-state.js';

describe('Sidebar focus + scroll key routing', () => {
  /** Create a state with enough fleet entries to allow scrolling. */
  function createStateWithContent() {
    let s = createTestState();
    const fleet: Record<string, { id: string; name: string; status: string }> = {};
    fleet['leader'] = { id: 'leader', name: 'Leader Agent', status: 'running' };
    for (let i = 1; i <= 14; i++) {
      fleet[`sub-${i}`] = { id: `sub-${i}`, name: `agent-${i}`, status: 'running' };
    }
    return { ...s, fleet: fleet as never };
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
    for (let i = 0; i < 100; i++) {
      s = reducer(s, { type: 'sidebarScroll', delta: 1 });
    }
    // With no agents/sessions/todos, content is ~7 rows, viewport ~20 → maxScroll = 0
    expect(s.sidebarScrollOffset).toBe(0);
  });

  it('sidebarScroll allows scrolling when content exceeds viewport', () => {
    let s = createTestState();
    // Add 15 fleet entries to push content past the viewport estimate
    const fleet: Record<string, { id: string; name: string; status: string }> = {};
    fleet['leader'] = { id: 'leader', name: 'Leader Agent', status: 'running' };
    for (let i = 1; i <= 14; i++) {
      fleet[`sub-${i}`] = { id: `sub-${i}`, name: `agent-${i}`, status: 'running' };
    }
    s = { ...s, fleet: fleet as never };
    for (let i = 0; i < 100; i++) {
      s = reducer(s, { type: 'sidebarScroll', delta: 1 });
    }
    // 1 leader + 11 visible (capped) = 12 agents × 2 rows = 24
    // + context 3 + model 2 + fleet 2 = 31 total, minus 20 viewport = 11 max
    expect(s.sidebarScrollOffset).toBe(11);
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
});
