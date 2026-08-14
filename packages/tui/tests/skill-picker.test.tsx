import type { SkillEntry, SkillLoader } from '@wrongstack/core/types';
import { render } from 'ink-testing-library';
import React from 'react';
import { describe, expect, it } from 'vitest';
import { reducer } from '../src/app-reducer.js';
import { isPickerOverlayOpen } from '../src/app-ui-state.js';
import { SkillPicker } from '../src/components/skill-picker.js';
import { createAppJourney, waitForJourney } from './helpers/app-journey-harness.js';
import { createTestState } from './helpers/create-test-state.js';
import { renderRealTty, settle } from './helpers/real-tty.js';

const ENTRIES: SkillEntry[] = [
  {
    name: 'security-review',
    trigger: 'Use when reviewing authentication and authorization boundaries.',
    scope: ['typescript', 'api'],
    source: 'project',
    path: 'D:/project/.wrongstack/skills/security-review/SKILL.md',
  },
  {
    name: 'release-check',
    trigger: 'Use when validating a release candidate before publishing.',
    scope: ['release'],
    source: 'bundled',
    path: 'D:/package/skills/release-check/SKILL.md',
  },
];

describe('SkillPicker', () => {
  it('renders a two-pane list and focused skill details on wide terminals', async () => {
    const view = renderRealTty(
      React.createElement(SkillPicker, {
        entries: ENTRIES,
        selected: 1,
        columns: 100,
        maxRows: 14,
      }),
      { columns: 100, rows: 24 },
    );
    await settle();
    const frame = view.lastFrame();

    expect(frame).toContain('Skills');
    expect(frame).toContain('Enter open');
    expect(frame).toContain('security-review');
    expect(frame).toContain('release-check');
    expect(frame).toContain('Use when validating a release candidate');
    expect(frame).toContain('scope: release');
    expect(frame).toContain('source: bundled');
    expect(frame).toContain('full skill instructions');
    expect(frame.replace(/\s+$/gm, '').split('\n').filter(Boolean).length).toBeLessThanOrEqual(14);
    view.unmount();
  });

  it('falls back to a single list on narrow terminals', () => {
    const view = render(
      React.createElement(SkillPicker, {
        entries: ENTRIES,
        selected: 0,
        columns: 70,
        maxRows: 14,
      }),
    );
    const frame = view.lastFrame() ?? '';

    expect(frame).toContain('security-review');
    expect(frame).toContain('reviewing authentication');
    expect(frame).not.toContain('scope:');
    view.unmount();
  });

  it('sizes both panes from the longest skill name', async () => {
    const longestName = 'security-architecture-boundary-review';
    const entries: SkillEntry[] = [
      ...ENTRIES,
      {
        name: longestName,
        trigger: 'Use when reviewing system-wide security boundaries.',
        scope: ['architecture'],
        source: 'project',
        path: `D:/project/.wrongstack/skills/${longestName}/SKILL.md`,
      },
    ];
    const view = renderRealTty(
      React.createElement(SkillPicker, {
        entries,
        selected: entries.length - 1,
        columns: 120,
        maxRows: 14,
      }),
      { columns: 120, rows: 24 },
    );
    await settle();
    const frame = view.lastFrame();

    // The longest name fits once in the list and once as the detail heading;
    // neither pane may truncate it or force it onto a second line.
    expect(frame.match(new RegExp(longestName, 'g'))).toHaveLength(2);
    expect(frame).toContain('scope: architecture');
    expect(frame.split('\n').every((line) => line.length <= 120)).toBe(true);
    view.unmount();
  });

  it('opens, wraps navigation, and closes through reducer state', () => {
    let state = reducer(createTestState(), { type: 'skillPickerOpen', entries: ENTRIES });
    expect(state.skillPicker).toMatchObject({ open: true, selected: 0, entries: ENTRIES });
    expect(isPickerOverlayOpen(state)).toBe(true);

    state = reducer(state, { type: 'skillPickerMove', delta: -1 });
    expect(state.skillPicker.selected).toBe(1);

    state = reducer(state, { type: 'skillPickerMove', delta: 1 });
    expect(state.skillPicker.selected).toBe(0);

    state = reducer(state, { type: 'skillPickerClose' });
    expect(state.skillPicker).toMatchObject({ open: false, selected: 0, entries: [] });
  });

  it('makes bare /skill open the picker while /skill <name> returns instructions', async () => {
    const loader: SkillLoader = {
      list: async () => [],
      listEntries: async () => ENTRIES,
      find: async (name) =>
        name === ENTRIES[0]?.name
          ? {
              name: 'security-review',
              description: 'Review security boundaries',
              source: 'project',
              path: 'D:/project/.wrongstack/skills/security-review/SKILL.md',
            }
          : undefined,
      manifestText: async () => '',
      readBody: async () =>
        '---\nname: security-review\n---\n# Security review\nCheck auth boundaries.',
      readSaveBody: async () => '',
      invalidateCache: () => {},
    };
    const journey = createAppJourney();
    const view = journey.mount({ skillLoader: loader });
    await waitForJourney(() => journey.props.slashRegistry.get('skill') !== undefined);

    const openResult = await journey.props.slashRegistry.dispatch('/skill', {} as never);
    expect(openResult?.message).toBeUndefined();
    await waitForJourney(() => (view.lastFrame() ?? '').includes('security-review'));
    expect(view.lastFrame() ?? '').toContain('Skills');

    const detailResult = await journey.props.slashRegistry.dispatch(
      '/skill security-review',
      {} as never,
    );
    expect(detailResult?.message).toContain('# Security review');
    expect(detailResult?.message).not.toContain('name: security-review');
    view.unmount();
  });
});

describe('SkillPicker - detail panel height stability (split mode)', () => {
  // Regression: navigating between skills with different trigger lengths used
  // to change the detail-panel height because the "use when" trigger rendered
  // with wrap="wrap" and no height floor. The trigger is now pre-wrapped into
  // a fixed line budget with blank-line padding, so every skill's frame must
  // be the same height.
  const columns = 100;
  const maxRows = 14;

  function frameLineCount(frame: string): number {
    const trimmed = frame.replace(/\s+$/, '');
    return trimmed === '' ? 0 : trimmed.split('\n').length;
  }

  it('renders the same frame height for a one-line vs a long multi-line trigger', async () => {
    const entries: SkillEntry[] = [
      {
        name: 'short-trigger-skill',
        trigger: 'Short.',
        scope: ['typescript'],
        source: 'project',
        path: 'D:/project/.wrongstack/skills/short/SKILL.md',
      },
      {
        name: 'long-trigger-skill',
        trigger:
          'Use when reviewing authentication and authorization boundaries across distributed services, including OAuth flows, session validation, token refresh edge cases, and cross-origin resource sharing policies.',
        scope: ['security', 'architecture'],
        source: 'project',
        path: 'D:/project/.wrongstack/skills/long/SKILL.md',
      },
    ];

    const viewShort = renderRealTty(
      React.createElement(SkillPicker, { entries, selected: 0, columns, maxRows }),
      { columns, rows: 24 },
    );
    await settle();
    const shortFrame = viewShort.lastFrame() ?? '';
    viewShort.unmount();

    const viewLong = renderRealTty(
      React.createElement(SkillPicker, { entries, selected: 1, columns, maxRows }),
      { columns, rows: 24 },
    );
    await settle();
    const longFrame = viewLong.lastFrame() ?? '';
    viewLong.unmount();

    expect(frameLineCount(shortFrame)).toBe(frameLineCount(longFrame));
  });
});
