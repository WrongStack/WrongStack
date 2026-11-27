// Pins the centralized keyboard-ownership gate extracted from app-view.tsx.
// isBlockingPromptOpen must stay behavior-identical to the inline boolean it
// replaced: any one foreground prompt suspends normal composer input.
import { describe, expect, it } from 'vitest';
import type { State } from '../src/app-state.js';
import { isBlockingPromptOpen } from '../src/app-ui-state.js';
import { initial } from './reducer.test.js';

describe('isBlockingPromptOpen', () => {
  it('is false for a clean idle state', () => {
    expect(isBlockingPromptOpen(initial())).toBe(false);
  });

  // Each foreground surface, one at a time, must flip the gate on.
  const cases: Array<[string, Partial<State>]> = [
    ['confirmQueue', { confirmQueue: [{} as never] }],
    ['shellCommandWarning', { shellCommandWarning: {} as never }],
    ['brainPrompt', { brainPrompt: {} as never }],
    ['clearConfirm', { clearConfirm: {} as never }],
    ['exitConfirm', { exitConfirm: {} as never }],
    ['slashConfirm', { slashConfirm: {} as never }],
    ['escConfirm', { escConfirm: {} as never }],
    ['enhance', { enhance: {} as never }],
    ['enhanceBusy', { enhanceBusy: true }],
    ['topicCheckBusy', { topicCheckBusy: true }],
    ['refineFailure', { refineFailure: {} as never }],
    ['continueConfirm', { continueConfirm: {} as never }],
    ['bugHuntContinue', { bugHuntContinue: {} as never }],
    ['sendModePicker', { sendModePicker: {} as never }],
    ['rewindOverlay', { rewindOverlay: {} as never }],
    ['fallbackOverlay', { fallbackOverlay: {} as never }],
    ['inspectOverlay', { inspectOverlay: {} as never }],
    ['helpOpen', { helpOpen: true }],
  ];
  for (const [name, over] of cases) {
    it(`is true when ${name} is active`, () => {
      expect(isBlockingPromptOpen(initial(over))).toBe(true);
    });
  }

  it('is true while aborting without a pending steer', () => {
    expect(isBlockingPromptOpen(initial({ status: 'aborting', steeringPending: false }))).toBe(
      true,
    );
  });

  it('is false while aborting with a pending steer (composer stays live)', () => {
    expect(isBlockingPromptOpen(initial({ status: 'aborting', steeringPending: true }))).toBe(
      false,
    );
  });

  it('is false while merely running or streaming', () => {
    expect(isBlockingPromptOpen(initial({ status: 'running' }))).toBe(false);
    expect(isBlockingPromptOpen(initial({ status: 'streaming' }))).toBe(false);
  });
});
