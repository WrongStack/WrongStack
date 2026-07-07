import { describe, expect, it } from 'vitest';
import React from 'react';
import { render } from 'ink-testing-library';
import { SlashMenu } from '../src/components/slash-menu.js';
import type { SlashCommandMatch } from '../src/app-state.js';

function command(overrides: Partial<SlashCommandMatch> = {}): SlashCommandMatch {
  return {
    name: '/help',
    description: 'Show help.',
    category: 'General',
    ...overrides,
  };
}

describe('SlashMenu rendering', () => {
  it('renders command palette chrome with query and selection metadata', () => {
    const { lastFrame, unmount } = render(
      React.createElement(SlashMenu, {
        query: 'he',
        matches: [
          command(),
          command({ name: '/history', description: 'Show history.', matchedAlias: 'h' }),
        ],
        selected: 1,
      }),
    );

    const frame = lastFrame() ?? '';
    expect(frame).toContain('Command palette');
    expect(frame).toContain('/he');
    expect(frame).toContain('(2/2)');
    expect(frame).toContain('Type to filter commands by name, alias, or description.');
    expect(frame).toContain('alias /h');
    expect(frame).toContain('↑↓ nav · Enter run · Tab fill · Esc close');
    unmount();
  });

  it('renders a clearer empty state inside the framed palette', () => {
    const { lastFrame, unmount } = render(
      React.createElement(SlashMenu, {
        query: 'missing',
        matches: [],
        selected: 0,
      }),
    );

    const frame = lastFrame() ?? '';
    expect(frame).toContain('Command palette');
    expect(frame).toContain('/missing');
    expect(frame).toContain('(no matches)');
    expect(frame).toContain('No matching commands');
    unmount();
  });
});
