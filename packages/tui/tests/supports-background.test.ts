/**
 * Regression tests: `theme.supportsBackground` and the DiffBlock gate must
 * follow the host terminal's background-painting capability (process.env
 * NO_COLOR / COLORTERM / TERM, plus stdout.isTTY). When NO_COLOR=1 is set,
 * the DiffBlock must take the marker-only fallback path, not the truecolor
 * background wash — both because some terminals silently strip background
 * SGR escapes and because users explicitly opting out of color shouldn't
 * see a phantom pastel highlight.
 */

import { render } from 'ink-testing-library';
import { createElement as e } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { DiffLineRow } from '../src/components/history/code-block.js';

// Stable diff fixture shared with diff-block-render.test.ts — kept inline so
// this file can run in isolation.
const rows: DiffLineRow[] = [
  { kind: 'hunk', text: '@@ -1 +1 @@' },
  { kind: 'del', text: '-old line', oldLine: 1 },
  { kind: 'add', text: '+new line', newLine: 1 },
  { kind: 'ctx', text: ' unchanged', oldLine: 2, newLine: 2 },
];

/**
 * Drive `detectSupportsBackground` directly. The function accepts injected
 * `env` and `isTTY` so we can hit every branch without mutating process
 * state (which would leak between tests and fight the test runner's own
 * environment).
 */
async function detect(
  env: Record<string, string | undefined>,
  isTTY: boolean,
): Promise<boolean> {
  const mod = (await import('../src/theme.js')) as typeof import('../src/theme.js');
  return mod.detectSupportsBackground(env, isTTY);
}

describe('detectSupportsBackground (env + tty gate)', () => {
  it('returns false when stdout is not a TTY — captured/redirected output', async () => {
    // Even with full truecolor signals, a non-TTY must downgrade — this is
    // what keeps captured sessions clean.
    expect(
      await detect(
        { NO_COLOR: undefined, TERM: 'xterm-256color', COLORTERM: 'truecolor' },
        false,
      ),
    ).toBe(false);
  });

  it('returns false when NO_COLOR is set to any non-empty string, even on truecolor terminals', async () => {
    for (const value of ['1', 'true', 'yes', '0']) {
      expect(
        await detect(
          { NO_COLOR: value, TERM: 'xterm-256color', COLORTERM: 'truecolor' },
          true,
        ),
      ).toBe(false);
    }
  });

  it('returns true when COLORTERM=truecolor on a TTY with no NO_COLOR', async () => {
    expect(
      await detect({ NO_COLOR: undefined, TERM: 'xterm', COLORTERM: 'truecolor' }, true),
    ).toBe(true);
  });

  it('returns true when COLORTERM=24bit on a TTY with no NO_COLOR', async () => {
    expect(
      await detect({ NO_COLOR: undefined, TERM: 'xterm', COLORTERM: '24bit' }, true),
    ).toBe(true);
  });

  it('returns true when TERM advertises 256color on a TTY with no NO_COLOR', async () => {
    expect(
      await detect({ NO_COLOR: undefined, TERM: 'screen-256color', COLORTERM: undefined }, true),
    ).toBe(true);
  });

  it('returns true when TERM includes the truecolor substring (case-insensitive)', async () => {
    expect(
      await detect({ NO_COLOR: undefined, TERM: 'xterm-truecolor', COLORTERM: undefined }, true),
    ).toBe(true);
  });
});

/**
 * Integration: under a forced NO_COLOR=1 environment, the live `theme`
 * object's `supportsBackground` must read `false`. The test mutates env
 * for the duration, then re-imports the module so the eager capture inside
 * `theme.ts` sees the new value. The `afterEach` restores env so one test's
 * forced NO_COLOR=1 doesn't leak into the next.
 */
describe('theme.supportsBackground integration', () => {
  const snapshot: Record<string, string | undefined> = {};

  // Capture the env once at file import. Vitest worker has its own process,
  // so capturing in `beforeAll` is safe even though the integration block
  // resets `vi` modules between tests.
  snapshot.NO_COLOR = process.env['NO_COLOR'];
  snapshot.TERM = process.env['TERM'];
  snapshot.COLORTERM = process.env['COLORTERM'];

  afterEach(() => {
    for (const k of ['NO_COLOR', 'TERM', 'COLORTERM']) {
      const v = snapshot[k];
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    vi.resetModules();
  });

  async function reloadTheme(): Promise<{ supportsBackground: boolean }> {
    vi.resetModules();
    const mod = (await import('../src/theme.js')) as typeof import('../src/theme.js');
    return mod.theme;
  }

  it('flips to false when NO_COLOR=1 is set, even on a truecolor TERM', async () => {
    process.env['NO_COLOR'] = '1';
    process.env['TERM'] = 'xterm-256color';
    process.env['COLORTERM'] = 'truecolor';
    const theme = await reloadTheme();
    expect(theme.supportsBackground).toBe(false);
  });

  it('drives the DiffBlock marker-only fallback when NO_COLOR=1', async () => {
    process.env['NO_COLOR'] = '1';
    process.env['TERM'] = 'xterm-256color';
    process.env['COLORTERM'] = 'truecolor';
    const theme = await reloadTheme();
    expect(theme.supportsBackground).toBe(false);

    // Mount DiffBlock exactly as `entry.tsx` does in production: thread the
    // gate through. Asserting the marker-only fallback is reachable under
    // NO_COLOR protects against a future regression that hardcodes useColor
    // back to `true` (the bug this whole change is fixing).
    const { DiffBlock } = (await import(
      '../src/components/history/code-block.js'
    )) as typeof import('../src/components/history/code-block.js');

    const { lastFrame, unmount } = render(
      e(DiffBlock, {
        rows,
        hidden: 0,
        added: 1,
        removed: 1,
        hiddenAdded: 0,
        hiddenRemoved: 0,
        useColor: theme.supportsBackground,
      }),
    );
    try {
      const frame = lastFrame() ?? '';
      // The marker-only branch still emits the +/- glyphs.
      expect(frame).toContain('+');
      expect(frame).toContain('-');
      // The hunk header is unaffected by the gate.
      expect(frame).toContain('@@ -1 +1 @@');
      // The diff body text is still present (no regression in fallback).
      expect(frame).toContain('new line');
      expect(frame).toContain('old line');
      // No "truecolor wash" got applied — there's no background SGR escape
      // (\x1b[48;2;...m or \x1b[48;5;...m) in the rendered frame. We assert
      // via a regex so we catch both 24-bit and 8-bit background forms if
      // the implementation evolves.
      expect(frame).not.toMatch(/\x1b\[48;/);
    } finally {
      unmount();
    }
  });
});
