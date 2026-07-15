import { describe, expect, it } from 'vitest';
import { render } from 'ink-testing-library';
import React from 'react';
import { PowerlineRail } from '../src/components/powerline-rail.js';
import { Text } from '../src/ink.js';
import { stripAnsi } from '../src/terminal-width.js';

function segment(text: string): React.ReactElement {
  return React.createElement(Text, null, text);
}

describe('PowerlineRail', () => {
  it('renders capped, connected segments in color mode', () => {
    const view = render(
      React.createElement(PowerlineRail, {
        budget: 80,
        segments: [segment('● READY'), segment('Opus 4.8'), segment('ctx 57%')],
      }),
    );
    expect(stripAnsi(view.lastFrame() ?? '')).toBe('◖ ● READY  ▶  Opus 4.8  ▶  ctx 57% ◗');
    view.unmount();
  });

  it('keeps monochrome rails readable without relying on background color', () => {
    const view = render(
      React.createElement(PowerlineRail, {
        budget: 80,
        monochrome: true,
        segments: [segment('READY'), segment('main')],
      }),
    );
    expect(stripAnsi(view.lastFrame() ?? '')).toBe('◖ READY  ›  main ◗');
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
    expect(frame).not.toContain('CONTEXT');
    view.unmount();
  });
});
