import { render } from 'ink-testing-library';
import React from 'react';
import { describe, expect, it } from 'vitest';
import {
  nodeText,
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

interface RailProbe {
  ids: string[];
  levels: Map<string, number>;
  dropped: string[];
}

async function railsAt(
  columns: number,
  props: Partial<StatusBarProps>,
): Promise<Map<number, RailProbe>> {
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
  const byLogical = new Map<number, RailProbe>();
  for (const line of clickMapRef.current?.lines ?? []) {
    if (line.logical == null) continue;
    byLogical.set(line.logical, {
      ids: line.spans.map((s) => s.id),
      levels: new Map(line.spans.map((s) => [s.id, s.level])),
      dropped: line.droppedIds ?? [],
    });
  }
  view.unmount();
  return byLogical;
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

  it('shortens chips instead of dropping them while any chip can still shrink', async () => {
    // The identity rail's content is well past 100 columns at full density.
    // The fitter's contract is shorten-before-drop, so at this width every
    // chip survives and the concession shows up as raised density levels.
    const rails = await railsAt(100, {
      projectName: 'project-name-here',
      workingDir: 'some/working/directory/path',
      git: { branch: 'feature/long-branch-name', added: 0, deleted: 2, untracked: 3 },
      sessionCount: 4,
      toolCount: 42,
    });
    const identity = rails.get(1)!;
    expect(identity.dropped).toEqual([]);
    for (const id of ['project', 'working_dir', 'git', 'model', 'tools']) {
      expect(identity.ids).toContain(id);
    }
    // Something had to give: at least one chip is rendering a narrower form.
    expect([...identity.levels.values()].some((level) => level > 0)).toBe(true);
  });

  it('never wraps a rail, at any width', async () => {
    for (const columns of [140, 100, 80, 60, 40]) {
      const lines = await frameAt(columns, {
        projectName: 'project-name-here',
        workingDir: 'some/working/directory/path',
        git: { branch: 'feature/long-branch-name', added: 0, deleted: 2, untracked: 3 },
        sessionCount: 4,
        toolCount: 42,
        version: '1.2.3',
      });
      for (const line of lines) {
        expect(displayWidth(line)).toBeLessThanOrEqual(columns);
      }
    }
  });

  it('falls back to dropping trailing chips once shortening is exhausted', async () => {
    const rails = await railsAt(60, {
      projectName: 'project-name-here',
      workingDir: 'some/working/directory/path',
      git: { branch: 'feature/long-branch-name', added: 0, deleted: 2, untracked: 3 },
      modeLabel: 'teach',
      promptVariant: 'pro',
      sessionCount: 4,
      toolCount: 42,
    });
    const identity = rails.get(1)!;
    expect(identity.dropped.length).toBeGreaterThan(0);
    // Leading identity survives; the tail is what goes.
    expect(identity.ids.slice(0, 3)).toEqual(['project', 'working_dir', 'git']);
    expect(identity.dropped).toContain('tools');
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
