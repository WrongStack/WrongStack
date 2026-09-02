import { render } from 'ink-testing-library';
import React from 'react';
import { describe, expect, it } from 'vitest';
import {
  nodeText,
  planChipFit,
  StatusBar,
  type StatusBarProps,
  truncateChip,
} from '../src/components/status-bar.js';
import type { StatusBarClickMap } from '../src/components/status-bar-types.js';
import { displayWidth } from '../src/terminal-width.js';
import { renderRealTty, settle } from './helpers/real-tty.js';

/**
 * Status bar overflow handling for the 4-rail layout.
 *
 * Width-dependent tests render through `renderRealTty` at explicit column
 * counts — the layout under test is the real Ink/Yoga output at that
 * terminal size, not ink-testing-library's fixed 100-column default that the
 * previous version of this file relied on. All assertions are text-level
 * (ANSI-stripped); the raw-SGR color pins live in status-bar-sgr.test.ts
 * under the dedicated FORCE_COLOR config, which is also why this file can
 * run in the default vitest worker (it was excluded from it before only
 * because of those color pins).
 */

function strip(s: string): string {
  // eslint-disable-next-line no-control-characters
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

async function frameAt(columns: number, props: Partial<StatusBarProps>): Promise<string[]> {
  const view = renderRealTty(
    React.createElement(StatusBar, {
      model: 'anthropic/claude',
      state: 'idle',
      ...props,
    } as StatusBarProps),
    { columns, rows: 24 },
  );
  await settle();
  const lines = view.lines();
  view.unmount();
  return lines;
}

async function spansAt(
  columns: number,
  props: Partial<StatusBarProps>,
): Promise<Map<number, string[]>> {
  const clickMapRef: { current: StatusBarClickMap | null } = { current: null };
  const view = renderRealTty(
    React.createElement(StatusBar, {
      model: 'anthropic/claude',
      state: 'idle',
      ...props,
      clickMapRef,
    } as StatusBarProps),
    { columns, rows: 24 },
  );
  await settle();
  const idsByLine = new Map<number, string[]>();
  for (const line of clickMapRef.current?.lines ?? []) {
    idsByLine.set(
      line.line,
      line.spans.map((s) => s.id),
    );
  }
  view.unmount();
  return idsByLine;
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
    // 10 + (10+2) = 22 fits in 25 but a third (+12) does not.
    expect(planChipFit([10, 10, 10], 25)).toBe(2);
    // 10 + (10+2) = 22 ≤ 22 → two fit; but at 21 only the first.
    expect(planChipFit([10, 10, 10], 22)).toBe(2);
    expect(planChipFit([10, 10, 10], 21)).toBe(1);
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
    const el = React.createElement('span', null, 'ab', React.createElement('span', null, 'cd'), 5);
    expect(nodeText(el)).toBe('abcd5');
  });

  it('ignores null/boolean leaves', () => {
    const el = React.createElement('span', null, 'x', null, false, 'y');
    expect(nodeText(el)).toBe('xy');
  });
});

describe('StatusBar overflow handling (width-budget)', () => {
  it('truncates an over-long project name in the rendered frame', async () => {
    const lines = await frameAt(100, { projectName: 'p'.repeat(40) });
    const frame = lines.join('\n');
    expect(frame).not.toContain('p'.repeat(40));
    expect(frame).toContain(`${'p'.repeat(23)}…`);
  });

  it('drops trailing chips with a +N marker rather than wrapping the line', async () => {
    // Pack the identity rail (L1) well past 100 columns so the
    // lowest-priority trailing chips must be dropped with a +N marker.
    const lines = await frameAt(100, {
      projectName: 'project-name-here',
      workingDir: 'some/working/directory/path',
      git: { branch: 'feature/long-branch-name', added: 0, deleted: 2, untracked: 3 },
      sessionCount: 4,
      toolCount: 42,
    });
    expect(lines.length).toBeGreaterThan(0);
    // No rail may wrap: every rendered line fits the terminal width.
    for (const line of lines) {
      expect(displayWidth(line)).toBeLessThanOrEqual(100);
    }
    const identity = lines[0] ?? '';
    // Leading identity survives the drop; the omission marker appears.
    expect(identity).toContain('project-name-here');
    expect(identity).toContain('feature/long-branch-name');
    const overflowMatch = identity.match(/\+(\d+)/);
    expect(overflowMatch).not.toBeNull();
    expect(Number(overflowMatch?.[1])).toBeGreaterThan(0);
  });

  it('sacrifices the static tail first and leaves the run-state rail untouched', async () => {
    // At 60 columns the identity rail keeps its leading chips through the
    // model but drops the static tail (theme/sessions/tools). The run-state
    // rail below is budgeted independently — L1 overflow must never push
    // state/yolo/autonomy off L2. That isolation is the core guarantee of
    // the 2026-08-27 re-map.
    const idsByLine = await spansAt(60, {
      projectName: 'project-name-here',
      workingDir: 'pkg/mod',
      git: { branch: 'x', added: 0, deleted: 0, untracked: 0 },
      sessionCount: 4,
      toolCount: 42,
      yolo: true,
      autonomy: 'eternal',
    });
    const identity = idsByLine.get(0) ?? [];
    for (const id of ['project', 'working_dir', 'git', 'model']) {
      expect(identity).toContain(id);
    }
    expect(identity).not.toContain('tools');

    const runState = idsByLine.get(1) ?? [];
    expect(runState[0]).toBe('state');
    expect(runState).toContain('yolo');
    expect(runState).toContain('autonomy');
  });

  it('keeps the right-anchored version chip while the identity rail overflows', async () => {
    // The version chip is right-anchored: when L1 overflows, PowerlineRail
    // trims trailing left segments to reserve its columns — so the version
    // stays on screen next to the +N marker instead of being pushed off.
    const lines = await frameAt(100, {
      version: '0.7.0',
      projectName: 'project-name-here',
      workingDir: 'some/working/directory/path',
      git: { branch: 'feature/long-branch-name', added: 0, deleted: 0, untracked: 0 },
      sessionCount: 4,
      toolCount: 42,
    });
    const identity = lines[0] ?? '';
    expect(identity).toContain('v0.7.0');
    expect(identity).toMatch(/\+\d+/);
  });
});

describe('StatusBar version chip + update notice', () => {
  it('renders `v{version}` when version is provided', () => {
    const frame = frameOf({ version: '0.7.0' });
    expect(frame).toContain('v0.7.0');
    // No update notice suffix when updateAvailable is falsy.
    expect(frame).not.toContain('(update v');
  });

  it('appends the `(update v{latest})` suffix when updateAvailable + latestVersion are set', () => {
    const frame = frameOf({
      version: '0.7.0',
      latestVersion: '0.8.1',
      updateAvailable: true,
    });
    expect(frame).toContain('v0.7.0');
    expect(frame).toContain('(update v0.8.1)');
    // The orange truecolor pin for this suffix lives in
    // status-bar-sgr.test.ts (needs FORCE_COLOR=3, dedicated config).
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

  it('renders the update notice as plain text in no-color mode', () => {
    // Text-level companion to the raw-SGR no-color pin in
    // status-bar-sgr.test.ts: the notice must still be readable without
    // color, which this file can assert in the default (level-0) worker.
    const frame = frameOf({
      version: '0.7.0',
      latestVersion: '0.8.1',
      updateAvailable: true,
      mode: 'no-color',
    });
    expect(frame).toContain('v0.7.0');
    expect(frame).toContain('(update v0.8.1)');
  });
});
