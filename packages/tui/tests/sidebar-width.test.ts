import { describe, expect, it } from 'vitest';
import {
  computeSidebarWidth,
  SIDEBAR_MIN_TERMINAL,
  SIDEBAR_MIN_WIDTH,
  SIDEBAR_MAX_WIDTH,
  SIDEBAR_FRACTION,
} from '../src/components/sidebar.js';

describe('computeSidebarWidth', () => {
  describe('threshold (hidden on narrow terminals)', () => {
    it('returns 0 below SIDEBAR_MIN_TERMINAL', () => {
      expect(computeSidebarWidth(0)).toBe(0);
      expect(computeSidebarWidth(32)).toBe(0);
      expect(computeSidebarWidth(63)).toBe(0);
    });

    it('returns a non-zero width at exactly SIDEBAR_MIN_TERMINAL', () => {
      const w = computeSidebarWidth(SIDEBAR_MIN_TERMINAL);
      expect(w).toBeGreaterThan(0);
      // 25% of 64 = 16, clamped to min 20
      expect(w).toBe(SIDEBAR_MIN_WIDTH);
    });
  });

  describe('clamping', () => {
    it('clamps to SIDEBAR_MIN_WIDTH for small-but-visible terminals', () => {
      // 64 * 0.25 = 16 → clamped up to 20
      expect(computeSidebarWidth(SIDEBAR_MIN_TERMINAL)).toBe(SIDEBAR_MIN_WIDTH);
      // 80 * 0.25 = 20 → exactly at min
      expect(computeSidebarWidth(80)).toBe(SIDEBAR_MIN_WIDTH);
    });

    it('produces proportional widths in the mid-range', () => {
      // 100 * 0.25 = 25
      expect(computeSidebarWidth(100)).toBe(25);
      // 120 * 0.25 = 30
      expect(computeSidebarWidth(120)).toBe(30);
      // 160 * 0.25 = 40
      expect(computeSidebarWidth(160)).toBe(40);
    });

    it('clamps to SIDEBAR_MAX_WIDTH for very wide terminals', () => {
      // 200 * 0.25 = 50 → clamped to 48
      expect(computeSidebarWidth(200)).toBe(SIDEBAR_MAX_WIDTH);
      // 500 * 0.25 = 125 → clamped to 48
      expect(computeSidebarWidth(500)).toBe(SIDEBAR_MAX_WIDTH);
      // 1000 * 0.25 = 250 → clamped to 48
      expect(computeSidebarWidth(1000)).toBe(SIDEBAR_MAX_WIDTH);
    });

    it('hits exactly SIDEBAR_MAX_WIDTH at the boundary', () => {
      // 192 * 0.25 = 48
      expect(computeSidebarWidth(192)).toBe(SIDEBAR_MAX_WIDTH);
    });
  });

  describe('common terminal widths', () => {
    it('returns expected values for standard sizes', () => {
      // 80-col terminal (common default)
      expect(computeSidebarWidth(80)).toBe(20);
      // 120-col terminal
      expect(computeSidebarWidth(120)).toBe(30);
      // 160-col terminal
      expect(computeSidebarWidth(160)).toBe(40);
    });

    it('leaves enough room for the main column', () => {
      for (const cols of [80, 100, 120, 160, 200]) {
        const sidebar = computeSidebarWidth(cols);
        const main = cols - sidebar;
        // Main column should always be at least 50% of the terminal
        expect(main).toBeGreaterThanOrEqual(Math.floor(cols / 2));
        // Main column should always be wider than the sidebar
        expect(main).toBeGreaterThan(sidebar);
      }
    });
  });

  describe('constants', () => {
    it('exports consistent constants', () => {
      expect(SIDEBAR_MIN_TERMINAL).toBe(64);
      expect(SIDEBAR_MIN_WIDTH).toBe(20);
      expect(SIDEBAR_MAX_WIDTH).toBe(48);
      expect(SIDEBAR_FRACTION).toBe(0.25);
      expect(SIDEBAR_MIN_WIDTH).toBeLessThan(SIDEBAR_MAX_WIDTH);
    });
  });

  describe('monotonicity', () => {
    it('never decreases as terminal width grows (past threshold)', () => {
      let prev = computeSidebarWidth(SIDEBAR_MIN_TERMINAL);
      for (let cols = SIDEBAR_MIN_TERMINAL + 1; cols <= 300; cols++) {
        const w = computeSidebarWidth(cols);
        expect(w).toBeGreaterThanOrEqual(prev);
        prev = w;
      }
    });
  });
});
