import { render } from 'ink-testing-library';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { stopNextStepsAutoSubmitOnKey } from '../src/app-key-handler.js';
import {
  Entry,
  findArmedNextStepsEntryId,
  NEXT_STEP_SWEEP_DURATION_MS,
  nextStepSweepGlyphCount,
  nextStepSweepParts,
} from '../src/components/history/entry.js';
import type { HistoryEntry } from '../src/components/history.js';

const ENTRY: HistoryEntry = {
  id: 42,
  kind: 'assistant',
  final: true,
  text: [
    'Done.',
    '',
    '<nextsteps>',
    '1. Add unit tests for the parser',
    '2. Run the full suite',
    '</nextsteps>',
  ].join('\n'),
};

afterEach(() => {
  vi.useRealTimers();
});

describe('next-step auto-submit text sweep', () => {
  it('maps the final 10,000ms proportionally across the whole label', () => {
    const deadline = 50_000;

    expect(nextStepSweepGlyphCount(20, deadline, deadline - 10_001)).toBe(0);
    expect(nextStepSweepGlyphCount(20, deadline, deadline - NEXT_STEP_SWEEP_DURATION_MS)).toBe(0);
    expect(nextStepSweepGlyphCount(20, deadline, deadline - 7_500)).toBe(5);
    expect(nextStepSweepGlyphCount(20, deadline, deadline - 5_000)).toBe(10);
    expect(nextStepSweepGlyphCount(20, deadline, deadline)).toBe(20);
  });

  it('animates the armed row even when the auto suggestion is not first', () => {
    vi.useFakeTimers();
    vi.setSystemTime(100_000);
    const deadline = Date.now() + 5_000;
    const view = render(
      <Entry
        entry={ENTRY}
        termWidth={100}
        autonomyMode="auto"
        nextStepsAutoSubmitLabel="Run the full suite"
        nextStepsAutoSubmitDeadlineMs={deadline}
      />,
    );

    const frame = view.lastFrame() ?? '';
    expect(frame).toContain('Add unit tests for the parser');
    expect(frame).toContain('Run the full suite');
    expect(nextStepSweepParts('Run the full suite', deadline, Date.now())).toEqual({
      lit: 'Run the f',
      cursor: 'u',
      pending: 'll suite',
    });

    view.unmount();
  });

  it('targets only the newest panel when an older turn repeats the same label', () => {
    expect(
      findArmedNextStepsEntryId(
        [
          { ...ENTRY, id: 7 },
          { ...ENTRY, id: 42 },
        ],
        'Run the full suite',
      ),
    ).toBe(42);
  });

  it('cancels the armed sweep and submit on the first user key', () => {
    const cancel = vi.fn();

    stopNextStepsAutoSubmitOnKey(cancel);

    expect(cancel).toHaveBeenCalledOnce();
  });
});
