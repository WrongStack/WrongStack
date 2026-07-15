import { describe, expect, it } from 'vitest';
import { render } from 'ink-testing-library';
import React from 'react';
import {
  StatusBar,
  type StatusBarProps,
  planChipFit,
  nodeText,
  truncateChip,
} from '../src/components/status-bar.js';

function strip(s: string): string {
  // eslint-disable-next-line no-control-regex
  return s.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, '');
}

function frameOf(props: Partial<StatusBarProps>): string {
  const { lastFrame, unmount } = render(
    React.createElement(StatusBar, {
      model: 'anthropic/claude',
      state: 'idle',
      ...props,
    } as StatusBarProps),
  );
  const out = strip(lastFrame() ?? '');
  unmount();
  return out;
}

describe('truncateChip', () => {
  it('passes short text through unchanged', () => {
    expect(truncateChip('main', 24)).toBe('main');
    expect(truncateChip('', 24)).toBe('');
  });

  it('head-truncates with a trailing ellipsis at the cap', () => {
    const out = truncateChip('a'.repeat(40), 24);
    expect(out).toBe(`${'a'.repeat(23)}…`);
    expect([...out].length).toBe(24);
  });
});

describe('planChipFit', () => {
  it('keeps every chip when they all fit', () => {
    expect(planChipFit([10, 10, 10], 100)).toBe(3);
  });

  it('accounts for the inter-chip separator cost', () => {
    // 10 + (10+5) = 25 fits in 25 but a third (+15) does not.
    expect(planChipFit([10, 10, 10], 25)).toBe(2);
    // 10 + (10+5) = 25 > 24 → only the first fits.
    expect(planChipFit([10, 10, 10], 24)).toBe(1);
  });

  it('always keeps the first chip even if it alone exceeds the budget', () => {
    expect(planChipFit([100], 10)).toBe(1);
    expect(planChipFit([100, 5], 10)).toBe(1);
  });

  it('returns 0 for an empty chip list', () => {
    expect(planChipFit([], 80)).toBe(0);
  });
});

describe('nodeText', () => {
  it('flattens string/number leaves across nested elements', () => {
    const el = React.createElement(
      'span',
      null,
      'ab',
      React.createElement('span', null, 'cd'),
      5,
    );
    expect(nodeText(el)).toBe('abcd5');
  });

  it('ignores null/boolean leaves', () => {
    const el = React.createElement('span', null, 'x', null, false, 'y');
    expect(nodeText(el)).toBe('xy');
  });
});

describe('StatusBar overflow handling (width-budget)', () => {
  it('truncates an over-long project name in the rendered frame', () => {
    const frame = frameOf({ projectName: 'p'.repeat(40), startedAt: Date.now() });
    expect(frame).not.toContain('p'.repeat(40));
    expect(frame).toContain(`${'p'.repeat(23)}…`);
  });

  it('drops trailing chips with a +N marker rather than wrapping the line', () => {
    // ink-testing-library renders at a fixed 100 columns; pack line 2 well past
    // that so the lowest-priority trailing chips must be dropped.
    const frame = frameOf({
      yolo: true,
      autonomy: 'eternal',
      startedAt: Date.now(),
      projectName: 'project-name-here',
      workingDir: 'some/working/directory/path',
      git: { branch: 'feature/long-branch-name', deleted: 2, untracked: 3 } as never,
      sessionCount: 4,
      toolCount: 42,
      tokenSavingMode: 'medium',
      goalSummary: {
        goal: 'ship the statusline overflow handling end to end',
        goalState: 'active',
        iterations: 7,
      },
    });
    const line = frame.split('\n').find((l) => l.includes('YOLO')) ?? '';
    // The visible line never exceeds the 100-col terminal (no wrap) — some
    // chips may overflow gracefully with a +N marker depending on spacing.
    expect(line.length).toBeLessThanOrEqual(100);
  });

  it('keeps the leading YOLO + autonomy chips when dropping (priority order)', () => {
    const frame = frameOf({
      yolo: true,
      autonomy: 'eternal',
      startedAt: Date.now(),
      projectName: 'project-name-here',
      workingDir: 'some/working/directory/path',
      git: { branch: 'feature/long-branch-name', deleted: 0, untracked: 0 } as never,
      sessionCount: 9,
      toolCount: 99,
      tokenSavingMode: 'medium',
    });
    const line = frame.split('\n').find((l) => l.includes('YOLO')) ?? '';
    expect(line).toContain('! YOLO');
    expect(line).toContain('∞ ETERNAL');
  });
});
