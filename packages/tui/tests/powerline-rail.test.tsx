import { render } from 'ink-testing-library';
import React from 'react';
import { describe, expect, it } from 'vitest';
import { PowerlineRail, visibleNodeText } from '../src/components/powerline-rail.js';
import { BrainChip, EternalStageChip } from '../src/components/status-bar-chips.js';
import { Text } from '../src/ink.js';
import { displayWidth, stripAnsi } from '../src/terminal-width.js';

function segment(text: string): React.ReactElement {
  return React.createElement(Text, null, text);
}

describe('PowerlineRail', () => {
  it('renders chips separated by single space, no transitions or caps', () => {
    const view = render(
      React.createElement(PowerlineRail, {
        budget: 80,
        segments: [segment('● READY'), segment('Opus 4.8'), segment('ctx 57%')],
      }),
    );
    expect(stripAnsi(view.lastFrame() ?? '')).toBe('● READY  Opus 4.8  ctx 57%');
    view.unmount();
  });

  it('keeps monochrome rails readable without background colors', () => {
    const view = render(
      React.createElement(PowerlineRail, {
        budget: 80,
        monochrome: true,
        segments: [segment('READY'), segment('main')],
      }),
    );
    expect(stripAnsi(view.lastFrame() ?? '')).toBe('READY  main');
    view.unmount();
  });

  it('reports dropped low-priority segments instead of wrapping', () => {
    const view = render(
      React.createElement(PowerlineRail, {
        budget: 20,
        segments: [segment('READY'), segment('MODEL'), segment('CONTEXT'), segment('COST')],
      }),
    );
    const frame = stripAnsi(view.lastFrame() ?? '');
    expect(frame).toContain('+2');
    expect(displayWidth(frame)).toBeLessThanOrEqual(20);
    view.unmount();
  });

  it('exact-fit monochrome rail reserves omission marker width', () => {
    const view = render(
      React.createElement(PowerlineRail, {
        budget: 15,
        monochrome: true,
        segments: [segment('READY'), segment('MODEL'), segment('CONTEXT')],
      }),
    );
    const frame = stripAnsi(view.lastFrame() ?? '');
    expect(frame).toContain('+1');
    expect(displayWidth(frame)).toBeLessThanOrEqual(15);
    view.unmount();
  });

  // The bug these pin: `visibleNodeText` measured a function-component
  // segment with neither `children` nor `text` (BrainChip,
  // EternalStageChip) as 0 columns, so a brain-arbiter decision on an
  // 80-column terminal overflowed row 3 by the chip's full rendered width
  // — the row wrapped, the measured bottom region grew, and the history
  // viewport cropped its top line one commit later.
  it('measures hook-free function-component chips at their rendered width', () => {
    const brain = React.createElement(BrainChip, {
      brain: { state: 'deciding', source: 'arbiter', summary: 'weighing the release decision' },
    });
    const measured = visibleNodeText(brain);
    expect(measured.length, 'BrainChip measured as empty').toBeGreaterThan(0);
    expect(measured).toContain('deciding');
    const eternal = React.createElement(EternalStageChip, {
      stage: { phase: 'idle' } as never,
    });
    expect(visibleNodeText(eternal)).toContain('idle');
  });

  it('keeps a rail with a BrainChip inside its budget', () => {
    const budget = 40;
    const view = render(
      React.createElement(PowerlineRail, {
        budget,
        segments: [
          segment('● READY'),
          React.createElement(BrainChip, {
            brain: {
              state: 'deciding',
              source: 'arbiter',
              summary: 'weighing a very long release decision summary',
            },
          }),
          segment('ctx 57%'),
        ],
      }),
    );
    for (const line of stripAnsi(view.lastFrame() ?? '').split('\n')) {
      expect(displayWidth(line)).toBeLessThanOrEqual(budget);
    }
    view.unmount();
  });
});
