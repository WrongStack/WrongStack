import { render } from 'ink-testing-library';
import React from 'react';
import { describe, expect, it } from 'vitest';
import {
  bannerGradientColor,
  brandMarkPinkRow,
  WORDMARK_LINES,
} from '../src/components/history/banner.js';
import { Banner, shortenPath } from '../src/components/history.js';
import { displayWidth } from '../src/terminal-width.js';
import { theme } from '../src/theme.js';

// ── ANSI / OSC 8 stripping ──
// Ink writes raw escape sequences to stdout — OSC 8 hyperlink framing and
// ANSI SGR color codes are invisible to a real terminal.  The width-assertion
// tests must measure *visible* length, not raw byte length, to match what the
// user actually sees.
const ANSI_OSC8_RE = /\x1b\[[0-9;]*[A-Za-z]|\x1b\]8;[^\x07]*?(?:\x07|\x1b\\)/g;
const visibleLength = (s: string): number => s.replace(ANSI_OSC8_RE, '').length;

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

  it('renders the update-available indicator when the registry reports a newer version', () => {
    const { lastFrame, unmount } = render(
      React.createElement(Banner, {
        entry: {
          id: 0,
          kind: 'banner',
          version: '1.2.3',
          provider: 'test-provider',
          model: 'test-model',
          cwd: '/workspace/project',
          latestVersion: '1.3.0',
          updateAvailable: true,
        },
      }),
    );

    const frame = lastFrame() ?? '';
    unmount();

    // The current version chip is still rendered as before.
    expect(frame).toContain('v1.2.3');
    // The "(update available: v…)" chip is appended to that chip's line.
    expect(frame).toContain('(update available: v1.3.0)');
  });

  it('omits the update-available indicator when updateAvailable is false', () => {
    const { lastFrame, unmount } = render(
      React.createElement(Banner, {
        entry: {
          id: 0,
          kind: 'banner',
          version: '1.3.0',
          provider: 'test-provider',
          model: 'test-model',
          cwd: '/workspace/project',
          // latestVersion set but the current version already matches —
          // the indicator must stay suppressed.
          latestVersion: '1.3.0',
          updateAvailable: false,
        },
      }),
    );

    const frame = lastFrame() ?? '';
    unmount();

    expect(frame).toContain('v1.3.0');
    expect(frame).not.toContain('(update available');
  });

  it('does not render a half-message when updateAvailable is true but latestVersion is missing', () => {
    // Defensive coverage: the banner guard requires BOTH fields to render —
    // a malformed pair (e.g. mid-flight check failure that flipped the
    // boolean but lost the version) must not produce "(update available: v)".
    const { lastFrame, unmount } = render(
      React.createElement(Banner, {
        entry: {
          id: 0,
          kind: 'banner',
          version: '1.2.3',
          provider: 'test-provider',
          model: 'test-model',
          cwd: '/workspace/project',
          updateAvailable: true,
        },
      }),
    );

    const frame = lastFrame() ?? '';
    unmount();

    expect(frame).toContain('v1.2.3');
    expect(frame).not.toContain('(update available');
  });

  it('renders the pixel wordmark and runtime facts at normal terminal widths', () => {
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

    // The wordmark packs a clear 5×7 bitmap into four terminal rows. Upper
    // and lower half blocks preserve vertical detail without fragmenting the
    // strokes or doubling the banner height.
    expect(frame).toContain(WORDMARK_LINES[0]);
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

    // Compact mode keeps the canonical product name.
    expect(frame).toContain('WrongStack');
    // Compact layout omits the full pixel wordmark so the narrow terminal
    // stays readable.
    expect(frame).not.toContain('WRONGSTACK');
    // Route line is back — just at the available width
    expect(frame).toContain('a-provider-with-a-very-');
    expect(frame.split('\n').every((line) => visibleLength(line) <= termWidth)).toBe(true);
  });

  it('pins the full-layout height breakpoint for a banner without optional rows', () => {
    const entry = {
      id: 0,
      kind: 'banner' as const,
      version: '1.2.3',
      provider: 'openai',
      model: 'gpt-test',
      cwd: '/workspace/wrongstack',
    };
    const below = render(React.createElement(Banner, { termWidth: 80, termHeight: 20, entry }));
    const at = render(React.createElement(Banner, { termWidth: 80, termHeight: 21, entry }));

    expect(below.lastFrame()).not.toContain(WORDMARK_LINES[0]);
    expect(at.lastFrame()).toContain(WORDMARK_LINES[0]);
    below.unmount();
    at.unmount();
  });

  it('renders nothing when the managed history has no measured rows', () => {
    const { lastFrame, unmount } = render(
      React.createElement(Banner, {
        termWidth: 80,
        termHeight: 0,
        entry: {
          id: 0,
          kind: 'banner',
          version: '1.2.3',
          provider: 'openai',
          model: 'gpt-test',
          cwd: '/workspace/wrongstack',
        },
      }),
    );

    expect(lastFrame() ?? '').toBe('');
    unmount();
  });

  it('uses a one-line identity strip when the managed history is only one row tall', () => {
    const { lastFrame, unmount } = render(
      React.createElement(Banner, {
        termWidth: 80,
        termHeight: 1,
        entry: {
          id: 0,
          kind: 'banner',
          version: '1.2.3',
          provider: 'openai',
          model: 'gpt-test',
          cwd: '/workspace/wrongstack',
        },
      }),
    );

    const frame = lastFrame() ?? '';
    unmount();

    expect(frame.split('\n')).toHaveLength(1);
    expect(frame).toContain('WrongStack v1.2.3');
    expect(frame).toContain('openai/gpt-test');
  });

  it('uses the full terminal width for the unbordered identity strip', () => {
    const termWidth = 40;
    const { lastFrame, unmount } = render(
      React.createElement(Banner, {
        termWidth,
        termHeight: 1,
        entry: {
          id: 0,
          kind: 'banner',
          version: '1.2.3',
          provider: 'provider-with-a-long-name',
          model: 'model-with-a-long-name',
          cwd: '/workspace/wrongstack',
        },
      }),
    );

    const frame = lastFrame() ?? '';
    unmount();

    expect(displayWidth(frame)).toBe(termWidth);
  });

  it('uses the condensed identity strip when height is insufficient for the full wordmark', () => {
    const { lastFrame, unmount } = render(
      React.createElement(Banner, {
        termWidth: 80,
        termHeight: 18,
        entry: {
          id: 0,
          kind: 'banner',
          version: '1.2.3',
          provider: 'openai',
          model: 'gpt-test',
          cwd: '/workspace/wrongstack',
        },
      }),
    );

    const frame = lastFrame() ?? '';
    unmount();

    expect(frame).toContain('WrongStack v1.2.3');
    expect(frame).not.toContain(WORDMARK_LINES[0]);
    expect(frame.split('\n')).toHaveLength(3);
  });

  it('keeps wide Unicode input inside a narrow condensed panel', () => {
    const termWidth = 22;
    const { lastFrame, unmount } = render(
      React.createElement(Banner, {
        termWidth,
        termHeight: 3,
        entry: {
          id: 0,
          kind: 'banner',
          version: '1.2.3',
          provider: '模型',
          model: '提供商',
          cwd: '/工作区/项目',
        },
      }),
    );

    const frame = lastFrame() ?? '';
    unmount();

    expect(frame.split('\n').every((line) => displayWidth(line) <= termWidth)).toBe(true);
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

    expect(frame.split('\n').every((line) => visibleLength(line) <= termWidth)).toBe(true);
    expect(frame).toContain('WrongStack');
  });

  it.each([64, 65, 66])(
    'stays inside the viewport around the layout breakpoint at %i columns',
    (termWidth) => {
      const { lastFrame, unmount } = render(
        React.createElement(Banner, {
          termWidth,
          entry: {
            id: 0,
            kind: 'banner',
            version: '1.2.3',
            provider: 'anthropic',
            model: 'claude-opus-test',
            cwd: '/workspace/wrongstack',
          },
        }),
      );

      const frame = lastFrame() ?? '';
      unmount();

      expect(frame.split('\n').every((line) => visibleLength(line) <= termWidth)).toBe(true);
      expect(frame.includes(WORDMARK_LINES[0] ?? '')).toBe(termWidth >= 65);
    },
  );
});

describe('banner brand gradient', () => {
  it('moves smoothly between the active theme brand endpoints', () => {
    const colors = Array.from({ length: 9 }, (_, index) => bannerGradientColor(index, 9));

    // Endpoints follow the active theme rather than the literal SVG hex —
    // Catppuccin peach (#FAB387) → Catppuccin pink (#F5C2E7) on the default
    // preset. Re-running after a `/theme` swap will produce different
    // endpoints; that's expected.
    expect(colors[0]?.toUpperCase()).toBe(theme.brandPrimary.toUpperCase());
    expect(colors.at(-1)?.toUpperCase()).toBe(theme.brandAccent.toUpperCase());
    expect(new Set(colors)).toHaveLength(colors.length);
  });
});

describe('packed 5×7 wordmark', () => {
  it('packs the bitmap into four uniform 59-column terminal rows', () => {
    expect(WORDMARK_LINES).toHaveLength(4);
    expect(WORDMARK_LINES.every((line) => line.length === 59)).toBe(true);
    expect(WORDMARK_LINES.join('')).toMatch(/^[▀▄█ ]+$/u);
  });

  it('keeps strongly defined caps, crossbars, and baselines', () => {
    expect(WORDMARK_LINES).toEqual([
      '█   █ █▀▀▀▄ ▄▀▀▀▄ █▄  █ ▄▀▀▀▄ ▄▀▀▀▀ ▀▀█▀▀ ▄▀▀▀▄ ▄▀▀▀▀ █  ▄▀',
      '█ ▄ █ █▄▄▄▀ █   █ █▀▄ █ █ ▄▄▄ ▀▄▄▄    █   █▄▄▄█ █     █▄▀  ',
      '█ █ █ █ ▀▄  █   █ █  ██ █   █     █   █   █   █ █     █ ▀▄ ',
      ' ▀ ▀  ▀   ▀  ▀▀▀  ▀   ▀  ▀▀▀  ▀▀▀▀    ▀   ▀   ▀  ▀▀▀▀ ▀   ▀',
    ]);
  });
});

describe('banner brand mark motion', () => {
  it('rests at the branded offset and only makes a short vertical bounce', () => {
    const cycle = Array.from({ length: 18 }, (_, frame) => brandMarkPinkRow(frame));

    expect(cycle.slice(0, 14)).toEqual(Array(14).fill(1));
    expect(cycle.slice(14, 16)).toEqual([0, 0]);
    expect(cycle.slice(16)).toEqual([1, 1]);
    expect(brandMarkPinkRow(18)).toBe(1);
  });
});

describe('<Banner /> snapshot — full rendered output', () => {
  it('matches the snapshot at 80 columns (full pixel layout)', () => {
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

    // Full-layout snapshot verifies the mark, wordmark, facts, and
    // box-drawing frame are all structurally correct and aligned.
    // If the Banner layout is deliberately changed, update the snapshot
    // with `pnpm test -- --update`.
    expect(frame).toMatchSnapshot();
  });

  it('matches the snapshot at 44 columns (compact brand layout)', () => {
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

    // Compact-layout snapshot verifies the small mark, gradient product name,
    // and single-column facts.
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
