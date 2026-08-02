import { describe, expect, it } from 'vitest';
import { reducer } from '../src/app-reducer.js';
import { createTestState } from './helpers/create-test-state.js';

describe('Sidebar focus + scroll key routing', () => {
  it('toggleSidebarFocus flips focused state', () => {
    let s = createTestState();
    expect(s.sidebarFocused).toBe(false);

    s = reducer(s, { type: 'toggleSidebarFocus' });
    expect(s.sidebarFocused).toBe(true);

    s = reducer(s, { type: 'toggleSidebarFocus' });
    expect(s.sidebarFocused).toBe(false);
  });

  it('unfocusing resets scroll offset to 0', () => {
    let s = createTestState();
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
    let s = createTestState();
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

  it('sidebarScroll clamps at 50 (upper bound)', () => {
    let s = createTestState();
    for (let i = 0; i < 60; i++) {
      s = reducer(s, { type: 'sidebarScroll', delta: 1 });
    }
    expect(s.sidebarScrollOffset).toBe(50);
  });

  it('sidebarScrollReset sets offset to 0', () => {
    let s = createTestState();
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
