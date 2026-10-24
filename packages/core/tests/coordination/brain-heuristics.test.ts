import { describe, expect, it } from 'vitest';
import {
  compileResolutionMarkers,
  isContinuePing,
  isDeadlockWithFailedWork,
  isRetryExhausted,
  resolveBrainHeuristics,
} from '../../src/brain/brain-heuristics.js';

describe('brain-heuristics predicates', () => {
  describe('isDeadlockWithFailedWork', () => {
    it('returns true when deadlock is in question and failed tasks in context', () => {
      expect(isDeadlockWithFailedWork('deadlock detected', 'failed tasks blocking step 3')).toBe(
        true,
      );
      expect(isDeadlockWithFailedWork('pipeline deadlock', 'failed step in phase 1')).toBe(true);
    });

    it('returns false when deadlock is not mentioned in question', () => {
      expect(isDeadlockWithFailedWork('pipeline blocked', 'failed tasks in step 3')).toBe(false);
    });

    it('returns false when no failed work units are in context', () => {
      expect(isDeadlockWithFailedWork('deadlock detected', 'system waiting on resource lock')).toBe(
        false,
      );
    });
  });

  describe('isRetryExhausted', () => {
    it('returns true for failed/retry question with exhausted context', () => {
      expect(isRetryExhausted('tool failed', 'retries exhausted')).toBe(true);
      expect(isRetryExhausted('retry tool?', 'attempted 4 consecutive times')).toBe(true);
      expect(isRetryExhausted('execution failed', 'failure 5')).toBe(true);
    });

    it('returns false when question does not mention failed or retry', () => {
      expect(isRetryExhausted('should we abort?', 'retries exhausted')).toBe(false);
    });

    it('returns false when context lacks exhaustion indicators', () => {
      expect(isRetryExhausted('tool failed', 'first attempt failed transiently')).toBe(false);
    });
  });

  describe('isContinuePing', () => {
    it('returns true for bare continue or proceed', () => {
      expect(isContinuePing('continue')).toBe(true);
      expect(isContinuePing('proceed')).toBe(true);
      expect(isContinuePing('continue with remaining work')).toBe(true);
    });

    it('returns false when stop/abort words or competing alternatives are present', () => {
      expect(isContinuePing('continue or stop?')).toBe(false);
      expect(isContinuePing('proceed or abort')).toBe(false);
      expect(isContinuePing('stop now')).toBe(false);
    });
  });

  describe('compileResolutionMarkers & resolveBrainHeuristics', () => {
    it('compiles custom resolution markers safely', () => {
      const custom = compileResolutionMarkers(['passed', 'landed']);
      expect(custom.test('it passed')).toBe(true);
      expect(custom.test('it failed')).toBe(false);
    });

    it('resolves default heuristics with all flags true', () => {
      const h = resolveBrainHeuristics(undefined);
      expect(h.lowRiskAutoAnswer).toBe(true);
      expect(h.blockedResolved).toBe(true);
      expect(h.deadlockSkip).toBe(true);
      expect(h.retryExhausted).toBe(true);
      expect(h.continuePing).toBe(true);
    });
  });
});
