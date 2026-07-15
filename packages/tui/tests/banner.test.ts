import { render } from 'ink-testing-library';
import React from 'react';
import { describe, expect, it } from 'vitest';
import { Banner, shortenPath } from '../src/components/history.js';

describe('<Banner />', () => {
  it('shows the version and route info in the full layout', () => {
    const { lastFrame, unmount } = render(
      React.createElement(Banner, {
        entry: {
          id: 0,
          kind: 'banner',
          version: '1.2.3',
          provider: 'test-provider',
          model: 'test-model',
          cwd: '/workspace/my-project',
        },
      }),
    );

    const frame = lastFrame() ?? '';
    unmount();

    // Version is right-aligned at top
    expect(frame).toContain('v1.2.3');
    // Route line shows provider › model
    expect(frame).toContain('test-provider › test-model');
    // The cwd is shown in the workspace fact row
    expect(frame).toContain('my-project');
  });

  it('renders the FIGlet wordmark and runtime facts at normal terminal widths', () => {
    const { lastFrame, unmount } = render(
      React.createElement(Banner, {
        termWidth: 80,
        entry: {
          id: 0,
          kind: 'banner',
          version: '9.9.9',
          provider: 'anthropic',
          model: 'claude-test',
          cwd: '/workspace/wrongstack',
          family: 'claude',
          keyTail: 'XYZ',
        },
      }),
    );

    const frame = lastFrame() ?? '';
    unmount();

    // The wordmark is classic FIGlet standard-font ASCII art — 5 rows
    // of underscores, pipes, and slashes forming "WRONGSTACK".
    expect(frame).toContain('______  ____  _');
    expect(frame).toContain('BUILT ON THE WRONG STACK. SHIPPED ANYWAY.');
    expect(frame).toContain('anthropic › claude-test');
    expect(frame).toContain('•••• XYZ');
    expect(frame).toContain('/workspace/wrongstack');
    // Version is at the top-right
    expect(frame).toContain('v9.9.9');
    // Loud orange frame is gone — replaced by the calm slate border.
    expect(frame).not.toContain('▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄');
  });

  it('switches to a compact layout and hides the wordmark at narrow widths', () => {
    const termWidth = 44;
    const { lastFrame, unmount } = render(
      React.createElement(Banner, {
        termWidth,
        entry: {
          id: 0,
          kind: 'banner',
          version: '1.2.3',
          provider: 'a-provider-with-a-very-long-name',
          model: 'a-model-with-a-very-long-name',
          cwd: '/workspace/a/very/deep/project/directory',
        },
      }),
    );

    const frame = lastFrame() ?? '';
    unmount();

    // Chip shows "WrongStack" product badge in compact mode
    expect(frame).toContain('WrongStack');
    // Compact layout omits the full WRONGSTACK wordmark so the
    // narrow terminal stays readable.
    expect(frame).not.toContain('WRONGSTACK');
    // Route line is back — just at the available width
    expect(frame).toContain('a-provider-with-a-very-');
    expect(frame.split('\n').every((line) => line.length <= termWidth)).toBe(true);
  });

  it('does not wrap its own content at ultra-compact widths', () => {
    const termWidth = 24;
    const { lastFrame, unmount } = render(
      React.createElement(Banner, {
        termWidth,
        entry: {
          id: 0,
          kind: 'banner',
          version: '123.456.789-preview',
          provider: 'provider',
          model: 'model',
          cwd: '/workspace/project',
        },
      }),
    );

    const frame = lastFrame() ?? '';
    unmount();

    expect(frame.split('\n').every((line) => line.length <= termWidth)).toBe(true);
    expect(frame).toContain('WrongStack');
  });
});

describe('<Banner /> snapshot — full rendered output', () => {
  it('matches the snapshot at 80 columns (full layout with wordmark)', () => {
    const { lastFrame, unmount } = render(
      React.createElement(Banner, {
        termWidth: 80,
        entry: {
          id: 0,
          kind: 'banner',
          version: '0.287.0',
          provider: 'anthropic',
          model: 'claude-opus-4',
          cwd: '/workspace/wrongstack',
          family: 'claude',
          keyTail: 'ABC',
        },
      }),
    );

    const frame = lastFrame() ?? '';
    unmount();

    // Full-layout snapshot — verifies the wordmark, separator, facts,
    // and box-drawing frame are all structurally correct and aligned.
    // If the Banner layout is deliberately changed, update the snapshot
    // with `pnpm test -- --update`.
    expect(frame).toMatchSnapshot();
  });

  it('matches the snapshot at 44 columns (compact layout, no wordmark)', () => {
    const { lastFrame, unmount } = render(
      React.createElement(Banner, {
        termWidth: 44,
        entry: {
          id: 0,
          kind: 'banner',
          version: '1.2.3',
          provider: 'openai',
          model: 'gpt-4o',
          cwd: '/workspace/my-project',
        },
      }),
    );

    const frame = lastFrame() ?? '';
    unmount();

    // Compact-layout snapshot — verifies the tagline-only rendering
    // with the inline [ WrongStack ] badge and single-column facts.
    expect(frame).toMatchSnapshot();
  });
});

describe('shortenPath (banner cwd)', () => {
  it('returns the path unchanged when within the budget', () => {
    expect(shortenPath('/tmp/x', 32)).toBe('/tmp/x');
  });

  it('keeps the tail and prefixes with an ellipsis when over the budget', () => {
    const out = shortenPath('/aaa/bbb/ccc/ddd/eee/fff/ggg', 16);
    expect(out.length).toBeLessThanOrEqual(16);
    expect(out.startsWith('…')).toBe(true);
    // The end of the path (closest to the user's actual working dir)
    // is preserved.
    expect(out.endsWith('ggg')).toBe(true);
  });

  it('honours the exact width budget down to the ellipsis character', () => {
    // 20-char path, 10-char budget → 1 ellipsis + 9 chars of tail.
    expect(shortenPath('abcdefghij1234567890', 10)).toBe('…2345678​90'.replace('​', ''));
    // simpler: check it's 10 chars and starts with ellipsis.
    const out = shortenPath('abcdefghij1234567890', 10);
    expect(out.length).toBe(10);
    expect(out[0]).toBe('…');
  });

  it('treats an empty string as a no-op', () => {
    expect(shortenPath('', 10)).toBe('');
  });
});
