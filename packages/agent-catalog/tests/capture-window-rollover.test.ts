import { afterEach, expect, it } from 'vitest';
import {
  CAPTURE_SESSION_WINDOW_MS,
  captureWindowState,
  recordCaptureAttempt,
  resetCaptureWindows,
} from '../src/project-agent-capture-window.js';

afterEach(resetCaptureWindows);

it.each([
  ['before rollover', CAPTURE_SESSION_WINDOW_MS - 1, 2],
  ['at rollover', CAPTURE_SESSION_WINDOW_MS, 1],
] as const)('retains the most recently used capture window %s', (_label, now, count) => {
  // Fill the 1,000-entry cache, initially making target the oldest key.
  recordCaptureAttempt('target', 0);
  for (let i = 1; i < 1_000; i++) recordCaptureAttempt(`other-${i}`, 1);

  recordCaptureAttempt('target', now);
  recordCaptureAttempt('new-key', now);

  expect(captureWindowState('target', now)).toMatchObject({ count, lastCaptureAt: now });
  expect(captureWindowState('other-1', now)).toMatchObject({
    count: 0,
    lastCaptureAt: undefined,
  });
});
