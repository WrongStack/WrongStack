import { describe, expect, it } from 'vitest';
import {
  CAPTURE_SESSION_WINDOW_MS,
  captureWindowState,
  recordCaptureAttempt,
  resetCaptureWindows,
} from '../src/project-agent-capture-window.js';

describe('captureWindowState non-finite now guard', () => {
  it('does not poison windowStartedAt when now is non-finite', () => {
    resetCaptureWindows();
    try {
      recordCaptureAttempt('role-a', Number.NaN);
      const state = captureWindowState('role-a', Date.now() + CAPTURE_SESSION_WINDOW_MS * 2);
      expect(state.count).toBe(0);
      expect(state.lastCaptureAt === undefined || Number.isFinite(state.lastCaptureAt)).toBe(true);
    } finally {
      resetCaptureWindows();
    }
  });
});
