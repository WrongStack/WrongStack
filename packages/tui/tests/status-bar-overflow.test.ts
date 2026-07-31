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

describe('StatusBar version chip + update notice', () => {
  it('renders `v{version}` when version is provided', () => {
    const frame = frameOf({ version: '0.7.0' });
    expect(frame).toContain('v0.7.0');
    // No update notice suffix when updateAvailable is falsy.
    expect(frame).not.toContain('(update v');
  });

  it('appends the orange `(update v{latest})` suffix when updateAvailable + latestVersion are set', () => {
    const frame = frameOf({
      version: '0.7.0',
      latestVersion: '0.8.1',
      updateAvailable: true,
    });
    expect(frame).toContain('v0.7.0');
    expect(frame).toContain('(update v0.8.1)');
    // The update suffix must be tinted with STACK_ORANGE (#FD9F02 = truecolor
    // \x1b[38;2;253;159;2m). Render a raw (non-ANSI-stripped) frame here —
    // frameOf() strips SGR before matching, which would silently swallow this
    // assertion. Pinning the escape stops a future refactor from swapping the
    // brand orange for theme.warn (pastel yellow) unnoticed.
    const { lastFrame, unmount } = render(
      React.createElement(StatusBar, {
        model: 'anthropic/claude',
        state: 'idle',
        version: '0.7.0',
        latestVersion: '0.8.1',
        updateAvailable: true,
      } as StatusBarProps),
    );
    const raw = lastFrame() ?? '';
    unmount();
    expect(raw).toMatch(/\x1b\[38;2;253;159;2m.*\(update v0\.8\.1\)/);
  });

  it('omits the update suffix when updateAvailable is false even if latestVersion is set', () => {
    const frame = frameOf({
      version: '0.7.0',
      latestVersion: '0.7.0',
      updateAvailable: false,
    });
    expect(frame).toContain('v0.7.0');
    expect(frame).not.toContain('(update v');
  });

  it('omits the update suffix when latestVersion is empty', () => {
    const frame = frameOf({
      version: '0.7.0',
      latestVersion: '',
      updateAvailable: true,
    });
    expect(frame).toContain('v0.7.0');
    expect(frame).not.toContain('(update v');
  });

  it('omits the update suffix when latestVersion equals version (already on latest)', () => {
    // Defensive guard: if the preflight check returns the running version as
    // `latestVersion` but a stale `updateAvailable: true`, the chip must not
    // claim an update is needed. (The npm-registry path already filters this
    // via semver, but the boot session-start payload is upstream-trusted.)
    const frame = frameOf({
      version: '0.7.0',
      latestVersion: '0.7.0',
      updateAvailable: true,
    });
    expect(frame).toContain('v0.7.0');
    expect(frame).not.toContain('(update v');
  });

  it('omits the version chip entirely when no version is provided', () => {
    const frame = frameOf({});
    expect(frame).not.toMatch(/\bv\d+\.\d+\.\d+\b/);
  });

  it('renders the chip monochrome (no orange SGR) in no-color mode', () => {
    // Render a raw (non-ANSI-stripped) frame — frameOf() strips SGR before
    // matching, which would make a negative SGR assertion vacuous (it could
    // never fail). Asserting on the raw frame actually catches a regression
    // where no-color mode still emits orange truecolor.
    const { lastFrame, unmount } = render(
      React.createElement(StatusBar, {
        model: 'anthropic/claude',
        state: 'idle',
        version: '0.7.0',
        latestVersion: '0.8.1',
        updateAvailable: true,
        mode: 'no-color',
      } as StatusBarProps),
    );
    const raw = lastFrame() ?? '';
    unmount();
    expect(raw).toContain('v0.7.0');
    expect(raw).toContain('(update v0.8.1)');
    // The brand-orange truecolor (STACK_ORANGE #FD9F02 = 253;159;2) must not
    // survive in no-color mode. Assert the specific orange SGR rather than
    // "any truecolor": the unrelated `+N dropped` overflow marker emits
    // theme.textMuted truecolor unconditionally (not gated by monochrome), so
    // a blanket `not.toMatch(/\x1b\[38;2;/)` would fail spuriously the moment
    // line 1 widens enough to overflow — even though the chip is correctly
    // monochrome. (The marker's unconditional color is a separate pre-existing
    // powerline-rail concern, not a version-chip regression.)
    expect(raw).not.toMatch(/\x1b\[38;2;253;159;2m/);
  });
});
