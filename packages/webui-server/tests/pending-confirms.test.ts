import { describe, expect, it } from 'vitest';
import {
  isDestructivePendingConfirm,
  resolveAllPendingConfirms,
  resolveYoloEligiblePendingConfirms,
} from '../src/server/pending-confirms.js';

describe('pending-confirms', () => {
  describe('isDestructivePendingConfirm', () => {
    it('returns true when riskTier is destructive', () => {
      expect(isDestructivePendingConfirm({ resolve: () => {}, riskTier: 'destructive' })).toBe(
        true,
      );
    });

    it('returns true when decisionSource is yolo_destructive', () => {
      expect(
        isDestructivePendingConfirm({ resolve: () => {}, decisionSource: 'yolo_destructive' }),
      ).toBe(true);
    });

    it('returns true when both conditions are true', () => {
      expect(
        isDestructivePendingConfirm({
          resolve: () => {},
          riskTier: 'destructive',
          decisionSource: 'yolo_destructive',
        }),
      ).toBe(true);
    });

    it('returns false for standard riskTier', () => {
      expect(isDestructivePendingConfirm({ resolve: () => {}, riskTier: 'standard' })).toBe(false);
    });

    it('returns false for safe riskTier', () => {
      expect(isDestructivePendingConfirm({ resolve: () => {}, riskTier: 'safe' })).toBe(false);
    });

    it('returns false when riskTier is undefined', () => {
      expect(isDestructivePendingConfirm({ resolve: () => {} })).toBe(false);
    });
  });

  describe('resolveYoloEligiblePendingConfirms', () => {
    it('resolves all pending confirms with "yes"', () => {
      const resolves: string[] = [];
      const pending = new Map([
        ['id1', { resolve: (d: string) => resolves.push(d) }],
        ['id2', { resolve: (d: string) => resolves.push(d) }],
      ]);

      resolveYoloEligiblePendingConfirms(pending);

      expect(resolves).toEqual(['yes', 'yes']);
      expect(pending.size).toBe(0);
    });

    it('handles empty map', () => {
      const pending = new Map();
      expect(() => resolveYoloEligiblePendingConfirms(pending)).not.toThrow();
      expect(pending.size).toBe(0);
    });
  });

  describe('resolveAllPendingConfirms', () => {
    it('resolves all pending confirms with given decision', () => {
      const resolves: string[] = [];
      const pending = new Map([
        ['id1', { resolve: (d: string) => resolves.push(d) }],
        ['id2', { resolve: (d: string) => resolves.push(d) }],
      ]);

      resolveAllPendingConfirms(pending, 'deny');

      expect(resolves).toEqual(['deny', 'deny']);
      expect(pending.size).toBe(0);
    });

    it('handles empty map', () => {
      const pending = new Map();
      expect(() => resolveAllPendingConfirms(pending, 'always')).not.toThrow();
      expect(pending.size).toBe(0);
    });

    it('works with "always" decision', () => {
      const resolves: string[] = [];
      const pending = new Map([['id1', { resolve: (d: string) => resolves.push(d) }]]);

      resolveAllPendingConfirms(pending, 'always');

      expect(resolves).toEqual(['always']);
    });
  });

  describe('resolveYoloEligiblePendingConfirms — one tab at a time', () => {
    function twoTabsWaiting() {
      const answered: Array<{ id: string; decision: string }> = [];
      const map = new Map([
        [
          'tab1-call',
          {
            resolve: (d: string) => answered.push({ id: 'tab1-call', decision: d }),
            sessionId: 'tab-1',
          },
        ],
        [
          'tab2-call',
          {
            resolve: (d: string) => answered.push({ id: 'tab2-call', decision: d }),
            sessionId: 'tab-2',
          },
        ],
      ]) as never as Map<string, import('../src/server/pending-confirms.js').PendingConfirm>;
      return { map, answered };
    }

    it('answers only the prompts of the session that turned YOLO on', () => {
      const { map, answered } = twoTabsWaiting();

      resolveYoloEligiblePendingConfirms(map, 'tab-2');

      // The other tab's prompt is still on screen, still waiting for a human.
      expect(answered).toEqual([{ id: 'tab2-call', decision: 'yes' }]);
      expect(map.has('tab1-call')).toBe(true);
    });

    it('still sweeps everything for a host that names no session', () => {
      const { map, answered } = twoTabsWaiting();

      resolveYoloEligiblePendingConfirms(map);

      expect(answered).toHaveLength(2);
      expect(map.size).toBe(0);
    });

    it('answers an unowned prompt for whichever session asks', () => {
      const answered: string[] = [];
      const map = new Map([
        ['legacy', { resolve: (d: string) => answered.push(d) }],
      ]) as never as Map<string, import('../src/server/pending-confirms.js').PendingConfirm>;

      resolveYoloEligiblePendingConfirms(map, 'tab-1');

      // No recorded owner means a single-session host, where there is only one
      // conversation it could belong to.
      expect(answered).toEqual(['yes']);
    });
  });
});
