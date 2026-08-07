/**
 * Regression pins for the duplicated PROMPT REFINER panel.
 *
 * The pre-refine grace countdown is the only modal that opens while the
 * composer buffer STILL holds the submitted text — `clearDraft()` runs after
 * refinement, not before the countdown. It was missing from the modal overlay
 * ladder, so a key pressed during the countdown reached the panel's own
 * `useInput` AND the composer: Enter resolved the countdown and re-submitted
 * the same prompt, starting a second refine flow. The second
 * `refineCountdownOpen` replaced the slot under the already-mounted panel,
 * whose interval had expired and whose resolved-flag was set, so nothing could
 * ever resolve it — the panel stayed on screen at "refining in 0s…", eating
 * bottom-region rows (and therefore history viewport rows) for the rest of the
 * session, while the surviving flow completed in a second panel.
 */

import { describe, expect, it, vi } from 'vitest';

import type { Action, State } from '../src/app-reducer.js';
import { reducer } from '../src/app-reducer.js';
import { routeModalOverlayKey } from '../src/overlay-key-router.js';
import { createTestState } from './helpers/create-test-state.js';

const KEY = {
  return: false,
  escape: false,
  ctrl: false,
  meta: false,
  shift: false,
  upArrow: false,
  downArrow: false,
  leftArrow: false,
  rightArrow: false,
  tab: false,
  backspace: false,
  delete: false,
  pageUp: false,
  pageDown: false,
} as unknown as Parameters<typeof routeModalOverlayKey>[2];

function countdown(original = 'fix the login bug') {
  return { original, seconds: 3, resolve: vi.fn() };
}

function route(state: State, input: string, key: Partial<typeof KEY>): boolean {
  return routeModalOverlayKey(
    {
      state,
      enhanceCancelled: { current: false },
      enhanceController: { current: null },
      dispatch: vi.fn(),
    },
    input,
    { ...KEY, ...key },
  );
}

describe('pre-refine countdown owns the keyboard', () => {
  it('consumes Enter so the composer cannot re-submit the same prompt', () => {
    const state = createTestState({
      buffer: 'fix the login bug',
      refineCountdown: countdown(),
    }) as State;
    expect(route(state, '\r', { return: true })).toBe(true);
  });

  it('consumes plain characters and Esc', () => {
    const state = createTestState({ refineCountdown: countdown() }) as State;
    expect(route(state, 'x', {})).toBe(true);
    expect(route(state, '', { escape: true })).toBe(true);
  });

  it('lets keys through once the countdown is gone', () => {
    const state = createTestState({ buffer: 'fix the login bug' }) as State;
    expect(route(state, '\r', { return: true })).toBe(false);
  });
});

describe('refineCountdown slot cannot wedge', () => {
  it('bumps the remount generation on every open', () => {
    const initial = createTestState() as State;
    const first = reducer(initial, {
      type: 'refineCountdownOpen',
      info: countdown('first'),
    } as Action);
    const second = reducer(first, {
      type: 'refineCountdownOpen',
      info: countdown('second'),
    } as Action);

    expect(first.refineCountdownGen).toBe(initial.refineCountdownGen + 1);
    expect(second.refineCountdownGen).toBe(first.refineCountdownGen + 1);
    expect(second.refineCountdown?.original).toBe('second');
  });

  it('ignores a superseded flow closing the live countdown', () => {
    const stale = countdown('stale');
    const live = countdown('live');
    const opened = reducer(
      reducer(createTestState() as State, { type: 'refineCountdownOpen', info: stale } as Action),
      { type: 'refineCountdownOpen', info: live } as Action,
    );

    const afterStaleClose = reducer(opened, {
      type: 'refineCountdownClose',
      info: stale,
    } as Action);
    expect(afterStaleClose.refineCountdown).toBe(live);

    const afterLiveClose = reducer(afterStaleClose, {
      type: 'refineCountdownClose',
      info: live,
    } as Action);
    expect(afterLiveClose.refineCountdown).toBeNull();
  });

  it('still closes unconditionally when no info is supplied', () => {
    const opened = reducer(
      createTestState() as State,
      {
        type: 'refineCountdownOpen',
        info: countdown(),
      } as Action,
    );
    expect(reducer(opened, { type: 'refineCountdownClose' } as Action).refineCountdown).toBeNull();
  });
});
