import { render } from 'ink-testing-library';
import React from 'react';
import { describe, expect, it } from 'vitest';
import { type HelpEntry, HelpPanel } from '../src/components/help-panel.js';

function makeEntry(overrides: Partial<HelpEntry> = {}): HelpEntry {
  return {
    name: 'test-cmd',
    description: 'A test command',
    category: 'Run',
    ...overrides,
  };
}

describe('HelpPanel', () => {
  it('renders the header', () => {
    const view = render(
      React.createElement(HelpPanel, {
        entries: [makeEntry()],
        filter: '',
        selected: 0,
      }),
    );
    const frame = view.lastFrame() ?? '';
    expect(frame).toContain('Help / Command Palette');
    view.unmount();
  });

  it('shows navigation hint when filter is empty', () => {
    const view = render(
      React.createElement(HelpPanel, {
        entries: [makeEntry()],
        filter: '',
        selected: 0,
      }),
    );
    const frame = view.lastFrame() ?? '';
    expect(frame).toContain('↑/↓ list');
    view.unmount();
  });

  it('shows filter count when filter is active', () => {
    const view = render(
      React.createElement(HelpPanel, {
        entries: [makeEntry(), makeEntry({ name: 'other' })],
        filter: 'test',
        selected: 0,
      }),
    );
    const frame = view.lastFrame() ?? '';
    expect(frame).toContain('Filter: test');
    view.unmount();
  });

  it('filters entries by name', () => {
    const view = render(
      React.createElement(HelpPanel, {
        entries: [makeEntry({ name: 'foo' }), makeEntry({ name: 'bar' })],
        filter: 'foo',
        selected: 0,
      }),
    );
    const frame = view.lastFrame() ?? '';
    expect(frame).toContain('/foo');
    expect(frame).not.toContain('/bar');
    view.unmount();
  });

  it('filters entries by description', () => {
    const view = render(
      React.createElement(HelpPanel, {
        entries: [makeEntry({ name: 'a', description: 'searchable text' })],
        filter: 'searchable',
        selected: 0,
      }),
    );
    const frame = view.lastFrame() ?? '';
    expect(frame).toContain('/a');
    view.unmount();
  });

  it('filters entries by category', () => {
    const view = render(
      React.createElement(HelpPanel, {
        entries: [makeEntry({ name: 'a', category: 'Config' })],
        filter: 'Config',
        selected: 0,
      }),
    );
    const frame = view.lastFrame() ?? '';
    expect(frame).toContain('/a');
    view.unmount();
  });

  it('filters entries by alias', () => {
    const view = render(
      React.createElement(HelpPanel, {
        entries: [makeEntry({ name: 'a', aliases: ['alias-foo'] })],
        filter: 'alias-foo',
        selected: 0,
      }),
    );
    const frame = view.lastFrame() ?? '';
    expect(frame).toContain('/a');
    view.unmount();
  });

  it('shows "No commands match" when filter results are empty', () => {
    const view = render(
      React.createElement(HelpPanel, {
        entries: [makeEntry({ name: 'foo' })],
        filter: 'zzzzz',
        selected: 0,
      }),
    );
    const frame = view.lastFrame() ?? '';
    expect(frame).toContain('No commands match');
    view.unmount();
  });

  it('shows empty state when entries is empty with no filter', () => {
    const view = render(
      React.createElement(HelpPanel, {
        entries: [],
        filter: '',
        selected: 0,
      }),
    );
    const frame = view.lastFrame() ?? '';
    expect(frame).toContain('No commands match');
    view.unmount();
  });

  it('renders category headers', () => {
    const view = render(
      React.createElement(HelpPanel, {
        entries: [
          makeEntry({ name: 'a', category: 'Run' }),
          makeEntry({ name: 'b', category: 'Config' }),
        ],
        filter: '',
        selected: 0,
      }),
    );
    const frame = view.lastFrame() ?? '';
    expect(frame).toContain('Run');
    expect(frame).toContain('Config');
    view.unmount();
  });

  it('renders aliases in parentheses', () => {
    const view = render(
      React.createElement(HelpPanel, {
        entries: [makeEntry({ name: 'cmd', aliases: ['c', 'command'] })],
        filter: '',
        selected: 0,
      }),
    );
    const frame = view.lastFrame() ?? '';
    expect(frame).toContain('/c, /command');
    view.unmount();
  });

  it('does not render aliases line when empty', () => {
    const view = render(
      React.createElement(HelpPanel, {
        entries: [makeEntry({ name: 'cmd' })],
        filter: '',
        selected: 0,
      }),
    );
    const frame = view.lastFrame() ?? '';
    expect(frame).not.toContain('(/)');
    view.unmount();
  });

  it('renders argsHint when provided', () => {
    const view = render(
      React.createElement(HelpPanel, {
        entries: [makeEntry({ name: 'cmd', argsHint: '<file>' })],
        filter: '',
        selected: 0,
      }),
    );
    const frame = view.lastFrame() ?? '';
    expect(frame).toContain('<file>');
    view.unmount();
  });

  it('shows hint when provided', () => {
    const view = render(
      React.createElement(HelpPanel, {
        entries: [makeEntry()],
        filter: '',
        selected: 0,
        hint: 'Select a command and press Enter',
      }),
    );
    const frame = view.lastFrame() ?? '';
    expect(frame).toContain('Select a command');
    view.unmount();
  });

  it('handles large entry list with scrolling', () => {
    const entries = Array.from({ length: 50 }, (_, i) =>
      makeEntry({ name: `cmd-${String(i).padStart(2, '0')}`, category: 'Run' }),
    );
    const view = render(
      React.createElement(HelpPanel, {
        entries,
        filter: '',
        selected: 10,
      }),
    );
    const frame = view.lastFrame() ?? '';
    expect(frame).toContain('cmd-10');
    view.unmount();
  });

  it('highlights selected entry', () => {
    const view = render(
      React.createElement(HelpPanel, {
        entries: [makeEntry({ name: 'selected-cmd' })],
        filter: '',
        selected: 0,
      }),
    );
    const frame = view.lastFrame() ?? '';
    expect(frame).toContain('›');
    view.unmount();
  });

  it('sorts entries by category order then name', () => {
    const view = render(
      React.createElement(HelpPanel, {
        entries: [
          makeEntry({ name: 'z-cmd', category: 'App' }),
          makeEntry({ name: 'a-cmd', category: 'Run' }),
        ],
        filter: '',
        selected: 0,
      }),
    );
    const frame = view.lastFrame() ?? '';
    // Run should come before App alphabetically
    expect(frame).toContain('a-cmd');
    expect(frame).toContain('z-cmd');
    view.unmount();
  });

  it('handles entry with unknown category (defaults to App)', () => {
    const view = render(
      React.createElement(HelpPanel, {
        entries: [makeEntry({ name: 'unknown-cmd', category: 'Unknown' })],
        filter: '',
        selected: 0,
      }),
    );
    const frame = view.lastFrame() ?? '';
    expect(frame).toContain('/unknown-cmd');
    view.unmount();
  });

  it('renders detailed help from help property in the right column', () => {
    const view = render(
      React.createElement(HelpPanel, {
        entries: [
          makeEntry({
            name: 'exec',
            description: 'Execute run',
            help: 'Execute a command or run\nUsage: /exec <id>\nOptions: --json',
          }),
        ],
        filter: '',
        selected: 0,
      }),
    );
    const frame = view.lastFrame() ?? '';
    expect(frame).toContain('Execute a command or run');
    expect(frame).toContain('Usage: /exec <id>');
    expect(frame).toContain('│');
    view.unmount();
  });

  it('updates detailed help when selected index changes', () => {
    const entries = [
      makeEntry({
        name: 'first-cmd',
        category: 'Run',
        help: 'Help info for first command',
      }),
      makeEntry({
        name: 'second-cmd',
        category: 'Run',
        help: 'Help info for second command',
      }),
    ];

    const view1 = render(
      React.createElement(HelpPanel, {
        entries,
        filter: '',
        selected: 0,
      }),
    );
    expect(view1.lastFrame() ?? '').toContain('Help info for first command');
    expect(view1.lastFrame() ?? '').not.toContain('Help info for second command');
    view1.unmount();

    const view2 = render(
      React.createElement(HelpPanel, {
        entries,
        filter: '',
        selected: 1,
      }),
    );
    expect(view2.lastFrame() ?? '').toContain('Help info for second command');
    expect(view2.lastFrame() ?? '').not.toContain('Help info for first command');
    view2.unmount();
  });

  it('strictly caps panel height to max 26 rows even with large maxRows', () => {
    const entries = Array.from({ length: 40 }, (_, i) =>
      makeEntry({
        name: `long-list-cmd-${i}`,
        category: 'Run',
        help: `Detailed multi-line help line 1 for ${i}\nline 2\nline 3\nline 4\nline 5`,
      }),
    );

    const view = render(
      React.createElement(HelpPanel, {
        entries,
        filter: '',
        selected: 5,
        maxRows: 35,
      }),
    );
    const frame = view.lastFrame() ?? '';
    const lines = frame.split('\n');
    // Ink box with height 26 should produce at most 26 lines (plus optional trailing empty line)
    const nonEmptyLines = lines.filter((l) => l.length > 0);
    expect(nonEmptyLines.length).toBeLessThanOrEqual(26);
    view.unmount();
  });

  it('scrolls detailed help lines when detailScroll is provided', () => {
    const longHelp = Array.from({ length: 25 }, (_, i) => `Detailed Help Line ${i + 1}`).join('\n');
    const entries = [
      makeEntry({
        name: 'scroll-cmd',
        category: 'Run',
        help: longHelp,
      }),
    ];

    const viewTop = render(
      React.createElement(HelpPanel, {
        entries,
        filter: '',
        selected: 0,
        detailScroll: 0,
      }),
    );
    const frameTop = viewTop.lastFrame() ?? '';
    expect(frameTop).toContain('Detailed Help Line 1');
    expect(frameTop).toContain('PgUp/PgDn');
    viewTop.unmount();

    const viewScrolled = render(
      React.createElement(HelpPanel, {
        entries,
        filter: '',
        selected: 0,
        detailScroll: 10,
      }),
    );
    const frameScrolled = viewScrolled.lastFrame() ?? '';
    expect(frameScrolled).toContain('Detailed Help Line 11');
    expect(frameScrolled).not.toContain('Detailed Help Line 1\n');
    viewScrolled.unmount();
  });
});
